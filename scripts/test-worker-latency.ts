import "../src/server/env";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Effect, Layer, ManagedRuntime } from "effect";
import { sql } from "drizzle-orm";
import { InfrastructureLive, DatabaseLive, DatabaseConnection } from "../src/server/database";
import { PasswordsLive } from "../src/server/passwords";
import { register } from "../src/core/auth";
import { createClass } from "../src/core/classrooms";
import { publishPractice, submitAnswer } from "../src/grading/application";
import { SubmissionRepository } from "../src/grading/ports";
import { COMPLETE_WORK } from "../src/grading/fixtures";
import { WorkerHeartbeats } from "../src/worker/heartbeat-store";
import { rows } from "../src/db/queue";
import type { WorkerSnapshot } from "../src/worker/health";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to an isolated migrated database; no production/shared queue.");
const latencyMs = Number(process.env.LATENCY_TEST_MS ?? 150000);
if (!Number.isInteger(latencyMs) || latencyMs < 8000 || latencyMs > 300000) throw new Error("LATENCY_TEST_MS must be 8000..300000 (default 150000).");
process.env.DATABASE_URL = url;
const runtime = ManagedRuntime.make(Layer.mergeAll(InfrastructureLive, DatabaseLive, PasswordsLive));
let worker: ChildProcess | undefined, queueRenamed = false;
const base = "http://localhost:3140";
const samples: { elapsedMs: number; http: number; snapshot: WorkerSnapshot }[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<A>(read: () => Promise<A>, valid: (value: A) => boolean, timeout = 15000): Promise<A> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const value = await read(); if (valid(value)) return value; } catch { /* Startup/network transitions are bounded by the deadline. */ } await sleep(150); }
  throw new Error("Latency assertion timed out");
}
const execute = (statement: ReturnType<typeof sql>) => runtime.runPromise(Effect.flatMap(DatabaseConnection, ({ db }) => Effect.promise(() => db.execute(statement))));
async function ready() { const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2000) }); return { http: response.status, snapshot: await response.json() as WorkerSnapshot & { instanceId: string } }; }
try {
  if (rows<{ total: number }>(await execute(sql`SELECT count(*)::integer AS total FROM pgmq.q_grading_jobs`))[0].total !== 0) throw new Error("Isolated queue must be empty");
  // Verify the new schema before accepting test work or launching the worker.
  await runtime.runPromise(Effect.flatMap(WorkerHeartbeats, (store) => store.list));
  const data = await runtime.runPromise(Effect.gen(function* () {
    const suffix = randomBytes(4).toString("hex");
    const teacher = yield* register({ username: `latency_t_${suffix}`, displayName: "Synthetic latency teacher", role: "teacher", passphrase: randomUUID() });
    const classroom = yield* createClass(teacher.token, { name: "Worker latency test" });
    const assignment = yield* publishPractice(teacher.token);
    const student = yield* register({ username: `latency_s_${suffix}`, displayName: "Synthetic latency work", role: "student", passphrase: randomUUID(), joinCode: classroom.joinCode });
    const submissionId = yield* submitAnswer(student.token, { questionId: assignment.questionId, idempotencyKey: randomUUID(), text: COMPLETE_WORK });
    return { submissionId, classId: classroom.id };
  }));
  worker = spawn(process.execPath, ["dist/worker.mjs"], { stdio: "ignore", env: {
    ...process.env, DATABASE_URL: url, APP_MODE: "test", OCR_PROVIDER: "mock", GRADING_PROVIDER: "mock", PORT: "3140",
    MOCK_FIXED_OCR_LATENCY_MS: String(latencyMs), MOCK_FIXED_GRADING_LATENCY_MS: "0", MOCK_FAILURE_MODE: "none", MOCK_FAILURE_RATE: "0",
    OCR_TIMEOUT_MS: String(latencyMs + 10000), GRADING_TIMEOUT_MS: "10000", WORKER_LEASE_SECONDS: String(Math.ceil((latencyMs + 30000) / 1000)),
    WORKER_POLL_MS: "100", WORKER_HEARTBEAT_INTERVAL_MS: "500", WORKER_PROBE_TIMEOUT_MS: "500", WORKER_HEARTBEAT_STALE_MS: "3000", WORKER_INTERNAL_STALL_MS: "5000",
    STORAGE_PROVIDER: "local", LOCAL_STORAGE_PATH: ".data/latency-images",
  } });
  const first = await waitFor(ready, (value) => value.http === 200 && value.snapshot.waitingOCR === 1);
  const instanceId = first.snapshot.instanceId, started = Date.now();
  let observedUnready = false, recovered = false;
  console.log(`Holding a mock OCR call for ${latencyMs} ms through the real worker/pgmq path; no inference charges.`);
  while (Date.now() - started < latencyMs + 15000) {
    const elapsedMs = Date.now() - started;
    if (!queueRenamed && !observedUnready && elapsedMs >= latencyMs / 3) {
      await execute(sql`ALTER TABLE pgmq.q_grading_jobs RENAME TO latency_test_unavailable`); queueRenamed = true;
      const outage = await waitFor(ready, (value) => value.http === 503 && value.snapshot.reason === "queue_unavailable", 4000);
      if (outage.snapshot.waitingOCR !== 1 || (await fetch(`${base}/health`)).status !== 200) throw new Error("Provider wait/liveness was lost during queue outage");
      samples.push({ elapsedMs: Date.now() - started, ...outage });
      await waitFor(() => runtime.runPromise(Effect.flatMap(WorkerHeartbeats, (store) => store.list)), (workers) => workers.some((entry) => entry.id === instanceId && entry.fresh && !entry.ready && entry.snapshot.waitingOCR === 1), 4000);
      observedUnready = true;
      await execute(sql`ALTER TABLE pgmq.latency_test_unavailable RENAME TO q_grading_jobs`); queueRenamed = false;
      await waitFor(ready, (value) => value.http === 200 && value.snapshot.waitingOCR === 1, 4000); recovered = true;
      console.log("Readiness failed on real queue unavailability, then recovered while the same OCR call was still waiting.");
    }
    const value = await ready(); samples.push({ elapsedMs, ...value });
    if (value.http !== 200) throw new Error("Healthy provider wait caused false unready");
    const fleet = await runtime.runPromise(Effect.flatMap(WorkerHeartbeats, (store) => store.list));
    const report = fleet.find((entry) => entry.id === instanceId);
    if (!report?.fresh) throw new Error("Main service lost the progress keepalive");
    const [item] = await runtime.runPromise(Effect.flatMap(SubmissionRepository, (repo) => repo.forClass(data.classId)));
    if (item.status === "waiting_for_teacher" && value.snapshot.activeJobs === 0) break;
    if (["permanent_failure", "retryable_failure"].includes(item.status)) throw new Error("Latency caused a processing failure");
    await sleep(500);
  }
  const completed = await waitFor(async () => {
    const [item] = await runtime.runPromise(Effect.flatMap(SubmissionRepository, (repo) => repo.forClass(data.classId)));
    const stats = rows<{ grades: number; reads: number | null }>(await execute(sql`SELECT (SELECT count(*)::integer FROM grades WHERE submission_id = ${data.submissionId}::uuid) AS grades, (SELECT max(read_ct) FROM pgmq.a_grading_jobs WHERE message->>'submissionId' = ${data.submissionId}) AS reads`))[0];
    return { item, stats };
  }, ({ item, stats }) => item.status === "waiting_for_teacher" && stats.reads === 1);
  if (!observedUnready || !recovered || completed.item.attempts !== 1 || completed.stats.grades !== 1 || completed.item.draftGrade?.totalScore !== 10) throw new Error("Latency correctness invariant failed");
  const report = { mockLatencyMs: latencyMs, exercisedBeyond120Seconds: samples.some((sample) => (sample.snapshot.oldestProviderWaitMs ?? 0) > 120000),
    queueOutageDetected: observedUnready, readinessRecoveredDuringSameCall: recovered, attempts: completed.item.attempts, logicalGrades: completed.stats.grades, queueReadCount: completed.stats.reads, samples };
  await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/worker-latency-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, samples: `${samples.length} samples saved to artifacts/worker-latency-report.json` }, null, 2));
} catch {
  console.error("Worker latency test failed. Inspect the dedicated test DB, port 3140 and worker health configuration. No student work or credentials were logged."); process.exitCode = 1;
} finally {
  if (queueRenamed) { try { await execute(sql`ALTER TABLE pgmq.latency_test_unavailable RENAME TO q_grading_jobs`); } catch { console.error("Restore pgmq.latency_test_unavailable to q_grading_jobs in the test DB before reusing it."); } }
  if (worker && worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, "exit"); worker.kill("SIGTERM"); await exited; }
  await runtime.dispose();
}
