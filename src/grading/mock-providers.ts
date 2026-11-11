import { createHash, randomUUID } from "node:crypto";
import { Clock, Effect, Layer } from "effect";
import { ConfigurationError } from "../core/errors";
import { GradingConfig, type GradingSettings } from "./config";
import { ProviderFailure, validateGrade, validateOCR } from "./contracts";
import { COMPLETE_WORK, GRADING_FIXTURES, PRACTICE_PROMPT } from "./fixtures";
import { OCRProvider, TextGradingProvider } from "./ports";

const uniform = (seed: string) => (createHash("sha256").update(seed).digest().readUInt32BE(0) + 1) / 4294967297;
// Seeded log-normal latency; long tails are independent of deterministic fixture scores.
export const mockDelay = (id: string, stage: string, config: GradingSettings) => {
  const fixed = stage === "ocr" ? config.fixedMockOcrMs : config.fixedMockGradingMs;
  if (fixed >= 0) return fixed;
  const key = `${config.mockSeed}:${id}:${stage}`;
  const normal = Math.sqrt(-2 * Math.log(uniform(key))) * Math.cos(2 * Math.PI * uniform(`${key}:tail`));
  return Math.min(config.mockLatencyMs * 20, Math.round(config.mockLatencyMs * Math.exp(normal * 0.8)));
};
const behavior = (id: string, stage: "ocr" | "grading", attempt: number, config: GradingSettings) => Effect.gen(function* () {
  yield* Effect.sleep(mockDelay(id, stage, config));
  const selected = uniform(`${config.mockSeed}:${id}:${stage}:failure`) < config.failureRate;
  if (!selected || config.failureMode === "none") return;
  if (config.failureMode === "transient" && attempt > 1) return;
  if (config.failureMode === "timeout") yield* Effect.never;
  if (config.failureMode === "transient") return yield* new ProviderFailure({ stage, code: "rate_limited", retryable: true });
  if (config.failureMode === "permanent") return yield* new ProviderFailure({ stage, code: "unavailable", retryable: false });
  return "malformed" as const;
});

export const MockOCRLive = Layer.effect(OCRProvider, Effect.gen(function* () {
  const config = yield* GradingConfig;
  if (config.ocrProvider !== "mock") return yield* new ConfigurationError({ message: "Mock OCR Layer was selected with a non-mock configuration." });
  return OCRProvider.of({ extract: (request) => Effect.gen(function* () {
    const behaviorResult = yield* behavior(request.submissionId, "ocr", request.attempt ?? 1, config);
    // Image mocks return a documented fixture, never claim to transcribe the actual image.
    const text = request.source.type === "typed" ? request.source.text : COMPLETE_WORK;
    const answer = {
      id: randomUUID(), problemSubmissionId: request.submissionId,
      lines: text.split(/\r?\n/).map((line, index) => ({ index, text: line, kind: line.includes("=") ? "equation" as const : "text" as const, confidence: 1 })),
      fullText: text.replaceAll("\r\n", "\n"),
      ...(request.source.type === "image" ? { sourceImageObjectKey: request.source.objectKey } : {}),
      ocrProvider: "mock", ocrModel: "fixture-ocr-v1", createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    };
    return yield* validateOCR(behaviorResult === "malformed" ? { lines: "invalid" } : answer, request);
  }) });
}));

export const MockTextGradingLive = Layer.effect(TextGradingProvider, Effect.gen(function* () {
  const config = yield* GradingConfig;
  if (config.gradingProvider !== "mock") return yield* new ConfigurationError({ message: "Mock grading Layer was selected with a non-mock configuration." });
  return TextGradingProvider.of({ grade: (request) => Effect.gen(function* () {
    const behaviorResult = yield* behavior(request.answer.problemSubmissionId, "grading", request.attempt ?? 1, config);
    const fixture = GRADING_FIXTURES.find((candidate) => candidate.text === request.answer.fullText.trim());
    if (request.question.prompt !== PRACTICE_PROMPT || !fixture || request.question.criteria.length !== 2
      || !request.question.criteria.some((c) => c.id === "final-answer" && c.maxPoints === 4)
      || !request.question.criteria.some((c) => c.id === "working" && c.maxPoints === 6)) {
      return yield* new ProviderFailure({ stage: "grading", code: "unsupported_input", retryable: false });
    }
    const answerScore = fixture.answer;
    const workScore = fixture.working;
    const result = {
      criterionResults: request.question.criteria.map((criterion) => ({
        criterionId: criterion.id, score: criterion.id === "final-answer" ? answerScore : workScore,
        explanation: fixture ? fixture.feedback : "No matching mock fixture; this is not a model judgment. Teacher review is required.",
        evidenceLineIndices: fixture ? request.answer.lines.map((line) => line.index) : [],
      })),
      totalScore: answerScore + workScore,
      feedback: fixture?.feedback ?? "Unrecognized fixture. This mock output must not be used as a real grade.",
      confidence: fixture?.confidence ?? 0, reviewRequired: true,
      reviewReason: "Mock result. Every grade requires explicit teacher approval.", provider: "mock", model: "fixture-grader-v1",
    };
    return yield* validateGrade(behaviorResult === "malformed" ? { totalScore: 99999 } : result, request);
  }) });
}));
export const MockProvidersLive = Layer.merge(MockOCRLive, MockTextGradingLive);
