import "../src/server/env";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import benchmark from "../tests/quality/cases.json";
import { GradingConfig, GradingConfigLive } from "../src/grading/config";
import { ProvidersLive } from "../src/grading/providers";
import { PrivateStorageLive } from "../src/storage/service";
import { OCRProvider, TextGradingProvider } from "../src/grading/ports";
import { COMPLETE_WORK, PRACTICE_CRITERIA, PRACTICE_PROMPT } from "../src/grading/fixtures";
import { evaluateCriteria } from "../src/grading/deterministic";

if (process.env.ALLOW_LIVE_EVAL !== "1") {
  console.log(JSON.stringify({ status: "not_run", cases: benchmark.cases.length, humanReviewed: Boolean(benchmark.reviewedBy), reason: "No inference performed. Human-review the manifest, then explicitly set ALLOW_LIVE_EVAL=1." }, null, 2));
} else if (!benchmark.reviewedBy || !benchmark.reviewedAt) {
  console.error("No inference performed: set reviewedBy/reviewedAt in tests/quality/cases.json after human review."); process.exitCode = 1;
} else {
  const program = Effect.gen(function* () {
    const config = yield* GradingConfig;
    if (config.ocrProvider !== "openrouter" || config.gradingProvider !== "openrouter") return yield* Effect.fail(new Error("Quality evaluation requires explicit live providers"));
    const ocr = yield* OCRProvider, grading = yield* TextGradingProvider;
    const question = { id: randomUUID(), assignmentVersionId: randomUUID(), rubricVersionId: randomUUID(), prompt: PRACTICE_PROMPT, maxPoints: 10, expectedAnswers: ["4"], teacherSolution: COMPLETE_WORK, criteria: PRACTICE_CRITERIA };
    const results: { id: string; category: string; min: number; max: number; score: number | null; latencyMs: number; accepted: boolean; error: boolean }[] = [];
    for (const item of benchmark.cases) {
      const start = Date.now();
      const result = yield* Effect.either(Effect.gen(function* () {
        const answer = yield* ocr.extract({ submissionId: randomUUID(), source: { type: "typed" as const, text: item.work } });
        return yield* grading.grade({ question, answer, deterministicEvidence: evaluateCriteria(question, answer) });
      }).pipe(Effect.timeout("60 seconds")));
      const score = result._tag === "Right" ? result.right.totalScore : null;
      results.push({ id: item.id, category: item.category, min: item.min, max: item.max, score, latencyMs: Date.now() - start, accepted: score !== null && score >= item.min && score <= item.max, error: result._tag === "Left" });
    }
    const scored = results.filter((r) => r.score !== null);
    const report = {
      kind: "real-text-grading-quality", model: config.gradingModel, reviewedBy: benchmark.reviewedBy,
      count: results.length, providerFailures: results.length - scored.length,
      scoreRangeAgreement: results.filter((r) => r.accepted).length / results.length,
      meanAbsoluteErrorToRangeMidpoint: scored.length ? scored.reduce((sum, r) => sum + Math.abs(r.score! - (r.min + r.max) / 2), 0) / scored.length : null,
      falsePositiveFullCredit: results.filter((r) => r.max < 10 && r.score === 10).length,
      alternativeMethodAgreement: results.filter((r) => r.category === "alternative").map((r) => ({ id: r.id, accepted: r.accepted })),
      notes: "Text-only benchmark, not OCR quality, throughput, or cost calibration. All grades provisional. Attach a separately human-reviewed handwritten dataset to assess OCR. No measured cost claim: inspect provider billing/usage.",
      results,
    };
    yield* Effect.promise(async () => { await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/quality-report.json", JSON.stringify(report, null, 2)); });
    console.log("Saved artifacts/quality-report.json. Review failures and proposed score ranges before drawing conclusions.");
  });
  Effect.runPromise(program.pipe(Effect.provide(ProvidersLive.pipe(Layer.provide(PrivateStorageLive), Layer.provideMerge(GradingConfigLive))))).catch(() => { console.error("Quality evaluation failed. Check explicit live configuration; sensitive provider details were not logged."); process.exitCode = 1; });
}
