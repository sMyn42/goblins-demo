import { Clock, Config, Context, Effect, Layer, Ref } from "effect";
import { ConfigurationError } from "../core/errors";

export const workerHealthConfig = Config.all({
  intervalMs: Config.integer("WORKER_HEARTBEAT_INTERVAL_MS").pipe(Config.withDefault(15000)),
  timeoutMs: Config.integer("WORKER_PROBE_TIMEOUT_MS").pipe(Config.withDefault(3000)),
  staleAfterMs: Config.integer("WORKER_HEARTBEAT_STALE_MS").pipe(Config.withDefault(60000)),
  internalStallMs: Config.integer("WORKER_INTERNAL_STALL_MS").pipe(Config.withDefault(30000)),
});
export type HealthSettings = Config.Config.Success<typeof workerHealthConfig>;
export class WorkerHealthConfig extends Context.Tag("goblins/WorkerHealthConfig")<WorkerHealthConfig, HealthSettings>() {}
export const WorkerHealthConfigLive = Layer.effect(WorkerHealthConfig, Effect.gen(function* () {
  const config = yield* workerHealthConfig.pipe(Effect.mapError(() => new ConfigurationError({ message: "Invalid worker health configuration." })));
  if (config.intervalMs < 100 || config.intervalMs > 60000 || config.timeoutMs < 50 || config.timeoutMs > 10000 || config.staleAfterMs < config.intervalMs + 2 * config.timeoutMs || config.staleAfterMs > 300000 || config.internalStallMs < 100 || config.internalStallMs > 120000) {
    return yield* new ConfigurationError({ message: "Worker health intervals must be bounded and freshness must exceed interval + two probe timeouts." });
  }
  return config;
}));
export type JobPhase = "claiming_run" | "waiting_ocr" | "waiting_grading" | "persisting";
export type WorkerSnapshot = {
  ready: boolean; reason: "ready" | "starting" | "stopping" | "loop_stopped" | "probe_stale" | "queue_unavailable" | "poll_failed" | "internal_stall";
  stopping: boolean; loopRunning: boolean; probeLoopRunning: boolean; phase: "starting" | "idle" | "polling" | "batch" | "stopped";
  lastProbeAgeMs: number | null; lastQueuePollAgeMs: number | null; batchAgeMs: number | null;
  activeJobs: number; waitingOCR: number; waitingGrading: number; persisting: number;
  oldestProviderWaitMs: number | null; completedJobs: number; failedAttempts: number; providerTimeouts: number;
};
const monotonicNow = Clock.currentTimeNanos.pipe(Effect.map((nanos) => Number(nanos / 1000000n)));
export const makeWorkerHealth = (config: HealthSettings, pollMs: number, now: Effect.Effect<number> = monotonicNow) => Effect.gen(function* () {
  const state = yield* Ref.make({
    stopping: false, loopRunning: false, probeLoopRunning: false, phase: "starting" as WorkerSnapshot["phase"],
    progressAt: yield* now, batchAt: null as number | null, probeAt: null as number | null, pollAt: null as number | null,
    probeOK: false, pollFailed: false, jobs: new Map<string, { phase: JobPhase; since: number }>(), completedJobs: 0, failedAttempts: 0, providerTimeouts: 0,
  });
  type State = typeof state extends Ref.Ref<infer S> ? S : never;
  const update = (f: (value: State, time: number) => State) => Effect.flatMap(now, (time) => Ref.update(state, (value) => f(value, time)));
  const snapshot = Effect.gen(function* () {
    const time = yield* now, value = yield* Ref.get(state);
    const age = (timestamp: number | null) => timestamp === null ? null : Math.max(0, time - timestamp);
    const jobs = [...value.jobs.values()];
    const waits = jobs.filter((job) => job.phase === "waiting_ocr" || job.phase === "waiting_grading");
    const stalled = jobs.some((job) => !job.phase.startsWith("waiting_") && time - job.since > config.internalStallMs)
      || (value.phase === "polling" && time - value.progressAt > config.internalStallMs)
      || (value.phase === "idle" && time - value.progressAt > pollMs + config.internalStallMs);
    const reason: WorkerSnapshot["reason"] = value.stopping ? "stopping" : !value.loopRunning ? value.phase === "starting" ? "starting" : "loop_stopped" : !value.probeLoopRunning || value.probeAt === null ? "starting" : age(value.probeAt)! > config.staleAfterMs ? "probe_stale" : !value.probeOK ? "queue_unavailable" : value.pollFailed ? "poll_failed" : stalled ? "internal_stall" : "ready";
    return {
      ready: reason === "ready", reason, stopping: value.stopping, loopRunning: value.loopRunning, probeLoopRunning: value.probeLoopRunning, phase: value.phase,
      lastProbeAgeMs: age(value.probeAt), lastQueuePollAgeMs: age(value.pollAt), batchAgeMs: age(value.batchAt),
      activeJobs: jobs.length, waitingOCR: jobs.filter((job) => job.phase === "waiting_ocr").length,
      waitingGrading: jobs.filter((job) => job.phase === "waiting_grading").length, persisting: jobs.filter((job) => !job.phase.startsWith("waiting_")).length,
      oldestProviderWaitMs: waits.length ? Math.max(...waits.map((job) => time - job.since)) : null,
      completedJobs: value.completedJobs, failedAttempts: value.failedAttempts, providerTimeouts: value.providerTimeouts,
    } satisfies WorkerSnapshot;
  });
  return {
    snapshot,
    startLoop: update((value, time) => ({ ...value, loopRunning: true, phase: "idle", progressAt: time })),
    stopLoop: update((value) => ({ ...value, loopRunning: false, phase: "stopped" })),
    startProbeLoop: update((value) => ({ ...value, probeLoopRunning: true })),
    stopProbeLoop: update((value) => ({ ...value, probeLoopRunning: false })),
    stop: update((value) => ({ ...value, stopping: true, loopRunning: false, probeLoopRunning: false, phase: "stopped" })),
    probeResult: (ok: boolean) => update((value, time) => ({ ...value, probeOK: ok, probeAt: time })),
    pollStarted: update((value, time) => ({ ...value, phase: "polling", progressAt: time })),
    claimSucceeded: (count: number) => update((value, time) => ({ ...value, pollAt: time, pollFailed: false, phase: count ? "batch" : "idle", batchAt: count ? time : null, progressAt: time })),
    pollFinished: update((value, time) => ({ ...value, phase: "idle", batchAt: null, progressAt: time })),
    pollFailed: update((value, time) => ({ ...value, pollFailed: true, phase: "idle", batchAt: null, progressAt: time })),
    jobPhase: (id: string, phase: JobPhase) => update((value, time) => ({ ...value, jobs: new Map(value.jobs).set(id, { phase, since: time }) })),
    jobEnded: (id: string) => update((value) => { const jobs = new Map(value.jobs); jobs.delete(id); return { ...value, jobs }; }),
    completed: update((value) => ({ ...value, completedJobs: value.completedJobs + 1 })),
    failed: update((value) => ({ ...value, failedAttempts: value.failedAttempts + 1 })),
    providerTimeout: update((value) => ({ ...value, providerTimeouts: value.providerTimeouts + 1 })),
  };
});
export type WorkerHealthService = Effect.Effect.Success<ReturnType<typeof makeWorkerHealth>>;
export class WorkerHealth extends Context.Tag("goblins/WorkerHealth")<WorkerHealth, WorkerHealthService>() {}
// Optional instrumentation keeps the same orchestration usable in isolated application tests.
export const observeWorker = (event: (health: WorkerHealthService) => Effect.Effect<void>) => Effect.flatMap(Effect.serviceOption(WorkerHealth), (service) => service._tag === "Some" ? event(service.value) : Effect.void);
