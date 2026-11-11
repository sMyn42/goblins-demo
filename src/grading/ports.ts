import { Context, Effect } from "effect";
import type { Conflict, StorageError } from "../core/errors";
import type { PublicationDraft, ReviewInput, ManualGradeInput, AnswerSource, ExtractedAnswer, GradeResult, GradingRequest, LeaseLost, OCRRequest, ProviderFailure, Question, Status } from "./contracts";

export class OCRProvider extends Context.Tag("goblins/OCRProvider")<OCRProvider, {
  extract: (request: OCRRequest) => Effect.Effect<ExtractedAnswer, ProviderFailure>;
}>() {}
export class TextGradingProvider extends Context.Tag("goblins/TextGradingProvider")<TextGradingProvider, {
  grade: (request: GradingRequest) => Effect.Effect<GradeResult, ProviderFailure>;
}>() {}
export type Job = { id: string; readCount: number; submissionId: string | null };
export class GradingQueue extends Context.Tag("goblins/GradingQueue")<GradingQueue, {
  ready: Effect.Effect<void, StorageError>;
  enqueue: (submissionId: string) => Effect.Effect<void, StorageError>;
  claim: (leaseSeconds: number, batch: number) => Effect.Effect<Job[], StorageError>;
  acknowledge: (id: string) => Effect.Effect<void, StorageError>;
  defer: (id: string, seconds: number) => Effect.Effect<void, StorageError>;
}>() {}
export type PracticeProblem = { id: string; prompt: string; maxPoints: number; position: number };
export type Practice = { id: string; questionId: string; title: string; prompt: string; maxPoints: number; showDraftGrades: boolean; problems: PracticeProblem[] };
export type OverrideHistory = { id: string; type: "correction" | "manual_grade"; teacherName: string; revision: number; reason: string; previousResult: GradeResult | null; result: GradeResult; createdAt: Date };
export type SubmissionView = {
  id: string; studentId: string; studentName: string; assignmentVersionId: string; questionVersionId: string; status: Status; attempts: number;
  source: AnswerSource; createdAt: Date; updatedAt: Date; failureCode: string | null;
  extractedAnswer: ExtractedAnswer | null; draftGrade: GradeResult | null; finalGrade: GradeResult | null;
  originalGrade: GradeResult | null; overrideHistory: OverrideHistory[]; reviewRevision: number;
};
export type RunInput = { submissionId: string; runId: string; attempt: number; source: AnswerSource; question: Question };
export class SubmissionRepository extends Context.Tag("goblins/SubmissionRepository")<SubmissionRepository, {
  publishPractice: (classId: string, teacherId: string, draft?: PublicationDraft) => Effect.Effect<Practice, StorageError | Conflict>;
  practices: (classId: string) => Effect.Effect<Practice[], StorageError>;
  questionsForClass: (classId: string) => Effect.Effect<Question[], StorageError>;
  practice: (classId: string) => Effect.Effect<Practice | null, StorageError>;
  questionForClass: (classId: string) => Effect.Effect<Question | null, StorageError>;
  submit: (studentId: string, classId: string, questionId: string, source: AnswerSource, idempotencyKey: string) => Effect.Effect<string, StorageError | Conflict>;
  forStudent: (studentId: string) => Effect.Effect<SubmissionView[], StorageError>;
  forClass: (classId: string) => Effect.Effect<SubmissionView[], StorageError>;
  begin: (submissionId: string, runId: string, leaseSeconds: number) => Effect.Effect<RunInput | "busy" | "terminal" | "missing", StorageError>;
  recordOCR: (run: RunInput, answer: ExtractedAnswer) => Effect.Effect<void, StorageError | LeaseLost>;
  complete: (run: RunInput, grade: GradeResult) => Effect.Effect<void, StorageError | LeaseLost>;
  fail: (run: RunInput, code: string, permanent: boolean) => Effect.Effect<void, StorageError | LeaseLost>;
  setDraftVisibility: (assignmentId: string, classId: string, visible: boolean) => Effect.Effect<boolean, StorageError>;
  saveReview: (submissionId: string, classId: string, teacherId: string, input: ReviewInput) => Effect.Effect<number, StorageError | Conflict>;
  manualGrade: (submissionId: string, classId: string, teacherId: string, input: ManualGradeInput) => Effect.Effect<number, StorageError | Conflict>;
  approve: (submissionId: string, classId: string, teacherId: string, revision?: number) => Effect.Effect<boolean, StorageError>;
  retry: (submissionId: string, classId: string) => Effect.Effect<boolean, StorageError>;
}>() {}
