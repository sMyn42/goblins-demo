import { Effect, Schedule } from "effect";
import { WorkerHeartbeats } from "./heartbeat-store";
import { WorkerHealth, WorkerHealthConfig } from "./health";

export const keepaliveOnce = (id: string, revision: string) => Effect.gen(function* () {
  const store = yield* WorkerHeartbeats, health = yield* WorkerHealth, config = yield* WorkerHealthConfig;
  // The probe does not consume or claim a job. Provider waits never enter this fiber.
  const result = yield* store.probe.pipe(Effect.timeout(config.timeoutMs), Effect.either);
  yield* health.probeResult(result._tag === "Right");
  const snapshot = yield* health.snapshot;
  yield* store.record(id, revision, snapshot, config.staleAfterMs).pipe(
    Effect.timeout(config.timeoutMs),
    Effect.catchAll(() => Effect.logWarning("Worker heartbeat publication failed; main service will mark it stale.")),
  );
});
export const keepaliveLoop = (id: string, revision: string) => Effect.gen(function* () {
  const health = yield* WorkerHealth, config = yield* WorkerHealthConfig;
  yield* health.startProbeLoop;
  yield* Effect.repeat(keepaliveOnce(id, revision), Schedule.spaced(`${config.intervalMs} millis`));
}).pipe(Effect.ensuring(Effect.flatMap(WorkerHealth, (health) => health.stopProbeLoop)));
