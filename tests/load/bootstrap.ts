import "../../src/server/env";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Layer, ManagedRuntime } from "effect";
import { register } from "../../src/core/auth";
import { createClass } from "../../src/core/classrooms";
import { InfrastructureLive } from "../../src/server/database";
import { PasswordsLive } from "../../src/server/passwords";
import { publishPractice } from "../../src/grading/application";
import postgres from "postgres";

const CONFIRMATION = "I_CONFIRMED_SEPARATE_LOADTEST_INFRASTRUCTURE";
const loadDir = dirname(fileURLToPath(import.meta.url));
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function checkIsolation() {
  if (process.env.LOADTEST_ENVIRONMENT !== "isolated" || process.env.LOADTEST_CONFIRM_ISOLATED !== CONFIRMATION) {
    throw new Error("Set the isolated load-test environment and explicit confirmation; no application DATABASE_URL fallback is allowed.");
  }
  const connection = process.env.LOADTEST_DATABASE_URL;
  const expectedHost = process.env.LOADTEST_EXPECTED_DATABASE_HOST?.toLowerCase().replace(/\.$/, "");
  const productionHost = process.env.LOADTEST_PRODUCTION_DATABASE_HOST?.toLowerCase().replace(/\.$/, "");
  if (!connection || !expectedHost || !productionHost) throw new Error("LOADTEST_DATABASE_URL and both expected database host guards are required.");
  let parsed: URL;
  try { parsed = new URL(connection); } catch { throw new Error("LOADTEST_DATABASE_URL is not a valid PostgreSQL URL."); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || host !== expectedHost || host === productionHost
    || ["localhost", "127.0.0.1", "::1"].includes(host) || host.endsWith(".local")) {
    throw new Error("Database isolation check failed; the target must be the explicitly named isolated hosted test database.");
  }
  process.env.DATABASE_URL = connection;
  process.env.APP_MODE = "load-test";
}

function runIdFromArgs() {
  const index = process.argv.indexOf("--run-id");
  const value = index >= 0 ? process.argv[index + 1] : process.env.LOADTEST_RUN_ID;
  if (!value || !/^[A-Za-z0-9_-]{1,48}$/.test(value)) throw new Error("Usage: npm exec tsx tests/load/bootstrap.ts -- --run-id <unique-test-run-id>");
  return value;
}

async function main() {
  checkIsolation();
  const runId = runIdFromArgs();
  const cohortPath = resolve(process.env.LOADTEST_COHORTS_PATH ?? join(loadDir, "cohorts.json"));
  const cohorts = JSON.parse(await readFile(cohortPath, "utf8")) as { student_accounts: number; cohorts: { id: string }[] };
  if (!Number.isInteger(cohorts.student_accounts) || cohorts.student_accounts < 1 || !Array.isArray(cohorts.cohorts) || !cohorts.cohorts.length) {
    throw new Error("The cohort definition file is invalid.");
  }
  const stateDir = resolve(process.env.LOADTEST_STATE_DIR ?? join(loadDir, ".state"));
  const manifestPath = resolve(process.env.LOADTEST_MANIFEST_PATH ?? join(stateDir, `${runId}.json`));
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  try { await readFile(manifestPath); throw new Error("Manifest already exists. Use a new LOADTEST_RUN_ID; this bootstrap never overwrites session credentials."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  const guardConnection = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, connect_timeout: 10 });
  let markerExists = false;
  try {
    const rows = await guardConnection<{ environment: string }[]>`SELECT environment FROM public.loadtest_environment_guard WHERE id = true`;
    markerExists = rows.length === 1 && rows[0].environment === "isolated-load-test";
  } finally { await guardConnection.end(); }
  if (!markerExists) throw new Error("The target database lacks the required isolated-load-test guard row; bootstrap stopped before creating accounts.");

  const runtime = ManagedRuntime.make(Layer.mergeAll(InfrastructureLive, PasswordsLive));
  const prefix = randomBytes(5).toString("hex");
  let registrationWindowStarted = Date.now();
  let registrationsInWindow = 0;
  const paceRegistration = async () => {
    if (registrationsInWindow >= 100) {
      const waitMs = Math.max(0, registrationWindowStarted + 61_000 - Date.now());
      if (waitMs) {
        console.log(`Registration rate guard: waiting ${Math.ceil(waitMs / 1000)}s before the next isolated setup batch.`);
        await delay(waitMs);
      }
      registrationWindowStarted = Date.now();
      registrationsInWindow = 0;
    }
    registrationsInWindow += 1;
  };
  const createAccount = async (input: { username: string; displayName: string; role: "teacher" | "student"; joinCode?: string }) => {
    await paceRegistration();
    return runtime.runPromise(register({ ...input, passphrase: randomUUID() }));
  };

  try {
    const teacher = await createAccount({ username: `ltteacher${prefix}`, displayName: "Isolated Load Test Teacher", role: "teacher" });
    const classroom = await runtime.runPromise(createClass(teacher.token, { name: `Load test ${prefix}` }));
    const assignments: Record<string, { assignmentVersionId: string; questionId: string }> = {};
    for (const cohort of cohorts.cohorts) {
      const assignment = await runtime.runPromise(publishPractice(teacher.token));
      const problem = assignment.problems[0];
      if (!problem) throw new Error(`Published assignment ${cohort.id} has no question.`);
      assignments[cohort.id] = { assignmentVersionId: assignment.id, questionId: problem.id };
    }

    const manifest: {
      version: 1; runId: string; generatedAt: string; teacher: { id: string; token: string };
      classroom: { id: string }; assignments: Record<string, { assignmentVersionId: string; questionId: string }>;
      students: { index: number; id: string; token: string }[];
    } = {
      version: 1, runId, generatedAt: new Date().toISOString(), teacher: { id: teacher.user.id, token: teacher.token },
      classroom: { id: classroom.id }, assignments, students: [],
    };
    const saveManifest = async () => {
      const temporary = `${manifestPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      await (await import("node:fs/promises")).rename(temporary, manifestPath);
      await (await import("node:fs/promises")).chmod(manifestPath, 0o600);
    };
    await saveManifest();
    for (let index = 0; index < cohorts.student_accounts; index += 1) {
      const student = await createAccount({
        username: `lt${prefix}${index.toString(36)}`,
        displayName: `Load Student ${index + 1}`,
        role: "student",
        joinCode: classroom.joinCode,
      });
      manifest.students.push({ index, id: student.user.id, token: student.token });
      if (manifest.students.length % 10 === 0 || index === cohorts.student_accounts - 1) {
        await saveManifest();
        if (manifest.students.length % 100 === 0 || index === cohorts.student_accounts - 1) {
          console.log(`Provisioned ${manifest.students.length}/${cohorts.student_accounts} isolated student sessions.`);
        }
      }
    }
    console.log(`Load-test setup complete. Private session manifest: ${manifestPath}`);
  } finally {
    await runtime.dispose();
  }
}

main().catch(() => {
  console.error("Load-test bootstrap stopped. Check the isolated database, schema guard, and rate-limit window; no credentials were logged.");
  process.exitCode = 1;
});
