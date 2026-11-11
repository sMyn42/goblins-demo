import { Config, Context, Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { Redacted } from "effect";
import { ConfigurationError } from "../core/errors";
import { Store } from "../core/ports";
import { makeStore, type Database } from "../db/store";
import { makeQueue } from "../db/queue";
import { makeSubmissionRepository } from "../db/submissions";
import { GradingQueue, SubmissionRepository } from "../grading/ports";
import * as schema from "../db/schema";

export class DatabaseConnection extends Context.Tag("goblins/Database")<DatabaseConnection, { db: Database }>() {}
export const DatabaseLive = Layer.scoped(DatabaseConnection, Effect.gen(function* () {
  const secret = yield* Config.redacted("DATABASE_URL").pipe(Effect.mapError(() => new ConfigurationError({ message: "DATABASE_URL is required." })));
  const client = yield* Effect.acquireRelease(
    Effect.try({ try: () => postgres(Redacted.value(secret), { max: 10, prepare: false, connect_timeout: 10, idle_timeout: 20, connection: { statement_timeout: 30000 } }), catch: () => new ConfigurationError({ message: "DATABASE_URL is invalid." }) }),
    (connection) => Effect.promise(() => connection.end({ timeout: 5 })),
  );
  return { db: drizzle(client, { schema }) };
}));
const StoreLive = Layer.effect(Store, Effect.map(DatabaseConnection, ({ db }) => makeStore(db)));
const QueueLive = Layer.effect(GradingQueue, Effect.map(DatabaseConnection, ({ db }) => makeQueue(db)));
const SubmissionsLive = Layer.effect(SubmissionRepository, Effect.map(DatabaseConnection, ({ db }) => makeSubmissionRepository(db)));
export const InfrastructureLive = Layer.mergeAll(StoreLive, QueueLive, SubmissionsLive).pipe(Layer.provide(DatabaseLive));
