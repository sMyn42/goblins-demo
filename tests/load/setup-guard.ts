import postgres from "postgres";

const env = process.env;
const confirmation = "I_CONFIRMED_SEPARATE_LOADTEST_INFRASTRUCTURE";

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Required isolated setting is missing: ${name}`);
  return value;
}

function origin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Supabase settings must be HTTPS project origins.");
  }
  return parsed.origin;
}

async function main() {
  if (required("LOADTEST_ENVIRONMENT") !== "isolated" || required("LOADTEST_CONFIRM_ISOLATED") !== confirmation) {
    throw new Error("Explicit isolated-load-test confirmation is required.");
  }
  const testProject = required("LOADTEST_GCP_PROJECT");
  if (testProject === required("LOADTEST_PRODUCTION_GCP_PROJECT")) throw new Error("Test GCP project must differ from production.");
  const testHost = new URL(required("DATABASE_URL")).hostname.toLowerCase().replace(/\.$/, "");
  const expectedHost = required("LOADTEST_EXPECTED_DATABASE_HOST").toLowerCase().replace(/\.$/, "");
  const productionHost = required("LOADTEST_PRODUCTION_DATABASE_HOST").toLowerCase().replace(/\.$/, "");
  if (testHost !== expectedHost || testHost === productionHost || ["localhost", "127.0.0.1", "::1"].includes(testHost) || testHost.endsWith(".local")) {
    throw new Error("Database host isolation check failed; refusing to create the load-test guard.");
  }
  if (origin(required("SUPABASE_URL")) === origin(required("LOADTEST_PRODUCTION_SUPABASE_URL"))) {
    throw new Error("Test Supabase project must differ from production.");
  }
  const bucket = required("SUPABASE_STORAGE_BUCKET");
  if (bucket !== required("LOADTEST_STORAGE_BUCKET") || bucket === required("LOADTEST_PRODUCTION_STORAGE_BUCKET") || !/load.?test|test/i.test(bucket)) {
    throw new Error("Storage bucket isolation check failed.");
  }

  const db = postgres(required("DATABASE_URL"), { max: 1, prepare: false, connect_timeout: 10 });
  try {
    await db.unsafe(`CREATE TABLE IF NOT EXISTS public.loadtest_environment_guard (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      environment text NOT NULL CHECK (environment = 'isolated-load-test'),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    const rows = await db<{ environment: string }[]>`SELECT environment FROM public.loadtest_environment_guard WHERE id = true`;
    if (rows.length === 0) {
      await db`INSERT INTO public.loadtest_environment_guard (id, environment) VALUES (true, 'isolated-load-test')`;
    } else if (rows.length !== 1 || rows[0].environment !== "isolated-load-test") {
      throw new Error("Existing load-test guard row is invalid; refusing to modify it.");
    }
    await db.unsafe("REVOKE ALL ON public.loadtest_environment_guard FROM PUBLIC, anon, authenticated");
    console.log("Isolated load-test database guard is ready.");
  } finally {
    await db.end();
  }
}

main().catch(() => {
  console.error("Load-test DB guard setup failed. Check isolated project configuration and database permissions; no credentials were logged.");
  process.exitCode = 1;
});
