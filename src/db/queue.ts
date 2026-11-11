import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { Schema } from "effect";
import { StorageError } from "../core/errors";
import { GradingQueue } from "../grading/ports";
import type { Database } from "./store";

export const rows = <A>(result: unknown): A[] => {
  // postgres-js returns a RowList; PGlite returns { rows }. Both run the same SQL.
  if (Array.isArray(result)) return result as A[];
  if (typeof result === "object" && result !== null && "rows" in result && Array.isArray(result.rows)) return result.rows as A[];
  throw new Error("Unexpected database result");
};
export const enqueueSQL = (submissionId: string) => sql`SELECT pgmq.send('grading_jobs'::text, ${JSON.stringify({ submissionId })}::jsonb)`;
const Payload = Schema.Struct({ submissionId: Schema.UUID });
const payload = Schema.decodeUnknownOption(Payload);
export async function checkQueue(db: Database) {
  const result = rows<{ queue_name: string }>(await db.execute(sql`SELECT queue_name FROM pgmq.meta WHERE queue_name = 'grading_jobs'`));
  if (result.length !== 1) throw new Error("Queue missing");
  await db.execute(sql`SELECT msg_id FROM pgmq.q_grading_jobs LIMIT 0`);
}
export const makeQueue = (db: Database): typeof GradingQueue.Service => {
  const query = <A>(operation: string, run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new StorageError({ operation }) });
  return {
    ready: query("queue.ready", () => checkQueue(db)),
    enqueue: (id) => query("queue.enqueue", async () => { await db.execute(enqueueSQL(id)); }),
    claim: (leaseSeconds, batch) => query("queue.claim", async () => {
      const result = rows<{ msg_id: string | number | bigint; read_ct: number; message: unknown }>(await db.execute(sql`SELECT * FROM pgmq.read('grading_jobs'::text, ${leaseSeconds}::integer, ${batch}::integer)`));
      return result.map((row) => {
        const message = payload(row.message);
        return { id: String(row.msg_id), readCount: row.read_ct, submissionId: message._tag === "Some" ? message.value.submissionId : null };
      });
    }),
    // Archive = durable acknowledgement with inspectable ID-only payloads.
    acknowledge: (id) => query("queue.ack", async () => { await db.execute(sql`SELECT pgmq.archive('grading_jobs'::text, ${id}::bigint)`); }),
    defer: (id, seconds) => query("queue.defer", async () => { await db.execute(sql`SELECT * FROM pgmq.set_vt('grading_jobs'::text, ${id}::bigint, ${seconds}::integer)`); }),
  };
};
