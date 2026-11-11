import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "./store";
import { rows } from "./queue";

export async function setupQueue(db: Database, mode: "existing" | "sql" | "extension" = "existing") {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(74625101)`);
    const [available] = rows<{ present: boolean }>(await tx.execute(sql`SELECT to_regnamespace('pgmq') IS NOT NULL AS present`));
    if (!available.present) {
      if (mode === "extension") await tx.execute(sql`CREATE EXTENSION IF NOT EXISTS pgmq`);
      else if (mode === "sql") {
        const source = await readFile("vendor/pgmq/pgmq--1.13.1.sql", "utf8");
        if (createHash("sha256").update(source).digest("hex") !== "e861fcbd8c602df70a00eb9d230b1a2f591860a2230b9a6084172e3eff463642") throw new Error("Vendored pgmq checksum mismatch");
        await tx.execute(sql.raw(source));
      } else throw new Error("Enable Supabase Queues/pgmq first, or explicitly select local SQL-only installation.");
    }
    // Existing managed pgmq is never overwritten or silently upgraded.
    await tx.execute(sql`SELECT pgmq.create('grading_jobs'::text)`);
    await tx.execute(sql`REVOKE ALL ON SCHEMA pgmq FROM PUBLIC`);
    await tx.execute(sql`DO $$ DECLARE role_name text; BEGIN
      FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
          EXECUTE format('REVOKE ALL ON SCHEMA pgmq FROM %I', role_name);
        END IF;
      END LOOP;
    END $$`);
  });
}
