import "../server/env";
import { createServer } from "node:http";
import { Config, Effect, Schedule, Layer, Fiber, Exit } from "effect";
import { InfrastructureLive } from "../server/database";
import { DatabaseLive, DatabaseConnection } from "../server/database";
import { GradingConfig, GradingConfigLive } from "../grading/config";
import { ProvidersLive } from "../grading/providers";
import { PrivateStorageLive } from "../storage/service";
import { runBatch } from "../grading/worker";
import { sql } from "drizzle-orm";

const Services = Layer.mergeAll(InfrastructureLive, DatabaseLive, ProvidersLive).pipe(Layer.provideMerge(PrivateStorageLive), Layer.provideMerge(GradingConfigLive));
const worker = Effect.scoped(Effect.gen(function* () {
  const config = yield* GradingConfig;
  const { db } = yield* DatabaseConnection;
  let lastSuccessfulPoll = 0;
  const port = yield* Config.integer("PORT").pipe(Config.withDefault(8081));
  const server = yield* Effect.acquireRelease(
    Effect.async<ReturnType<typeof createServer>, Error>((resume) => {
      const http = createServer((request, response) => {
        const ready = Date.now() - lastSuccessfulPoll < 120_000;
        const status = request.url === "/health" ? 200 : request.url === "/ready" ? ready ? 200 : 503 : 404;
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: status === 200 ? "ok" : "unavailable", ocrProvider: config.ocrProvider, gradingProvider: config.gradingProvider }));
      });
      http.once("error", (error) => resume(Effect.fail(error)));
      http.listen(port, "0.0.0.0", () => resume(Effect.succeed(http)));
    }),
    (http) => Effect.async<void>((resume) => { http.close(() => resume(Effect.void)); }),
  );
  void server;
  yield* Effect.logInfo(`Grading worker started: OCR=${config.ocrProvider}, grading=${config.gradingProvider}. Every grade awaits teacher approval.`);
  const tick = Effect.gen(function* () {
    // Housekeeping plus an actual DB/queue check, not a fake readiness signal.
    yield* Effect.tryPromise(() => db.execute(sql`DELETE FROM sessions WHERE expires_at <= now()`));
    yield* runBatch;
    lastSuccessfulPoll = Date.now();
  }).pipe(Effect.catchAll(() => Effect.logWarning("Worker poll failed; committed messages remain durable.")));
  yield* Effect.repeat(tick, Schedule.spaced(`${config.pollMs} millis`));
})).pipe(Effect.provide(Services));

const fiber = Effect.runFork(worker);
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; void Effect.runPromise(Fiber.interrupt(fiber)); } };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
  if (Exit.isFailure(exit) && !stopping) { console.error("Worker stopped. Check configuration, port, and database connectivity."); process.exitCode = 1; }
});
