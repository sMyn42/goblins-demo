import "../src/server/env";
import { Config, Effect, Redacted } from "effect";

const setup = Effect.gen(function* () {
  const { url, key, bucket } = yield* Config.all({ url: Config.string("SUPABASE_URL"), key: Config.redacted("SUPABASE_SERVICE_ROLE_KEY"), bucket: Config.string("SUPABASE_STORAGE_BUCKET").pipe(Config.withDefault("student-work")) });
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !/^[a-z0-9-]+$/.test(bucket)) return yield* Effect.fail(new Error("Invalid private bucket configuration"));
  yield* Effect.tryPromise(async (signal) => {
    const headers = { Authorization: `Bearer ${Redacted.value(key)}`, apikey: Redacted.value(key), "Content-Type": "application/json" };
    const endpoint = `${parsed.origin}/storage/v1/bucket`;
    const existing = await fetch(`${endpoint}/${bucket}`, { headers, signal });
    if (existing.status === 404) {
      const created = await fetch(endpoint, { method: "POST", headers, signal, body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 2097152, allowed_mime_types: ["image/png"] }) });
      if (!created.ok) throw new Error("Bucket creation failed");
    } else if (!existing.ok || (await existing.json()).public !== false) throw new Error("Existing bucket is not private or is unavailable");
    const check = await fetch(`${endpoint}/${bucket}`, { headers, signal });
    if (!check.ok || (await check.json()).public !== false) throw new Error("Private bucket verification failed");
  }).pipe(Effect.timeout("30 seconds"));
  yield* Effect.logInfo("Private Supabase storage bucket verified.");
});
Effect.runPromise(setup).catch(() => { console.error("Storage setup failed. Check server credentials/project access; sensitive details were not logged."); process.exitCode = 1; });
