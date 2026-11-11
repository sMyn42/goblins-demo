import { randomUUID } from "node:crypto";
import { Clock, ConfigProvider, Effect, Fiber, Layer, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { StorageError } from "../src/core/errors";
import { makeWorkerHealth as makeMonotonicHealth, WorkerHealth, WorkerHealthConfig, type WorkerSnapshot, type HealthSettings } from "../src/worker/health";
import { WorkerHeartbeats, makeHeartbeatStore } from "../src/worker/heartbeat-store";
import { keepaliveLoop } from "../src/worker/keepalive";
import { GradingConfig, gradingConfig } from "../src/grading/config";
import { GradingQueue, SubmissionRepository, type RunInput } from "../src/grading/ports";
import { MockProvidersLive } from "../src/grading/mock-providers";
import { COMPLETE_WORK, PRACTICE_CRITERIA, PRACTICE_PROMPT } from "../src/grading/fixtures";
import { runBatch } from "../src/grading/worker";
import type { Database } from "../src/db/store";

const settings: HealthSettings = { intervalMs: 15000, timeoutMs: 3000, staleAfterMs: 60000, internalStallMs: 30000 };
const defaults = Effect.runSync(gradingConfig.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["APP_MODE", "test"], ["OCR_PROVIDER", "mock"], ["GRADING_PROVIDER", "mock"]])))));
const question = { id: randomUUID(), assignmentVersionId: randomUUID(), rubricVersionId: randomUUID(), prompt: PRACTICE_PROMPT, expectedAnswers: ["4"], teacherSolution: COMPLETE_WORK, maxPoints: 10, criteria: PRACTICE_CRITERIA };
const unused = () => Effect.dieMessage("Unexpected test dependency call");
// Effect's TestClock nanoseconds can reject jittered fractional milliseconds.
// Inject rounded virtual ms in tests; production retains its monotonic source.
const makeWorkerHealth = (config: HealthSettings, pollMs: number) => makeMonotonicHealth(config, pollMs, Clock.currentTimeMillis.pipe(Effect.map(Math.round)));
const virtual = <A, E>(program: Effect.Effect<A, E, never>) => Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));

function harness(waitMs: number) {
  let reachable = true, claims = 0, acks = 0, completed = 0;
  const reports: WorkerSnapshot[] = [];
  const registry = WorkerHeartbeats.of({ probe: Effect.suspend(() => reachable ? Effect.void : Effect.fail(new StorageError({ operation: "simulated queue outage" }))), record: (_id, _revision, snapshot) => Effect.sync(() => { reports.push(snapshot); }), list: Effect.succeed([]) });
  const config = { ...defaults, fixedMockOcrMs: waitMs, fixedMockGradingMs: 0, leaseSeconds: 600, ocrTimeoutMs: 400000, gradingTimeoutMs: 10000 };
  const queue = GradingQueue.of({ ready: Effect.void, enqueue: () => Effect.void, claim: () => Effect.sync(() => { claims++; return [{ id: "1", readCount: 1, submissionId: randomUUID() }]; }), acknowledge: () => Effect.sync(() => { acks++; }), defer: unused });
  const repo = SubmissionRepository.of({ publishPractice: unused, practices: unused, questionsForClass: unused, practice: unused, questionForClass: unused, submit: unused, forStudent: unused, forClass: unused, setDraftVisibility: unused, saveReview: unused, manualGrade: unused, approve: unused, retry: unused,
    begin: (submissionId, runId) => Effect.succeed({ submissionId, runId, attempt: 1, source: { type: "typed", text: COMPLETE_WORK }, question } satisfies RunInput),
    recordOCR: () => Effect.void, complete: (_run, grade) => Effect.sync(() => { expect(grade.totalScore).toBe(10); completed++; }), fail: unused,
  });
  const layers = Layer.mergeAll(Layer.succeed(GradingConfig, config), Layer.succeed(GradingQueue, queue), Layer.succeed(SubmissionRepository, repo), Layer.succeed(WorkerHeartbeats, registry), Layer.succeed(WorkerHealthConfig, settings), MockProvidersLive.pipe(Layer.provide(Layer.succeed(GradingConfig, config))));
  return { layers, reports, reachable: (value: boolean) => { reachable = value; }, counts: () => ({ claims, acks, completed }) };
}
describe("independent worker readiness and progress keepalive", () => {
  it("stays ready beyond 120 seconds of actual mock OCR orchestration, without extra claims/acks", async () => {
    const h = harness(150000);
    await virtual(Effect.scoped(Effect.gen(function* () {
      const health = yield* makeWorkerHealth(settings, 1000);
      yield* health.startLoop;
      yield* Effect.forkScoped(keepaliveLoop(randomUUID(), "virtual").pipe(Effect.provideService(WorkerHealth, health), Effect.provide(h.layers)));
      const batch = yield* Effect.forkScoped(runBatch.pipe(Effect.provideService(WorkerHealth, health), Effect.provide(h.layers)));
      yield* TestClock.adjust("130 seconds");
      expect(yield* health.snapshot).toMatchObject({ ready: true, reason: "ready", activeJobs: 1, waitingOCR: 1, oldestProviderWaitMs: 130000, completedJobs: 0 });
      expect(h.counts()).toEqual({ claims: 1, acks: 0, completed: 0 });
      expect(h.reports.length).toBeGreaterThanOrEqual(8);
      yield* TestClock.adjust("21 seconds");
      yield* Fiber.join(batch);
      expect(yield* health.snapshot).toMatchObject({ ready: true, activeJobs: 0, waitingOCR: 0, completedJobs: 1 });
      expect(h.counts()).toEqual({ claims: 1, acks: 1, completed: 1 });
    })));
  });
  it("loses readiness on queue outage and recovers during the same long-running provider call", async () => {
    const h = harness(300000);
    await virtual(Effect.scoped(Effect.gen(function* () {
      const health = yield* makeWorkerHealth(settings, 1000); yield* health.startLoop;
      yield* Effect.forkScoped(keepaliveLoop(randomUUID(), "virtual").pipe(Effect.provideService(WorkerHealth, health), Effect.provide(h.layers)));
      const batch = yield* Effect.forkScoped(runBatch.pipe(Effect.provideService(WorkerHealth, health), Effect.provide(h.layers)));
      yield* TestClock.adjust("130 seconds"); h.reachable(false);
      yield* TestClock.adjust("16 seconds");
      expect(yield* health.snapshot).toMatchObject({ ready: false, reason: "queue_unavailable", waitingOCR: 1 });
      h.reachable(true); yield* TestClock.adjust("16 seconds");
      expect(yield* health.snapshot).toMatchObject({ ready: true, waitingOCR: 1 });
      expect(h.counts().acks).toBe(0);
      yield* TestClock.adjust("140 seconds"); yield* Fiber.join(batch);
      expect(h.counts()).toEqual({ claims: 1, acks: 1, completed: 1 });
    })));
  });
  it("is unready before first probe, if the heartbeat stalls, and on shutdown/loop death", async () => {
    await virtual(Effect.gen(function* () {
      const health = yield* makeWorkerHealth(settings, 1000);
      expect((yield* health.snapshot).ready).toBe(false);
      yield* health.startLoop; yield* health.startProbeLoop; yield* health.probeResult(true);
      yield* health.claimSucceeded(1); yield* health.jobPhase("internal-only-id", "waiting_grading");
      expect((yield* health.snapshot).ready).toBe(true);
      yield* TestClock.adjust("61 seconds");
      expect(yield* health.snapshot).toMatchObject({ ready: false, reason: "probe_stale" });
      yield* health.probeResult(true); yield* health.stopLoop;
      expect(yield* health.snapshot).toMatchObject({ ready: false, reason: "loop_stopped" });
      yield* health.startLoop; yield* health.stop;
      expect(yield* health.snapshot).toMatchObject({ ready: false, reason: "stopping" });
      expect(JSON.stringify(yield* health.snapshot)).not.toContain("internal-only-id");
    }));
  });
  it("does not hide stalled internal DB work or a failed polling loop with a healthy probe", async () => {
    await virtual(Effect.gen(function* () {
      const health = yield* makeWorkerHealth(settings, 1000);
      yield* health.startLoop; yield* health.startProbeLoop; yield* health.probeResult(true);
      yield* health.pollStarted; yield* TestClock.adjust("31 seconds"); yield* health.probeResult(true);
      expect(yield* health.snapshot).toMatchObject({ ready: false, reason: "internal_stall" });
      yield* health.pollFailed;
      expect(yield* health.snapshot).toMatchObject({ ready: false, reason: "poll_failed" });
      yield* health.claimSucceeded(1); yield* health.jobPhase("run", "waiting_grading");
      yield* TestClock.adjust("31 seconds"); yield* health.probeResult(true);
      expect((yield* health.snapshot).ready).toBe(true);
      yield* health.jobPhase("run", "persisting"); yield* TestClock.adjust("31 seconds"); yield* health.probeResult(true);
      expect(yield* health.snapshot).toMatchObject({ ready: false, reason: "internal_stall" });
    }));
  });
  it("bounds hung probes and never queues another physical query behind one that has not settled", async () => {
    let calls = 0;
    let release!: (result: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const db = { execute: () => { calls++; return calls === 1 ? pending : Promise.resolve([{ queue_name: "grading_jobs" }]); } } as unknown as Database;
    const store = makeHeartbeatStore(db, true);
    await virtual(Effect.scoped(Effect.gen(function* () {
      const probe = yield* Effect.forkScoped(store.probe.pipe(Effect.timeout("1 second"), Effect.either));
      yield* TestClock.adjust("2 seconds");
      expect((yield* Fiber.join(probe))._tag).toBe("Left");
      expect((yield* store.probe.pipe(Effect.either))._tag).toBe("Left"); expect(calls).toBe(1);
      release([{ queue_name: "grading_jobs" }]);
      yield* Effect.yieldNow();
    })));
  });
  it("reports provider timeout/failure and clears wait gauges instead of keeping a false busy state", async () => {
    const h = harness(150000);
    const short = Layer.succeed(GradingConfig, { ...defaults, fixedMockOcrMs: 150000, fixedMockGradingMs: 0, maxAttempts: 1, ocrTimeoutMs: 1000, leaseSeconds: 300 });
    // The normal timeout/failure persistence path uses an explicit failure, never a grade.
    const config = { ...defaults, fixedMockOcrMs: 150000, fixedMockGradingMs: 0, maxAttempts: 1, ocrTimeoutMs: 1000, leaseSeconds: 300 };
    const repo = SubmissionRepository.of({ publishPractice: unused, practices: unused, questionsForClass: unused, practice: unused, questionForClass: unused, submit: unused, forStudent: unused, forClass: unused, setDraftVisibility: unused, saveReview: unused, manualGrade: unused, approve: unused, retry: unused,
      begin: (submissionId, runId) => Effect.succeed({ submissionId, runId, attempt: 1, source: { type: "typed", text: COMPLETE_WORK }, question } satisfies RunInput), recordOCR: unused, complete: unused, fail: () => Effect.void });
    const layer = Layer.mergeAll(h.layers, short, Layer.succeed(SubmissionRepository, repo), MockProvidersLive.pipe(Layer.provide(Layer.succeed(GradingConfig, config))));
    await virtual(Effect.scoped(Effect.gen(function* () {
      const health = yield* makeWorkerHealth(settings, 1000); yield* health.startLoop;
      yield* Effect.forkScoped(keepaliveLoop(randomUUID(), "virtual").pipe(Effect.provideService(WorkerHealth, health), Effect.provide(layer)));
      const batch = yield* Effect.forkScoped(runBatch.pipe(Effect.provideService(WorkerHealth, health), Effect.provide(layer)));
      yield* TestClock.adjust("10 seconds"); yield* Fiber.join(batch);
      expect(yield* health.snapshot).toMatchObject({ activeJobs: 0, waitingOCR: 0, completedJobs: 0, failedAttempts: 1, providerTimeouts: 2 });
    })));
  });
});
