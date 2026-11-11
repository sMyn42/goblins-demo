import "../src/server/env";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { Effect, Layer, ManagedRuntime } from "effect";
import { sql } from "drizzle-orm";
import { InfrastructureLive, DatabaseLive, DatabaseConnection } from "../src/server/database";
import { PasswordsLive } from "../src/server/passwords";
import { PrivateStorageLive } from "../src/storage/service";
import { GradingConfigLive } from "../src/grading/config";
import { ProvidersLive } from "../src/grading/providers";
import { SubmissionRepository } from "../src/grading/ports";
import { register } from "../src/core/auth";
import { createClass } from "../src/core/classrooms";
import { publishPractice, submitImage } from "../src/grading/application";
import { runBatch } from "../src/grading/worker";
import { rows } from "../src/db/queue";

function syntheticWork() {
  const font: Record<string, string[]> = {
    x: ["10001","01010","00100","00100","00100","01010","10001"],
    "+": ["00000","00100","00100","11111","00100","00100","00000"],
    "-": ["00000","00000","00000","11111","00000","00000","00000"],
    "=": ["00000","00000","11111","00000","11111","00000","00000"],
    "3": ["11110","00001","00001","01110","00001","00001","11110"],
    "4": ["00010","00110","01010","10010","11111","00010","00010"],
    "7": ["11111","00001","00010","00100","01000","01000","01000"],
  };
  const image = new PNG({ width: 700, height: 230 }); image.data.fill(255);
  for (const [line, text] of ["x + 3 = 7", "x = 7 - 3", "x = 4"].entries()) {
    for (const [column, char] of [...text].entries()) for (const [y, row] of (font[char] ?? []).entries()) for (const [x, pixel] of [...row].entries()) if (pixel === "1") {
      for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) {
        const offset = ((20 + line * 60 + y * 5 + dy) * image.width + 20 + column * 30 + x * 5 + dx) * 4;
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 0;
      }
    }
  }
  return PNG.sync.write(image);
}
if (process.env.ALLOW_LIVE_SMOKE !== "1") {
  console.log("No inference performed. Explicitly opt in with ALLOW_LIVE_SMOKE=1 and a dedicated migrated TEST_DATABASE_URL ending in _live_smoke. This makes paid Gemini/OpenAI calls using the existing server key.");
} else {
  const target = process.env.TEST_DATABASE_URL;
  if (!target || !new URL(target).pathname.endsWith("_live_smoke")) throw new Error("Use a dedicated database ending in _live_smoke, not a classroom or shared load-test database.");
  process.env.DATABASE_URL = target;
  process.env.APP_MODE = "normal"; process.env.OCR_PROVIDER = "openrouter"; process.env.GRADING_PROVIDER = "openrouter";
  process.env.STORAGE_PROVIDER = "local"; process.env.LOCAL_STORAGE_PATH = ".data/live-smoke-images";
  process.env.WORKER_MAX_ATTEMPTS = "1"; process.env.WORKER_CONCURRENCY = "1";
  const services = Layer.mergeAll(InfrastructureLive, DatabaseLive, PasswordsLive, ProvidersLive).pipe(Layer.provideMerge(PrivateStorageLive), Layer.provideMerge(GradingConfigLive));
  const runtime = ManagedRuntime.make(services);
  let failure = "configuration_or_connectivity";
  try {
    const report = await runtime.runPromise(Effect.gen(function* () {
      const { db } = yield* DatabaseConnection;
      const queued = rows<{ total: number }>(yield* Effect.promise(() => db.execute(sql`SELECT count(*)::integer AS total FROM pgmq.q_grading_jobs`)))[0].total;
      if (queued !== 0) return yield* Effect.fail(new Error("Dedicated smoke queue must be empty."));
      const suffix = randomBytes(4).toString("hex");
      const teacher = yield* register({ username: `smoke_t_${suffix}`, displayName: "Synthetic inference smoke", role: "teacher", passphrase: randomUUID() });
      const classroom = yield* createClass(teacher.token, { name: "Synthetic inference check" });
      const assignment = yield* publishPractice(teacher.token);
      const student = yield* register({ username: `smoke_s_${suffix}`, displayName: "Synthetic work", role: "student", passphrase: randomUUID(), joinCode: classroom.joinCode });
      const id = yield* submitImage(student.token, { questionId: assignment.problems[0].id, idempotencyKey: randomUUID() }, syntheticWork());
      yield* runBatch;
      const view = yield* (yield* SubmissionRepository).forClass(classroom.id);
      const item = view.find((entry) => entry.id === id)!;
      failure = item.failureCode ?? "unexpected_known_answer_result";
      const result = {
        kind: "paid-synthetic-smoke-not-quality-benchmark", status: item.status,
        ocrProvider: item.extractedAnswer?.ocrProvider, ocrModel: item.extractedAnswer?.ocrModel,
        gradingProvider: item.draftGrade?.provider, gradingModel: item.draftGrade?.model,
        score: item.draftGrade?.totalScore, attempts: item.attempts,
        syntheticTranscription: item.extractedAnswer?.fullText, failure: item.failureCode,
      };
      yield* Effect.promise(async () => { await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/live-smoke-report.json", JSON.stringify(result, null, 2)); });
      if (item.status !== "waiting_for_teacher" || item.extractedAnswer?.ocrProvider !== "openrouter" || item.draftGrade?.provider !== "openrouter" || item.draftGrade.totalScore !== 10) return yield* Effect.fail(new Error("Live smoke failed"));
      return result;
    }));
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error(`Live inference smoke failed: ${failure}. No fabricated grade or secret was logged. Inspect the synthetic records/artifacts and provider configuration.`);
    process.exitCode = 1;
  } finally { await runtime.dispose(); }
}
