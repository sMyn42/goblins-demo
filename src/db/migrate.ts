import "../server/env";
import { Effect } from "effect";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ConfigurationError, StorageError } from "../core/errors";
import { setupQueue } from "./setup-queue";
import * as schema from "./schema";

const program = Effect.scoped(Effect.gen(function* () {
  if (!process.env.DATABASE_URL) return yield* new ConfigurationError({ message: "DATABASE_URL is required." });
  const url = process.env.DATABASE_URL;
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} })),
    (connection) => Effect.promise(() => connection.end()),
  );
  yield* Effect.tryPromise({ try: () => migrate(drizzle(client), { migrationsFolder: "drizzle" }), catch: () => new StorageError({ operation: "migrate" }) });
  const mode = process.env.PGMQ_INSTALL_MODE ?? "existing";
  if (mode !== "sql" && mode !== "extension" && mode !== "existing") return yield* new ConfigurationError({ message: "Invalid PGMQ_INSTALL_MODE." });
  yield* Effect.tryPromise({ try: () => setupQueue(drizzle(client, { schema }), mode), catch: () => new StorageError({ operation: "queue.setup (enable pgmq or set PGMQ_INSTALL_MODE=sql locally)" }) });
  yield* Effect.logInfo("Database migrations applied; grading_jobs queue ready.");
}));

Effect.runPromise(program).catch(() => {
  console.error("Migration failed. Check DATABASE_URL and database permissions; no credentials were logged.");
  process.exitCode = 1;
});
