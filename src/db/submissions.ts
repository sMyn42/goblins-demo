import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or, sql, desc } from "drizzle-orm";
import { Effect } from "effect";
import { Conflict, StorageError } from "../core/errors";
import { LeaseLost, publicationProblems } from "../grading/contracts";
import type { GradeResult } from "../grading/contracts";
import { COMPLETE_WORK, PRACTICE_CRITERIA, PRACTICE_PROMPT } from "../grading/fixtures";
import { SubmissionRepository, type Practice, type RunInput, type OverrideHistory } from "../grading/ports";
import { enqueueSQL } from "./queue";
import type { Database } from "./store";
import { assignmentVersions as assignments, assignmentSettings as settings, teacherOverrides as overrides, questionVersions as questions, rubricVersions as rubrics, submissions, gradingRuns as runs, grades, users, classes, productEvents } from "./schema";

const practiceFields = { id: assignments.id, questionId: questions.id, title: assignments.title, prompt: questions.prompt, maxPoints: questions.maxPoints, position: questions.position, showDraftGrades: sql<boolean>`coalesce(${settings.showDraftGrades}, ${assignments.showDraftGrades})` };
const questionFields = { id: questions.id, assignmentVersionId: questions.assignmentVersionId, rubricVersionId: rubrics.id, prompt: questions.prompt, maxPoints: questions.maxPoints, expectedAnswers: questions.expectedAnswers, teacherSolution: questions.teacherSolution, criteria: rubrics.criteria, gradingInstructions: questions.gradingInstructions, position: questions.position };
async function readPractices(db: Pick<Database, "select">, classId: string, publicationKey?: string): Promise<Practice[]> {
  const records = await db.select(practiceFields).from(assignments).innerJoin(questions, eq(questions.assignmentVersionId, assignments.id)).leftJoin(settings, eq(settings.assignmentVersionId, assignments.id))
    .where(publicationKey ? and(eq(assignments.classId, classId), eq(assignments.publicationKey, publicationKey)) : eq(assignments.classId, classId)).orderBy(desc(assignments.publishedAt), desc(assignments.id), questions.position);
  const grouped = new Map<string, Practice>();
  for (const row of records) {
    const assignment = grouped.get(row.id) ?? { id: row.id, title: row.title, questionId: row.questionId, prompt: row.prompt, maxPoints: 0, showDraftGrades: row.showDraftGrades, problems: [] };
    assignment.maxPoints += row.maxPoints;
    assignment.problems.push({ id: row.questionId, prompt: row.prompt, maxPoints: row.maxPoints, position: row.position });
    grouped.set(row.id, assignment);
  }
  return [...grouped.values()];
}
const baseView = {
  id: submissions.id, studentId: submissions.studentId, studentName: users.displayName,
  assignmentVersionId: submissions.assignmentVersionId, questionVersionId: submissions.questionVersionId, status: submissions.status, attempts: submissions.attempts,
  source: submissions.source, createdAt: submissions.createdAt, updatedAt: submissions.updatedAt, failureCode: submissions.failureCode,
};
const query = <A>(operation: string, run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new StorageError({ operation }) });
const fenced = <A>(operation: string, run: () => Promise<A>) => Effect.tryPromise({
  try: run, catch: (error) => error instanceof LeaseLost ? error : new StorageError({ operation }),
});
const hasLease = (run: RunInput) => and(eq(submissions.id, run.submissionId), eq(submissions.activeRunId, run.runId), gt(submissions.leaseExpiresAt, sql`clock_timestamp()`));

export const makeSubmissionRepository = (db: Database): typeof SubmissionRepository.Service => ({
  publishPractice: (classId, teacherId, draft) => Effect.tryPromise({ try: () => db.transaction(async (tx) => {
    const [owner] = await tx.select().from(classes).where(and(eq(classes.id, classId), eq(classes.teacherId, teacherId)));
    if (!owner) throw new Error("Class ownership required");
    const publicationKey = draft?.publicationKey ?? randomUUID();
    const problems = draft ? publicationProblems(draft) : [{ prompt: PRACTICE_PROMPT, maxPoints: 10, expectedAnswers: ["x = 4", "4"], teacherSolution: COMPLETE_WORK, criteria: PRACTICE_CRITERIA, approved: true as const }];
    const contract = { title: draft?.title ?? "Algebra practice", showDraftGrades: draft?.showDraftGrades ?? false, problems: problems.map((problem) => ({ prompt: problem.prompt, maxPoints: problem.maxPoints, expectedAnswers: problem.expectedAnswers, teacherSolution: problem.teacherSolution, gradingInstructions: "gradingInstructions" in problem ? problem.gradingInstructions ?? "" : "", criteria: problem.criteria })) };
    const fingerprint = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
    const [assignment] = await tx.insert(assignments).values({ classId, publicationKey, publicationFingerprint: fingerprint, title: contract.title, showDraftGrades: contract.showDraftGrades }).onConflictDoNothing({ target: [assignments.classId, assignments.publicationKey] }).returning();
    if (!assignment) {
      const [existing] = await tx.select().from(assignments).where(and(eq(assignments.classId, classId), eq(assignments.publicationKey, publicationKey)));
      if (!existing || existing.publicationFingerprint !== fingerprint) throw new Conflict({ message: "This publication request was already used with different content. Reload before publishing again." });
    }
    if (assignment) {
      for (const [position, problem] of contract.problems.entries()) {
        const [question] = await tx.insert(questions).values({ assignmentVersionId: assignment.id, position, prompt: problem.prompt, maxPoints: problem.maxPoints, expectedAnswers: problem.expectedAnswers, teacherSolution: problem.teacherSolution, gradingInstructions: problem.gradingInstructions }).returning();
        await tx.insert(rubrics).values({ questionVersionId: question.id, criteria: problem.criteria, approvedBy: teacherId });
      }
      await tx.insert(settings).values({ assignmentVersionId: assignment.id, showDraftGrades: contract.showDraftGrades });
      await tx.insert(productEvents).values({ name: "assignment_publication", actorId: teacherId });
    }
    return (await readPractices(tx, classId, publicationKey))[0];
  }), catch: (error) => error instanceof Conflict ? error : new StorageError({ operation: "practice.publish" }) }),
  practices: (classId) => query("practice.list", () => readPractices(db, classId)),
  questionsForClass: (classId) => query("practice.contracts", () => db.select(questionFields).from(questions).innerJoin(assignments, eq(assignments.id, questions.assignmentVersionId)).innerJoin(rubrics, eq(rubrics.questionVersionId, questions.id)).where(eq(assignments.classId, classId)).orderBy(questions.position)),
  practice: (classId) => query("practice.lookup", async () => (await readPractices(db, classId))[0] ?? null),
  questionForClass: (classId) => query("practice.contract", async () => (await db.select(questionFields).from(questions).innerJoin(assignments, eq(assignments.id, questions.assignmentVersionId)).innerJoin(rubrics, eq(rubrics.questionVersionId, questions.id)).where(eq(assignments.classId, classId)).orderBy(desc(assignments.publishedAt), desc(assignments.id), questions.position).limit(1))[0] ?? null),
  submit: (studentId, classId, questionId, source, idempotencyKey) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
      const [question] = await tx.select({ assignmentId: assignments.id }).from(questions)
        .innerJoin(assignments, eq(questions.assignmentVersionId, assignments.id)).innerJoin(rubrics, eq(rubrics.questionVersionId, questions.id))
        .where(and(eq(questions.id, questionId), eq(assignments.classId, classId)));
      if (!question) throw new Conflict({ message: "This problem is not available in your class." });
      const content = source.type === "image" && source.sha256 ? { type: source.type, sha256: source.sha256 } : source;
      const fingerprint = createHash("sha256").update(JSON.stringify({ questionId, source: content })).digest("hex");
      const [created] = await tx.insert(submissions).values({ studentId, classId, assignmentVersionId: question.assignmentId, questionVersionId: questionId, source, idempotencyKey, fingerprint }).onConflictDoNothing().returning({ id: submissions.id });
      if (!created) {
        const [byKey] = await tx.select().from(submissions).where(and(eq(submissions.studentId, studentId), eq(submissions.idempotencyKey, idempotencyKey)));
        const existing = byKey ?? (await tx.select().from(submissions).where(and(eq(submissions.studentId, studentId), eq(submissions.questionVersionId, questionId))))[0];
        if (!existing || existing.fingerprint !== fingerprint || existing.questionVersionId !== questionId) throw new Conflict({ message: "Only one attempt is allowed. Your previous answer is already saved." });
        return existing.id;
      }
      // Same DB transaction: queue/database outage rolls back the accepted answer.
      await tx.execute(enqueueSQL(created.id));
      await tx.insert(productEvents).values({ name: "student_submission", actorId: studentId });
      return created.id;
    }),
    catch: (error) => error instanceof Conflict ? error : new StorageError({ operation: "submission.persist_and_enqueue" }),
  }),
  // Redact at the repository boundary, not merely by hiding scores in React.
  forStudent: (studentId) => query("submission.student_list", async () => (await db.select({ ...baseView, result: grades.result, reviewed: grades.reviewedResult, approvedAt: grades.approvedAt, visible: sql<boolean>`coalesce(${settings.showDraftGrades}, ${assignments.showDraftGrades})` }).from(submissions)
    .innerJoin(users, eq(users.id, submissions.studentId)).innerJoin(assignments, eq(assignments.id, submissions.assignmentVersionId)).leftJoin(settings, eq(settings.assignmentVersionId, assignments.id)).leftJoin(grades, eq(grades.submissionId, submissions.id))
    .where(eq(submissions.studentId, studentId)).orderBy(desc(submissions.createdAt))).map(({ result, reviewed, approvedAt, visible, ...row }) => ({
      ...row, extractedAnswer: null, originalGrade: null, overrideHistory: [], reviewRevision: 0,
      draftGrade: row.status === "waiting_for_teacher" && visible ? reviewed ?? result : null,
      finalGrade: row.status === "finalized" && approvedAt ? reviewed ?? result : null,
    }))),
  forClass: (classId) => query("submission.class_list", async () => {
    const records = await db.select({ ...baseView, extractedAnswer: runs.extractedAnswer, result: grades.result, reviewed: grades.reviewedResult, reviewRevision: grades.reviewRevision, approvedAt: grades.approvedAt }).from(submissions)
      .innerJoin(users, eq(users.id, submissions.studentId)).leftJoin(runs, eq(runs.id, submissions.latestRunId)).leftJoin(grades, eq(grades.submissionId, submissions.id)).where(eq(submissions.classId, classId)).orderBy(desc(submissions.createdAt));
    const history = await db.select({ id: overrides.id, submissionId: overrides.submissionId, teacherName: users.displayName, revision: overrides.revision, reason: overrides.reason, previousResult: overrides.previousResult, result: overrides.result, createdAt: overrides.createdAt }).from(overrides).innerJoin(submissions, eq(submissions.id, overrides.submissionId)).innerJoin(users, eq(users.id, overrides.teacherId)).where(eq(submissions.classId, classId)).orderBy(overrides.revision);
    return records.map(({ result, reviewed, approvedAt, ...row }) => ({ ...row, reviewRevision: row.reviewRevision ?? 0, originalGrade: result, overrideHistory: history.filter((entry) => entry.submissionId === row.id) as OverrideHistory[], draftGrade: reviewed ?? result, finalGrade: row.status === "finalized" && approvedAt ? reviewed ?? result : null }));
  }),
  begin: (submissionId, runId, leaseSeconds) => query("grading.begin", () => db.transaction(async (tx) => {
    const [claimed] = await tx.update(submissions).set({ status: "processing", activeRunId: runId, latestRunId: runId,
      leaseExpiresAt: sql`clock_timestamp() + ${leaseSeconds} * interval '1 second'`, attempts: sql`${submissions.attempts} + 1`, updatedAt: sql`now()`, failureCode: null,
    }).where(and(eq(submissions.id, submissionId), or(
      inArray(submissions.status, ["submitted", "retryable_failure"]),
      and(inArray(submissions.status, ["processing", "auto_grading"]), or(isNull(submissions.leaseExpiresAt), lte(submissions.leaseExpiresAt, sql`clock_timestamp()`))),
    ))).returning();
    if (!claimed) {
      const [existing] = await tx.select({ status: submissions.status }).from(submissions).where(eq(submissions.id, submissionId));
      if (!existing) return "missing" as const;
      return ["waiting_for_teacher", "finalized", "permanent_failure"].includes(existing.status) ? "terminal" as const : "busy" as const;
    }
    await tx.update(runs).set({ state: "abandoned", completedAt: sql`now()` }).where(and(eq(runs.submissionId, submissionId), inArray(runs.state, ["processing", "auto_grading"])));
    await tx.insert(runs).values({ id: runId, submissionId, state: "processing" });
    const [question] = await tx.select(questionFields)
      .from(questions).innerJoin(rubrics, eq(rubrics.questionVersionId, questions.id)).where(eq(questions.id, claimed.questionVersionId));
    if (!question) throw new Error("Versioned grading contract missing");
    return { submissionId, runId, attempt: claimed.attempts, source: claimed.source, question };
  })),
  recordOCR: (run, answer) => fenced("grading.ocr", async () => {
    await db.transaction(async (tx) => {
      const [updated] = await tx.update(submissions).set({ status: "auto_grading", updatedAt: sql`now()` }).where(and(hasLease(run), eq(submissions.status, "processing"))).returning({ id: submissions.id });
      if (!updated) throw new LeaseLost();
      await tx.update(runs).set({ state: "auto_grading", extractedAnswer: answer }).where(eq(runs.id, run.runId));
    });
  }),
  complete: (run, grade) => fenced("grading.complete", async () => {
    await db.transaction(async (tx) => {
      const [updated] = await tx.update(submissions).set({ status: "waiting_for_teacher", activeRunId: null, leaseExpiresAt: null, updatedAt: sql`now()` }).where(and(hasLease(run), eq(submissions.status, "auto_grading"))).returning({ id: submissions.id });
      if (!updated) throw new LeaseLost();
      await tx.insert(grades).values({ submissionId: run.submissionId, runId: run.runId, rubricVersionId: run.question.rubricVersionId, result: grade });
      await tx.update(runs).set({ state: "completed", completedAt: sql`now()` }).where(eq(runs.id, run.runId));
      await tx.insert(productEvents).values({ name: "grading_completion" });
    });
  }),
  fail: (run, code, permanent) => fenced("grading.fail", async () => {
    await db.transaction(async (tx) => {
      const [updated] = await tx.update(submissions).set({ status: permanent ? "permanent_failure" : "retryable_failure", failureCode: code, activeRunId: null, leaseExpiresAt: null, updatedAt: sql`now()` })
        .where(and(hasLease(run), inArray(submissions.status, ["processing", "auto_grading"]))).returning({ id: submissions.id });
      if (!updated) throw new LeaseLost();
      await tx.update(runs).set({ state: "failed", failureCode: code, completedAt: sql`now()` }).where(eq(runs.id, run.runId));
    });
  }),
  setDraftVisibility: (assignmentId, classId, visible) => query("assignment.visibility", () => db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.id, assignmentId), eq(assignments.classId, classId)));
    if (!owned) return false;
    await tx.insert(settings).values({ assignmentVersionId: assignmentId, showDraftGrades: visible }).onConflictDoUpdate({ target: settings.assignmentVersionId, set: { showDraftGrades: visible } });
    return true;
  })),
  saveReview: (submissionId, classId, teacherId, input) => Effect.tryPromise({ try: () => db.transaction(async (tx) => {
    const [current] = await tx.select({ result: grades.result, reviewed: grades.reviewedResult, revision: grades.reviewRevision, criteria: rubrics.criteria, maxPoints: questions.maxPoints }).from(grades).innerJoin(submissions, eq(submissions.id, grades.submissionId)).innerJoin(classes, eq(classes.id, submissions.classId)).innerJoin(questions, eq(questions.id, submissions.questionVersionId)).innerJoin(rubrics, eq(rubrics.id, grades.rubricVersionId))
      .where(and(eq(submissions.id, submissionId), eq(submissions.classId, classId), eq(classes.teacherId, teacherId), eq(submissions.status, "waiting_for_teacher"), isNull(grades.approvedAt)));
    if (!current || current.revision !== input.revision) throw new Conflict({ message: "This grade changed or is no longer awaiting approval. Reload the review before saving." });
    const ids = new Set(input.scores.map((score) => score.criterionId));
    if (ids.size !== current.criteria.length || input.scores.length !== current.criteria.length || !input.scores.every((score) => Number.isFinite(score.score) && score.score >= 0 && current.criteria.some((criterion) => criterion.id === score.criterionId && score.score <= criterion.maxPoints))) throw new Conflict({ message: "Each rubric criterion needs one score within its point limit." });
    const previous = current.reviewed ?? current.result;
    const result: GradeResult = { ...previous, feedback: input.feedback, totalScore: input.scores.reduce((sum, score) => sum + score.score, 0), criterionResults: previous.criterionResults.map((criterion) => ({ ...criterion, score: input.scores.find((score) => score.criterionId === criterion.criterionId)!.score })) };
    if (result.totalScore > current.maxPoints) throw new Conflict({ message: "The total score exceeds the problem maximum." });
    const revision = current.revision + 1;
    const [saved] = await tx.update(grades).set({ reviewedResult: result, reviewRevision: revision }).where(and(eq(grades.submissionId, submissionId), eq(grades.reviewRevision, input.revision), isNull(grades.approvedAt))).returning({ id: grades.submissionId });
    if (!saved) throw new Conflict({ message: "This grade changed. Reload the review before saving." });
    await tx.insert(overrides).values({ submissionId, teacherId, revision, reason: input.reason, previousResult: previous, result });
    await tx.update(submissions).set({ updatedAt: sql`now()` }).where(eq(submissions.id, submissionId));
    await tx.insert(productEvents).values({ name: "teacher_override", actorId: teacherId });
    return revision;
  }), catch: (error) => error instanceof Conflict ? error : new StorageError({ operation: "grading.review" }) }),
  approve: (submissionId, classId, teacherId, revision) => query("grading.approve", () => db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: submissions.id }).from(submissions).innerJoin(classes, eq(classes.id, submissions.classId))
      .where(and(eq(submissions.id, submissionId), eq(submissions.classId, classId), eq(classes.teacherId, teacherId), eq(submissions.status, "waiting_for_teacher")));
    if (!owned) return false;
    const [grade] = await tx.update(grades).set({ approvedBy: teacherId, approvedAt: sql`now()` }).where(and(eq(grades.submissionId, submissionId), isNull(grades.approvedAt), revision === undefined ? undefined : eq(grades.reviewRevision, revision))).returning({ id: grades.submissionId });
    if (!grade) return false;
    await tx.update(submissions).set({ status: "finalized", updatedAt: sql`now()` }).where(eq(submissions.id, submissionId));
    await tx.insert(productEvents).values({ name: "feedback_released", actorId: teacherId });
    return true;
  })),
  retry: (submissionId, classId) => query("grading.manual_retry", () => db.transaction(async (tx) => {
    const [updated] = await tx.update(submissions).set({ status: "retryable_failure", attempts: 0, failureCode: null, updatedAt: sql`now()` })
      .where(and(eq(submissions.id, submissionId), eq(submissions.classId, classId), eq(submissions.status, "permanent_failure"))).returning({ id: submissions.id });
    if (!updated) return false;
    await tx.execute(enqueueSQL(updated.id));
    return true;
  })),
});
