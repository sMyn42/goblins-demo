import "../src/server/env";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Effect, Layer, ManagedRuntime } from "effect";
import { count, eq } from "drizzle-orm";
import { InfrastructureLive, DatabaseLive, DatabaseConnection } from "../src/server/database";
import { PasswordsLive } from "../src/server/passwords";
import { register } from "../src/core/auth";
import { createClass } from "../src/core/classrooms";
import { publishPractice, submitAnswer } from "../src/grading/application";
import { SubmissionRepository } from "../src/grading/ports";
import { COMPLETE_WORK } from "../src/grading/fixtures";
import { grades } from "../src/db/schema";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to a dedicated, migrated PostgreSQL test database.");
process.env.DATABASE_URL = url;
const runtime = ManagedRuntime.make(Layer.mergeAll(InfrastructureLive, DatabaseLive, PasswordsLive));
let worker: ChildProcess | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<A>(read: () => Promise<A>, valid: (value: A) => boolean, maxMs: number) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) { const value = await read(); if (valid(value)) return value; await sleep(100); }
  throw new Error("Recovery check timed out");
}
function start(latency: string) {
  return spawn(process.execPath, ["dist/worker.mjs"], { stdio: "ignore", env: {
    ...process.env, APP_MODE: "test", DATABASE_URL: url, PORT: "3130", OCR_PROVIDER: "mock", GRADING_PROVIDER: "mock", MOCK_LATENCY_MS: latency,
    MOCK_FAILURE_MODE: "none", MOCK_FAILURE_RATE: "0", OCR_TIMEOUT_MS: "120000", GRADING_TIMEOUT_MS: "120000",
    WORKER_LEASE_SECONDS: "15", WORKER_POLL_MS: "100", STORAGE_PROVIDER: "local", LOCAL_STORAGE_PATH: ".data/recovery-images",
  } });
}
try {
  const data = await runtime.runPromise(Effect.gen(function* () {
    const suffix = randomBytes(4).toString("hex");
    const teacher = yield* register({ username: `recover_t_${suffix}`, displayName: "Recovery teacher", role: "teacher", passphrase: "safe recovery teacher phrase" });
    const classroom = yield* createClass(teacher.token, { name: "Recovery test" });
    const practice = yield* publishPractice(teacher.token);
    const student = yield* register({ username: `recover_s_${suffix}`, displayName: "Recovery student", role: "student", passphrase: "safe recovery student phrase", joinCode: classroom.joinCode });
    const submissionId = yield* submitAnswer(student.token, { questionId: practice.questionId, idempotencyKey: randomUUID(), text: COMPLETE_WORK });
    return { studentId: student.user.id, classId: classroom.id, submissionId };
  }));
  const view = () => runtime.runPromise(Effect.flatMap(SubmissionRepository, (repo) => repo.forClass(data.classId)));
  worker = start("10000");
  await waitFor(view, (items) => items[0]?.status === "processing", 10000);
  const crashed = once(worker, "exit"); worker.kill("SIGKILL"); await crashed;
  // Wait beyond the actual pgmq/run lease, not an in-process fake clock.
  await sleep(16000);
  worker = start("0");
  const recovered = await waitFor(view, (items) => items[0]?.status === "waiting_for_teacher", 15000);
  const logicalGrades = await runtime.runPromise(Effect.gen(function* () {
    const { db } = yield* DatabaseConnection;
    return (yield* Effect.promise(() => db.select({ value: count() }).from(grades).where(eq(grades.submissionId, data.submissionId))))[0].value;
  }));
  if (logicalGrades !== 1 || recovered[0].attempts !== 2 || recovered[0].draftGrade?.totalScore !== 10) throw new Error("Recovery invariant failed");
  const report = { acceptedWorkRecovered: true, logicalGrades, attempts: recovered[0].attempts, finalStatus: recovered[0].status, providerMode: "mock", workerKilledWith: "SIGKILL" };
  await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/recovery-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error("Worker recovery check failed. Check test DB migration, worker bundle, port 3130, and durable submission status. Test records are retained; no secrets were logged.");
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, "exit"); worker.kill("SIGTERM"); await exited; }
  await runtime.dispose();
}
