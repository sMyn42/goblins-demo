import { Config, Context, Effect, Layer, Redacted } from "effect";
import { sql, desc, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { ConfigurationError, StorageError } from "../core/errors";
import type { Database } from "../db/store";
import { checkQueue } from "../db/queue";
import { workerHeartbeats } from "../db/schema";
import * as schema from "../db/schema";
import { WorkerHealthConfig, type WorkerSnapshot } from "./health";

export type FleetWorker = { id: string; revision: string; lastSeenAgeMs: number; fresh: boolean; ready: boolean; snapshot: WorkerSnapshot };
export class WorkerHeartbeats extends Context.Tag("goblins/WorkerHeartbeats")<WorkerHeartbeats, {
  probe: Effect.Effect<void, StorageError>;
  record: (id: string, revision: string, snapshot: WorkerSnapshot, staleAfterMs: number) => Effect.Effect<void, StorageError>;
  list: Effect.Effect<FleetWorker[], StorageError>;
}>() {}
export const makeHeartbeatStore = (db: Database, singleFlight = false): typeof WorkerHeartbeats.Service => {
  let inFlight = false;
  // A timed-out promise can outlive an interrupted Effect/driver call. Do not
  // enqueue more physical monitor queries until that promise has really settled.
  const query = <A>(operation: string, run: () => Promise<A>) => Effect.tryPromise({ try: async () => {
    if (singleFlight && inFlight) throw new Error("Monitor query still in flight");
    if (singleFlight) inFlight = true;
    try { return await run(); } finally { if (singleFlight) inFlight = false; }
  }, catch: () => new StorageError({ operation }) });
  return {
    probe: query("worker.probe", () => checkQueue(db)),
    record: (id, revision, snapshot, staleAfterMs) => query("worker.heartbeat", async () => {
      await db.insert(workerHeartbeats).values({ id, revision, snapshot, staleAfterMs, ready: snapshot.ready })
        .onConflictDoUpdate({ target: workerHeartbeats.id, set: { snapshot, staleAfterMs, ready: snapshot.ready, lastSeenAt: sql`clock_timestamp()` } });
    }),
    list: query("worker.fleet", async () => {
      const records = await db.select({ id: workerHeartbeats.id, revision: workerHeartbeats.revision, ready: workerHeartbeats.ready, snapshot: workerHeartbeats.snapshot, staleAfterMs: workerHeartbeats.staleAfterMs,
        age: sql<number>`extract(epoch FROM (clock_timestamp() - ${workerHeartbeats.lastSeenAt})) * 1000`,
      }).from(workerHeartbeats).where(gt(workerHeartbeats.lastSeenAt, sql`clock_timestamp() - interval '1 day'`)).orderBy(desc(workerHeartbeats.lastSeenAt)).limit(1000);
      return records.map(({ age, staleAfterMs, ...record }) => {
        const lastSeenAgeMs = Math.max(0, Number(age));
        const fresh = lastSeenAgeMs <= staleAfterMs;
        return { ...record, lastSeenAgeMs, fresh, ready: fresh && record.ready && record.snapshot.loopRunning && record.snapshot.probeLoopRunning && !record.snapshot.stopping };
      });
    }),
  };
};
// A separate one-connection pool keeps probes out of the grading pool's queue.
export const WorkerHeartbeatsLive = Layer.scoped(WorkerHeartbeats, Effect.gen(function* () {
  const config = yield* WorkerHealthConfig;
  const url = yield* Config.redacted("DATABASE_URL").pipe(Effect.mapError(() => new ConfigurationError({ message: "DATABASE_URL is required." })));
  const client = yield* Effect.acquireRelease(Effect.try({
    try: () => postgres(Redacted.value(url), { max: 1, prepare: false, connect_timeout: Math.max(1, Math.ceil(config.timeoutMs / 1000)), idle_timeout: 20,
      connection: { statement_timeout: Math.max(100, config.timeoutMs - 500) } }),
    catch: () => new ConfigurationError({ message: "Invalid monitoring database configuration." }),
  }), (connection) => Effect.promise(() => connection.end({ timeout: 2 })));
  return makeHeartbeatStore(drizzle(client, { schema }), true);
}));
