import { createHash, randomUUID } from "node:crypto";
import { Clock, Effect, Schema } from "effect";
import { authenticate } from "../core/auth";
import { decode } from "../core/contracts";
import { Conflict, Forbidden, InvalidInput } from "../core/errors";
import { Store } from "../core/ports";
import { SubmissionRepository } from "./ports";
import { PublicationDraft, publicationProblems, ReviewInput, ManualGradeInput } from "./contracts";
import { gradingConfig } from "./config";
import { PrivateStorage, validateImage } from "../storage/service";

export const publishPractice = (token: string | undefined, input?: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "teacher") return yield* new Forbidden();
  const classroom = yield* (yield* Store).classByTeacher(user.id);
  if (!classroom) return yield* new InvalidInput({ message: "Create a class first." });
  const draft = input === undefined ? undefined : yield* decode(PublicationDraft, input);
  if (draft && (!draft.title.trim() || publicationProblems(draft).some((problem) => !problem.prompt.trim() || !problem.teacherSolution.trim() || problem.expectedAnswers.some((answer) => !answer.trim())
    || new Set(problem.criteria.map((c) => c.id)).size !== problem.criteria.length
    || problem.criteria.some((c) => !c.id.trim() || !c.description.trim() || !c.fullCredit.trim() || (c.method !== "ai" && (!c.evaluator || c.evaluator.answers.length === 0 || c.evaluator.answers.some((answer) => !answer.trim()))))
    || Math.abs(problem.criteria.reduce((sum, c) => sum + c.maxPoints, 0) - problem.maxPoints) > 0.000001))) {
    return yield* new InvalidInput({ message: "Approve a complete rubric with unique criterion IDs and points totaling the problem maximum. Deterministic/hybrid criteria need accepted answers." });
  }
  return yield* (yield* SubmissionRepository).publishPractice(classroom.id, user.id, draft);
});
const TypedSubmission = Schema.Struct({ questionId: Schema.UUID, idempotencyKey: Schema.UUID, text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(10000)) });
export const submitAnswer = (token: string | undefined, input: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "student") return yield* new Forbidden();
  const data = yield* decode(TypedSubmission, input);
  if (!data.text.trim()) return yield* new InvalidInput({ message: "Enter your answer." });
  const store = yield* Store;
  const classroom = yield* store.classByStudent(user.id);
  if (!classroom) return yield* new Forbidden();
  const allowed = yield* store.takeRateLimit(`submit:${user.id}`, 20, 60_000, new Date(yield* Clock.currentTimeMillis));
  if (!allowed) return yield* new InvalidInput({ message: "Too many submissions. Try again in a minute." });
  return yield* (yield* SubmissionRepository).submit(user.id, classroom.id, data.questionId, { type: "typed", text: data.text }, data.idempotencyKey);
});
export const submitImage = (token: string | undefined, input: unknown, bytes: Uint8Array) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "student") return yield* new Forbidden();
  const data = yield* decode(Schema.Struct({ questionId: Schema.UUID, idempotencyKey: Schema.UUID }), input);
  const store = yield* Store;
  const classroom = yield* store.classByStudent(user.id);
  if (!classroom) return yield* new Forbidden();
  const repo = yield* SubmissionRepository;
  const assignments = yield* repo.practices(classroom.id);
  if (!assignments.some((assignment) => assignment.problems.some((problem) => problem.id === data.questionId))) return yield* new Forbidden();
  const allowed = yield* store.takeRateLimit(`submit:${user.id}`, 20, 60_000, new Date(yield* Clock.currentTimeMillis));
  if (!allowed) return yield* new InvalidInput({ message: "Too many submissions. Try again in a minute." });
  yield* validateImage(bytes);
  const objectKey = `students/${user.id}/${randomUUID()}.png`;
  const storage = yield* PrivateStorage;
  yield* storage.put(objectKey, bytes);
  // Store first, then atomically persist/enqueue. Never delete an object on an
  // ambiguous commit/network failure: a committed submission may reference it.
  return yield* repo.submit(user.id, classroom.id, data.questionId, { type: "image", objectKey, sha256: createHash("sha256").update(bytes).digest("hex") }, data.idempotencyKey);
});
export const submissionImage = (token: string | undefined, id: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  const submissionId = yield* decode(Schema.UUID, id);
  const repo = yield* SubmissionRepository;
  const store = yield* Store;
  const classroom = user.role === "teacher" ? yield* store.classByTeacher(user.id) : yield* store.classByStudent(user.id);
  if (!classroom) return yield* new Forbidden();
  const list = user.role === "teacher" ? yield* repo.forClass(classroom.id) : yield* repo.forStudent(user.id);
  const submission = list.find((item) => item.id === submissionId);
  if (submission?.source.type !== "image") return yield* new Forbidden();
  return yield* (yield* PrivateStorage).get(submission.source.objectKey);
});
export const approveSubmission = (token: string | undefined, id: unknown, revision?: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "teacher") return yield* new Forbidden();
  const submissionId = yield* decode(Schema.UUID, id);
  const classroom = yield* (yield* Store).classByTeacher(user.id);
  if (!classroom) return yield* new Forbidden();
  const expected = revision === undefined ? undefined : yield* decode(Schema.Number.pipe(Schema.int(), Schema.nonNegative()), revision);
  if (! (yield* (yield* SubmissionRepository).approve(submissionId, classroom.id, user.id, expected))) return yield* new Conflict({ message: "Only a completed, unchanged, unapproved grade in your class can be released. Reload the review if it changed." });
});
export const saveReview = (token: string | undefined, id: unknown, input: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "teacher") return yield* new Forbidden();
  const submissionId = yield* decode(Schema.UUID, id);
  const data = yield* decode(ReviewInput, input);
  if (!data.reason.trim() || !data.feedback.trim()) return yield* new InvalidInput({ message: "Enter feedback and a reason for the correction." });
  const classroom = yield* (yield* Store).classByTeacher(user.id);
  if (!classroom) return yield* new Forbidden();
  return yield* (yield* SubmissionRepository).saveReview(submissionId, classroom.id, user.id, data);
});
export const manuallyGradeSubmission = (token: string | undefined, id: unknown, input: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "teacher") return yield* new Forbidden();
  const submissionId = yield* decode(Schema.UUID, id);
  const data = yield* decode(ManualGradeInput, input);
  if (!data.reason.trim() || !data.feedback.trim()) return yield* new InvalidInput({ message: "Enter feedback and a reason for the manual grade." });
  const classroom = yield* (yield* Store).classByTeacher(user.id);
  if (!classroom) return yield* new Forbidden();
  return yield* (yield* SubmissionRepository).manualGrade(submissionId, classroom.id, user.id, data);
});
export const setDraftVisibility = (token: string | undefined, id: unknown, input: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "teacher") return yield* new Forbidden();
  const assignmentId = yield* decode(Schema.UUID, id);
  const data = yield* decode(Schema.Struct({ showDraftGrades: Schema.Boolean }), input);
  const classroom = yield* (yield* Store).classByTeacher(user.id);
  if (!classroom || !(yield* (yield* SubmissionRepository).setDraftVisibility(assignmentId, classroom.id, data.showDraftGrades))) return yield* new Forbidden();
});
export const practiceOverview = (token: string | undefined) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  const store = yield* Store;
  const classroom = user.role === "teacher" ? yield* store.classByTeacher(user.id) : yield* store.classByStudent(user.id);
  if (!classroom) return { assignments: [], gradingContracts: [], practice: null, gradingContract: null, submissions: [], roster: [], role: user.role };
  const repo = yield* SubmissionRepository;
  const assignments = yield* repo.practices(classroom.id);
  const practice = assignments[0] ?? null;
  const submissions = user.role === "teacher" ? yield* repo.forClass(classroom.id) : yield* repo.forStudent(user.id);
  const roster = user.role === "teacher" ? yield* store.roster(classroom.id) : [];
  const gradingContracts = user.role === "teacher" ? yield* repo.questionsForClass(classroom.id) : [];
  const gradingContract = gradingContracts.find((contract) => contract.assignmentVersionId === practice?.id) ?? null;
  // Keep the singular fields for existing API consumers; the dashboard uses the lists.
  const inference = yield* gradingConfig.pipe(Effect.mapError(() => new InvalidInput({ message: "Invalid inference configuration." })));
  return { assignments, gradingContracts, practice, gradingContract, submissions, roster, role: user.role, inference: { ocr: inference.ocrProvider, grading: inference.gradingProvider } };
});
export const retrySubmission = (token: string | undefined, id: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "teacher") return yield* new Forbidden();
  const submissionId = yield* decode(Schema.UUID, id);
  const classroom = yield* (yield* Store).classByTeacher(user.id);
  if (!classroom) return yield* new Forbidden();
  const changed = yield* (yield* SubmissionRepository).retry(submissionId, classroom.id);
  if (!changed) return yield* new InvalidInput({ message: "Only a failed submission in your class can be retried." });
});
