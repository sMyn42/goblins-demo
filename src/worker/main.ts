import "../server/env";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Config, Effect, Schedule, Layer, Fiber, Exit } from "effect";
import { InfrastructureLive, DatabaseLive, DatabaseConnection } from "../server/database";
import { GradingConfig, GradingConfigLive } from "../grading/config";
import { ProvidersLive } from "../grading/providers";
import { PrivateStorageLive } from "../storage/service";
import { runBatch } from "../grading/worker";
import { sql } from "drizzle-orm";
import { makeWorkerHealth, WorkerHealth, WorkerHealthConfig, WorkerHealthConfigLive } from "./health";
import { WorkerHeartbeats, WorkerHeartbeatsLive } from "./heartbeat-store";
import { keepaliveLoop } from "./keepalive";

// Monitoring uses its own bounded pool; model waits never hold that connection.
const Services = Layer.mergeAll(InfrastructureLive, DatabaseLive, ProvidersLive, WorkerHeartbeatsLive).pipe(
  Layer.provideMerge(PrivateStorageLive), Layer.provideMerge(GradingConfigLive), Layer.provideMerge(WorkerHealthConfigLive),
);
const worker = Effect.scoped(Effect.gen(function* () {
  const config = yield* GradingConfig, healthConfig = yield* WorkerHealthConfig;
  const { db } = yield* DatabaseConnection;
  const registry = yield* WorkerHeartbeats;
  const health = yield* makeWorkerHealth(healthConfig, config.pollMs);
  const instanceId = randomUUID(), revision = (process.env.K_REVISION ?? "local").slice(0, 128);
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* health.stop;
    const snapshot = yield* health.snapshot;
    yield* registry.record(instanceId, revision, snapshot, healthConfig.staleAfterMs).pipe(Effect.timeout(healthConfig.timeoutMs), Effect.ignore);
  }));
  const port = yield* Config.integer("PORT").pipe(Config.withDefault(8081));
  yield* Effect.acquireRelease(
    Effect.async<ReturnType<typeof createServer>, Error>((resume) => {
      const http = createServer((request, response) => {
        if (!["/health", "/ready", "/status"].includes(request.url ?? "")) { response.writeHead(404); response.end(); return; }
        void Effect.runPromise(health.snapshot).then((snapshot) => {
          const live = snapshot.loopRunning && snapshot.probeLoopRunning && !snapshot.stopping;
          const ok = request.url === "/health" ? live : request.url === "/status" ? !snapshot.stopping : snapshot.ready;
          response.writeHead(ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ status: ok ? "ok" : "unavailable", instanceId, revision, ocrProvider: config.ocrProvider, gradingProvider: config.gradingProvider, ...snapshot }));
        }).catch(() => { response.writeHead(503); response.end(); });
      });
      http.once("error", (error) => resume(Effect.fail(error)));
      http.listen(port, "0.0.0.0", () => resume(Effect.succeed(http)));
    }),
    (http) => Effect.async<void>((resume) => { http.close(() => resume(Effect.void)); http.closeIdleConnections(); }),
  );
  yield* Effect.logInfo(`Grading worker started: OCR=${config.ocrProvider}, grading=${config.gradingProvider}. Independent queue probing and progress heartbeats enabled.`);
  const gradingLoop = Effect.gen(function* () {
    yield* health.startLoop;
    const tick = runBatch.pipe(Effect.catchAll(() => Effect.gen(function* () {
      yield* health.pollFailed;
      yield* Effect.logWarning("Worker poll failed; committed messages remain durable.");
    })));
    yield* Effect.repeat(tick, Schedule.spaced(`${config.pollMs} millis`));
  }).pipe(Effect.ensuring(health.stopLoop));
  const housekeeping = Effect.repeat(Effect.tryPromise(() => db.execute(sql`DELETE FROM sessions WHERE expires_at <= now()`)).pipe(Effect.ignore), Schedule.spaced("1 minute"));
  // all is fail-fast: a terminated/defective core loop cannot be masked by a healthy heartbeat.
  yield* Effect.all([gradingLoop, keepaliveLoop(instanceId, revision), housekeeping], { concurrency: "unbounded", discard: true }).pipe(Effect.provideService(WorkerHealth, health));
})).pipe(Effect.provide(Services));

const fiber = Effect.runFork(worker);
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; void Effect.runPromise(Fiber.interrupt(fiber)); } };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
  if (Exit.isFailure(exit) && !stopping) { console.error("Worker stopped. Check configuration, port, and database connectivity."); process.exitCode = 1; }
});
