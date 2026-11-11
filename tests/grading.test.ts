import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect";
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { register } from "../src/core/auth";
import { createClass } from "../src/core/classrooms";
import { Store } from "../src/core/ports";
import { makeStore } from "../src/db/store";
import { makeQueue } from "../src/db/queue";
import { setupQueue } from "../src/db/setup-queue";
import { makeSubmissionRepository } from "../src/db/submissions";
import { PasswordsLive } from "../src/server/passwords";
import { PrivateStorage, makeLocalStorage } from "../src/storage/service";
import { GradingConfig, gradingConfig, type GradingSettings } from "../src/grading/config";
import { GradingQueue, SubmissionRepository } from "../src/grading/ports";
import { MockProvidersLive } from "../src/grading/mock-providers";
import { COMPLETE_WORK, PRACTICE_CRITERIA, PRACTICE_PROMPT } from "../src/grading/fixtures";
import type { AssignmentDraft } from "../src/grading/contracts";
import { approveSubmission, practiceOverview, publishPractice, submitAnswer, submitImage, submissionImage, retrySubmission, saveReview, setDraftVisibility } from "../src/grading/application";
import { runBatch, processJob } from "../src/grading/worker";
import { makeWorkerHealth } from "../src/worker/health";
import { makeHeartbeatStore } from "../src/worker/heartbeat-store";
import * as schema from "../src/db/schema";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const queue = makeQueue(db), repo = makeSubmissionRepository(db);
const defaults = Effect.runSync(gradingConfig.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["APP_MODE", "test"], ["OCR_PROVIDER", "mock"], ["GRADING_PROVIDER", "mock"]])))));
let root: string;
const createRuntime = (changes: Partial<GradingSettings> = {}) => {
  const config = Layer.succeed(GradingConfig, { ...defaults, mockLatencyMs: 0, ...changes });
  return ManagedRuntime.make(Layer.mergeAll(Layer.succeed(Store, makeStore(db)), Layer.succeed(SubmissionRepository, repo), Layer.succeed(GradingQueue, queue), PasswordsLive,
    Layer.succeed(PrivateStorage, makeLocalStorage(root)), config, MockProvidersLive.pipe(Layer.provide(config))));
};
let runtime: ReturnType<typeof createRuntime>;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "goblins-test-")); await migrate(db, { migrationsFolder: "drizzle" }); await pg.exec(await readFile("vendor/pgmq/pgmq--1.13.1.sql", "utf8")); await setupQueue(db, "existing"); });
beforeEach(async () => { await db.execute(sql`TRUNCATE users, rate_limits, worker_heartbeats CASCADE`); await db.execute(sql`TRUNCATE pgmq.q_grading_jobs, pgmq.a_grading_jobs`); runtime = createRuntime(); });
afterEach(async () => { await runtime.dispose(); });
afterAll(async () => { await pg.close(); await rm(root, { recursive: true, force: true }); });
async function classroom(name = "teacher", draft?: AssignmentDraft) {
  const teacher = await runtime.runPromise(register({ username: name, displayName: name, role: "teacher", passphrase: "safe classroom words" }));
  const classroom = await runtime.runPromise(createClass(teacher.token, { name: "Algebra" }));
  const practice = await runtime.runPromise(publishPractice(teacher.token, draft));
  const student = await runtime.runPromise(register({ username: `${name}_student`, displayName: "Student", role: "student", passphrase: "safe student words", joinCode: classroom.joinCode }));
  return { teacher, student, classroom, practice };
}
const draft: AssignmentDraft = { title: "Algebra", prompt: PRACTICE_PROMPT, expectedAnswers: ["4"], teacherSolution: COMPLETE_WORK, maxPoints: 10, criteria: PRACTICE_CRITERIA, approved: true, showDraftGrades: false };
const answer = (questionId: string, text = COMPLETE_WORK) => ({ questionId, text, idempotencyKey: randomUUID() });

describe("durable mock pipeline (real pgmq SQL and PostgreSQL transactions)", () => {
  it("persists/enqueues, OCRs, grades, hides draft, then explicitly approves/releases", async () => {
    const { teacher, student, practice } = await classroom();
    const id = await runtime.runPromise(submitAnswer(student.token, answer(practice.questionId)));
    expect((await db.select().from(schema.submissions))[0].status).toBe("submitted");
    expect(await runtime.runPromise(runBatch)).toBe(1);
    const teacherView = await runtime.runPromise(practiceOverview(teacher.token));
    expect(teacherView.submissions[0]).toMatchObject({ id, status: "waiting_for_teacher", draftGrade: { totalScore: 10 }, finalGrade: null });
    expect(teacherView.submissions[0].extractedAnswer?.lines.map((line) => line.text).join("\n")).toBe(COMPLETE_WORK);
    expect((await runtime.runPromise(practiceOverview(student.token))).submissions[0]).toMatchObject({ draftGrade: null, finalGrade: null, extractedAnswer: null });
    await runtime.runPromise(approveSubmission(teacher.token, id));
    expect((await runtime.runPromise(practiceOverview(student.token))).submissions[0]).toMatchObject({ status: "finalized", finalGrade: { totalScore: 10 } });
    expect(await db.select().from(schema.grades)).toHaveLength(1);
  });
  it("exposes a labeled draft only when enabled and never exposes the teacher contract/roster to students", async () => {
    const a = await classroom("teacher", { ...draft, showDraftGrades: true });
    await runtime.runPromise(submitAnswer(a.student.token, answer(a.practice.questionId)));
    await runtime.runPromise(runBatch);
    const view = await runtime.runPromise(practiceOverview(a.student.token));
    expect(view).toMatchObject({ roster: [], gradingContract: null, submissions: [{ status: "waiting_for_teacher", draftGrade: { totalScore: 10 }, finalGrade: null }] });
    expect((await runtime.runPromise(practiceOverview(a.teacher.token))).gradingContract?.criteria).toHaveLength(2);
  });
  it("publishes multiple assignments idempotently and keeps answers/grades bound to each version", async () => {
    const a = await classroom();
    const publication = { ...draft, title: "Second assignment", publicationKey: randomUUID(), showDraftGrades: true };
    const [second, replay] = await Promise.all([1, 2].map(() => runtime.runPromise(publishPractice(a.teacher.token, publication))));
    expect(second.id).toBe(replay.id);
    expect(second.id).not.toBe(a.practice.id);
    expect(await db.select().from(schema.assignmentVersions)).toHaveLength(2);
    expect(await runtime.runPromise(publishPractice(a.teacher.token, { ...publication, title: "Changed replay" }).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    const png = new PNG({ width: 10, height: 10 }); png.data.fill(255);
    const firstId = await runtime.runPromise(submitImage(a.student.token, { questionId: a.practice.questionId, idempotencyKey: randomUUID() }, PNG.sync.write(png)));
    const secondId = await runtime.runPromise(submitAnswer(a.student.token, answer(second.questionId, "x = 5")));
    await runtime.runPromise(runBatch);
    await runtime.runPromise(approveSubmission(a.teacher.token, firstId));
    const view = await runtime.runPromise(practiceOverview(a.student.token));
    expect(view.assignments).toHaveLength(2); expect(view.gradingContracts).toEqual([]); expect(view.roster).toEqual([]);
    expect(view.submissions.find((item) => item.id === firstId)).toMatchObject({ assignmentVersionId: a.practice.id, status: "finalized", finalGrade: { totalScore: 10 } });
    expect(view.submissions.find((item) => item.id === secondId)).toMatchObject({ assignmentVersionId: second.id, status: "waiting_for_teacher", draftGrade: { totalScore: 0 }, finalGrade: null });
    expect((await runtime.runPromise(practiceOverview(a.teacher.token))).gradingContracts).toHaveLength(2);
  });
  it("publishes ordered multi-problem assignments with independent submissions and no premature final total", async () => {
    const a = await classroom();
    const problem = { prompt: PRACTICE_PROMPT, expectedAnswers: ["x = 4", "4"], teacherSolution: COMPLETE_WORK, maxPoints: 10, criteria: PRACTICE_CRITERIA, approved: true };
    const publication = { title: "Two problems", publicationKey: randomUUID(), showDraftGrades: false, problems: [problem, { ...problem, gradingInstructions: "Accept valid work." }] };
    const multi = await runtime.runPromise(publishPractice(a.teacher.token, publication));
    expect(multi.problems).toHaveLength(2); expect(multi.maxPoints).toBe(20);
    expect(multi.problems.map((entry) => entry.position)).toEqual([0, 1]);
    expect(await runtime.runPromise(publishPractice(a.teacher.token, publication))).toEqual(multi);
    for (const invalid of [{ ...publication, publicationKey: randomUUID(), problems: [problem, { ...problem, approved: false }] }, { ...publication, publicationKey: randomUUID(), problems: [problem, { ...problem, maxPoints: 11 }] }]) expect(await runtime.runPromise(publishPractice(a.teacher.token, invalid).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "InvalidInput" } });
    const first = await runtime.runPromise(submitAnswer(a.student.token, answer(multi.problems[0].id)));
    const second = await runtime.runPromise(submitAnswer(a.student.token, answer(multi.problems[1].id, "x = 5")));
    await runtime.runPromise(runBatch);
    await runtime.runPromise(approveSubmission(a.teacher.token, first, 0));
    let view = await runtime.runPromise(practiceOverview(a.student.token));
    expect(view.submissions.find((entry) => entry.id === first)?.finalGrade?.totalScore).toBe(10);
    expect(view.submissions.find((entry) => entry.id === second)?.finalGrade).toBeNull();
    expect(view.submissions.find((entry) => entry.id === second)?.draftGrade).toBeNull();
    await runtime.runPromise(setDraftVisibility(a.teacher.token, multi.id, { showDraftGrades: true }));
    view = await runtime.runPromise(practiceOverview(a.student.token));
    expect(view.submissions.find((entry) => entry.id === second)?.draftGrade?.totalScore).toBe(0);
    await runtime.runPromise(setDraftVisibility(a.teacher.token, multi.id, { showDraftGrades: false }));
    expect((await runtime.runPromise(practiceOverview(a.student.token))).submissions.find((entry) => entry.id === second)?.draftGrade).toBeNull();
    await runtime.runPromise(approveSubmission(a.teacher.token, second, 0));
    const final = await runtime.runPromise(practiceOverview(a.student.token));
    expect(final.submissions.filter((entry) => entry.assignmentVersionId === multi.id).every((entry) => entry.status === "finalized")).toBe(true);
  });
  it("preserves the original AI result, audits corrections and releases only the reviewed revision", async () => {
    const a = await classroom();
    const id = await runtime.runPromise(submitAnswer(a.student.token, answer(a.practice.questionId)));
    await runtime.runPromise(runBatch);
    const input = { revision: 0, scores: [{ criterionId: "final-answer", score: 4 }, { criterionId: "working", score: 5 }], feedback: "Teacher corrected feedback", reason: "One required notation step needs clarification." };
    expect(await runtime.runPromise(saveReview(a.teacher.token, id, input))).toBe(1);
    const teacherView = (await runtime.runPromise(practiceOverview(a.teacher.token))).submissions[0];
    expect(teacherView.originalGrade?.totalScore).toBe(10); expect(teacherView.draftGrade?.totalScore).toBe(9);
    expect(teacherView.overrideHistory).toMatchObject([{ teacherName: "teacher", revision: 1, reason: input.reason, previousResult: { totalScore: 10 }, result: { totalScore: 9 } }]);
    expect(await runtime.runPromise(approveSubmission(a.teacher.token, id, 0).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    expect(await runtime.runPromise(saveReview(a.teacher.token, id, input).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    const hidden = (await runtime.runPromise(practiceOverview(a.student.token))).submissions[0];
    expect(hidden).toMatchObject({ draftGrade: null, originalGrade: null, overrideHistory: [] });
    await runtime.runPromise(approveSubmission(a.teacher.token, id, 1));
    expect((await runtime.runPromise(practiceOverview(a.student.token))).submissions[0].finalGrade).toMatchObject({ totalScore: 9, feedback: input.feedback });
    expect((await db.select().from(schema.grades))[0].result.totalScore).toBe(10);
    await expect(db.update(schema.teacherOverrides).set({ reason: "Rewrite history" })).rejects.toThrow();
    await expect(db.update(schema.grades).set({ reviewedResult: null })).rejects.toThrow();
    expect(await runtime.runPromise(saveReview(a.teacher.token, id, { ...input, revision: 1 }).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
  });
  it("rejects review point-limit/criterion violations, unauthorized settings and concurrent stale reviews", async () => {
    const a = await classroom("teacher_a"), b = await classroom("teacher_b");
    const id = await runtime.runPromise(submitAnswer(a.student.token, answer(a.practice.questionId)));
    await runtime.runPromise(runBatch);
    const input = { revision: 0, scores: [{ criterionId: "final-answer", score: 4 }, { criterionId: "working", score: 5 }], feedback: "Teacher feedback", reason: "Corrected reasoning credit" };
    for (const scores of [[{ criterionId: "final-answer", score: 5 }, { criterionId: "working", score: 5 }], [{ criterionId: "invented", score: 1 }], [{ criterionId: "final-answer", score: 4 }, { criterionId: "final-answer", score: 4 }]]) expect(await runtime.runPromise(saveReview(a.teacher.token, id, { ...input, scores }).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
    expect(await runtime.runPromise(saveReview(b.teacher.token, id, input).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
    expect(await runtime.runPromise(saveReview(a.student.token, id, input).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });
    expect(await runtime.runPromise(setDraftVisibility(b.teacher.token, a.practice.id, { showDraftGrades: true }).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });
    const concurrent = await Promise.all([1, 2].map(() => runtime.runPromise(saveReview(a.teacher.token, id, input).pipe(Effect.either))));
    expect(concurrent.filter((entry) => entry._tag === "Right")).toHaveLength(1);
    expect(await db.select().from(schema.teacherOverrides)).toHaveLength(1);
    await expect(db.update(schema.grades).set({ result: { ...(await db.select().from(schema.grades))[0].result, totalScore: 0 } })).rejects.toThrow();
  });
  it("persists operational keepalives without consuming jobs and marks stale/stopped workers unready", async () => {
    const a = await classroom();
    await runtime.runPromise(submitAnswer(a.student.token, answer(a.practice.questionId)));
    const monitor = makeHeartbeatStore(db);
    await Effect.runPromise(monitor.probe);
    const queued = await pg.query<{ read_ct: number }>("SELECT read_ct FROM pgmq.q_grading_jobs");
    expect(queued.rows).toHaveLength(1); expect(queued.rows[0].read_ct).toBe(0);
    const health = await Effect.runPromise(makeWorkerHealth({ intervalMs: 15000, timeoutMs: 3000, staleAfterMs: 60000, internalStallMs: 30000 }, 1000));
    await Effect.runPromise(Effect.all([health.startLoop, health.startProbeLoop, health.probeResult(true)]));
    await Effect.runPromise(health.claimSucceeded(1));
    await Effect.runPromise(health.jobPhase("private-run-id", "waiting_grading"));
    const id = randomUUID();
    await Effect.runPromise(monitor.record(id, "test-revision", await Effect.runPromise(health.snapshot), 60000));
    expect(await Effect.runPromise(monitor.list)).toMatchObject([{ id, fresh: true, ready: true, snapshot: { waitingGrading: 1 } }]);
    expect(JSON.stringify(await Effect.runPromise(monitor.list))).not.toContain("private-run-id");
    await db.update(schema.workerHeartbeats).set({ lastSeenAt: new Date(Date.now() - 120000) });
    expect(await Effect.runPromise(monitor.list)).toMatchObject([{ id, fresh: false, ready: false }]);
    await Effect.runPromise(health.stop);
    await Effect.runPromise(monitor.record(id, "test-revision", await Effect.runPromise(health.snapshot), 60000));
    expect(await Effect.runPromise(monitor.list)).toMatchObject([{ id, fresh: true, ready: false, snapshot: { stopping: true } }]);
  });
  it("deduplicates concurrent submissions and redelivered jobs without extra results/events", async () => {
    const { student, practice } = await classroom();
    const input = answer(practice.questionId);
    const ids = await Promise.all([1, 2].map(() => runtime.runPromise(submitAnswer(student.token, input))));
    expect(ids[0]).toBe(ids[1]);
    const [job] = await runtime.runPromise(queue.claim(60, 2));
    await runtime.runPromise(processJob(job));
    await runtime.runPromise(queue.enqueue(ids[0]));
    await runtime.runPromise(runBatch);
    expect(await db.select().from(schema.grades)).toHaveLength(1);
    expect(await db.select().from(schema.gradingRuns)).toHaveLength(1);
    expect((await db.select().from(schema.productEvents)).filter((event) => event.name === "grading_completion")).toHaveLength(1);
  });
  it("rolls back submission persistence when pgmq enqueue is unavailable", async () => {
    const { student, practice } = await classroom();
    await db.execute(sql`ALTER TABLE pgmq.q_grading_jobs RENAME TO temporarily_unavailable`);
    try {
      expect(await runtime.runPromise(submitAnswer(student.token, answer(practice.questionId)).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "StorageError" } });
      expect(await db.select().from(schema.submissions)).toHaveLength(0);
    } finally { await db.execute(sql`ALTER TABLE pgmq.temporarily_unavailable RENAME TO q_grading_jobs`); }
  });
  it("rejects a changed answer/idempotency replay and a second attempt", async () => {
    const { student, practice } = await classroom();
    const input = answer(practice.questionId);
    await runtime.runPromise(submitAnswer(student.token, input));
    for (const changed of [{ ...input, text: "x = 5" }, answer(practice.questionId, "4")]) {
      expect(await runtime.runPromise(submitAnswer(student.token, changed).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    }
  });
  it("uses queue visibility and DB fencing to prevent stale-worker writes", async () => {
    const { student, practice } = await classroom();
    const id = await runtime.runPromise(submitAnswer(student.token, answer(practice.questionId)));
    const first = await runtime.runPromise(repo.begin(id, randomUUID(), 60));
    expect(typeof first).not.toBe("string");
    expect(await runtime.runPromise(repo.begin(id, randomUUID(), 60))).toBe("busy");
    await db.update(schema.submissions).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.submissions.id, id));
    const next = await runtime.runPromise(repo.begin(id, randomUUID(), 60));
    expect(typeof next).not.toBe("string");
    if (typeof first === "string") throw new Error();
    expect(await runtime.runPromise(repo.fail(first, "stale", true).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "LeaseLost" } });
    expect((await db.select().from(schema.submissions))[0].attempts).toBe(2);
    expect((await db.select().from(schema.gradingRuns)).find((run) => run.id === first.runId)?.state).toBe("abandoned");
  });
  it("redelivers transient failures and recovers without a zero grade", async () => {
    const { student, practice } = await classroom();
    await runtime.dispose(); runtime = createRuntime({ failureMode: "transient", failureRate: 1 });
    await runtime.runPromise(submitAnswer(student.token, answer(practice.questionId)));
    await runtime.runPromise(runBatch);
    expect((await db.select().from(schema.submissions))[0].status).toBe("retryable_failure");
    expect(await db.select().from(schema.grades)).toHaveLength(0);
    await db.execute(sql`UPDATE pgmq.q_grading_jobs SET vt = now()`);
    await runtime.runPromise(runBatch);
    expect((await db.select().from(schema.submissions))[0]).toMatchObject({ status: "waiting_for_teacher", attempts: 2 });
  });
  for (const mode of ["permanent", "malformed", "timeout"] as const) it(`${mode} provider failure becomes explicit failure, never a grade`, async () => {
    const { teacher, student, practice } = await classroom();
    await runtime.dispose(); runtime = createRuntime({ failureMode: mode, failureRate: 1, maxAttempts: 1, ocrTimeoutMs: 10 });
    const id = await runtime.runPromise(submitAnswer(student.token, answer(practice.questionId)));
    await runtime.runPromise(runBatch);
    expect((await db.select().from(schema.submissions))[0].status).toBe("permanent_failure");
    expect(await db.select().from(schema.grades)).toHaveLength(0);
    expect(await runtime.runPromise(approveSubmission(teacher.token, id).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
    await runtime.runPromise(retrySubmission(teacher.token, id));
    expect((await db.select().from(schema.submissions))[0].status).toBe("retryable_failure");
  });
  it("unknown mock work is unsupported input, not a fabricated zero", async () => {
    const { student, practice } = await classroom();
    await runtime.runPromise(submitAnswer(student.token, answer(practice.questionId, "anything else")));
    await runtime.runPromise(runBatch);
    expect((await db.select().from(schema.submissions))[0]).toMatchObject({ status: "permanent_failure", failureCode: "grading_unsupported_input" });
    expect(await db.select().from(schema.grades)).toHaveLength(0);
  });
  it("enforces tenant isolation for questions, grades, approval and image bytes", async () => {
    const a = await classroom("teacher_a"), b = await classroom("teacher_b");
    expect(await runtime.runPromise(submitAnswer(a.student.token, answer(b.practice.questionId)).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
    const id = await runtime.runPromise(submitAnswer(a.student.token, answer(a.practice.questionId)));
    await runtime.runPromise(runBatch);
    expect((await runtime.runPromise(practiceOverview(b.teacher.token))).submissions).toHaveLength(0);
    expect(await runtime.runPromise(approveSubmission(b.teacher.token, id).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
    expect(await runtime.runPromise(approveSubmission(a.student.token, id).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });
    expect(await runtime.runPromise(submissionImage(b.student.token, id).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
  });
  it("durably preserves original PNG work and processes it through mock OCR", async () => {
    const a = await classroom();
    const png = new PNG({ width: 20, height: 20 }); png.data.fill(255);
    const bytes = PNG.sync.write(png);
    const input = { questionId: a.practice.questionId, idempotencyKey: randomUUID() };
    const id = await runtime.runPromise(submitImage(a.student.token, input, bytes));
    expect(await runtime.runPromise(submitImage(a.student.token, input, bytes))).toBe(id);
    const different = new PNG({ width: 10, height: 10 }); different.data.fill(0);
    expect(await runtime.runPromise(submitImage(a.student.token, input, PNG.sync.write(different)).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    expect(Buffer.from(await runtime.runPromise(submissionImage(a.teacher.token, id)))).toEqual(bytes);
    await runtime.runPromise(runBatch);
    const view = await runtime.runPromise(practiceOverview(a.teacher.token));
    expect(view.submissions[0].draftGrade?.totalScore).toBe(10);
    const source = (await db.select().from(schema.submissions))[0].source;
    expect(source.type).toBe("image");
    if (source.type === "image") expect(view.submissions[0].extractedAnswer?.sourceImageObjectKey).toBe(source.objectKey);
  });
  it("requires explicit rubric approval, validates point sums, and freezes published versions", async () => {
    const a = await classroom();
    for (const invalid of [{ ...draft, approved: false }, { ...draft, maxPoints: 9 }, { ...draft, criteria: [draft.criteria[0], draft.criteria[0]], maxPoints: 8 }, { ...draft, expectedAnswers: [] }]) {
      expect(await runtime.runPromise(publishPractice(a.teacher.token, invalid).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "InvalidInput" } });
    }
    await expect(db.update(schema.questionVersions).set({ prompt: "changed" })).rejects.toThrow();
    await expect(db.update(schema.rubricVersions).set({ criteria: [] })).rejects.toThrow();
    await expect(db.update(schema.submissions).set({ status: "finalized" })).resolves.toBeDefined(); // no submissions yet
    await runtime.runPromise(submitAnswer(a.student.token, answer(a.practice.questionId)));
    await runtime.runPromise(runBatch);
    await expect(db.update(schema.submissions).set({ status: "finalized" })).rejects.toThrow();
  });
  it("approves only once under concurrent requests and preserves the original AI result", async () => {
    const a = await classroom();
    const id = await runtime.runPromise(submitAnswer(a.student.token, answer(a.practice.questionId)));
    await runtime.runPromise(runBatch);
    const original = (await db.select().from(schema.grades))[0].result;
    const outcomes = await Promise.all([1, 2].map(() => runtime.runPromise(approveSubmission(a.teacher.token, id).pipe(Effect.either))));
    expect(outcomes.filter((value) => value._tag === "Right")).toHaveLength(1);
    expect((await db.select().from(schema.grades))[0].result).toEqual(original);
  });
});
