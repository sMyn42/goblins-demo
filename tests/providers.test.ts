import { randomUUID } from "node:crypto";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { gradingConfig, GradingConfig } from "../src/grading/config";
import { GradeResult, validateGrade, validateOCR, type Question, type GradingRequest } from "../src/grading/contracts";
import { COMPLETE_WORK, PRACTICE_CRITERIA, PRACTICE_PROMPT, GRADING_FIXTURES } from "../src/grading/fixtures";
import { MockProvidersLive, mockDelay } from "../src/grading/mock-providers";
import { OCRProvider, TextGradingProvider } from "../src/grading/ports";
import { makeOpenRouterTransport, OpenRouterOCRLive, OpenRouterTextGradingLive, OpenRouterTransport } from "../src/grading/openrouter";
import { PrivateStorage, PrivateStorageLive, validateImage } from "../src/storage/service";
import { evaluateCriteria } from "../src/grading/deterministic";

const config = Effect.runSync(gradingConfig.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["APP_MODE", "test"], ["OCR_PROVIDER", "mock"], ["GRADING_PROVIDER", "mock"]])))));
const question: Question = { id: randomUUID(), assignmentVersionId: randomUUID(), rubricVersionId: randomUUID(), prompt: PRACTICE_PROMPT, expectedAnswers: ["4"], maxPoints: 10, teacherSolution: COMPLETE_WORK, criteria: PRACTICE_CRITERIA };
const submissionId = randomUUID();
const extracted = { id: randomUUID(), problemSubmissionId: submissionId, fullText: COMPLETE_WORK, lines: COMPLETE_WORK.split("\n").map((text, index) => ({ index, text, kind: "equation" as const, confidence: 1 })), createdAt: new Date().toISOString(), ocrProvider: "typed", ocrModel: "none" };
const request: GradingRequest = { question, answer: extracted, deterministicEvidence: [] };
const valid: GradeResult = { criterionResults: [{ criterionId: "final-answer", score: 4, explanation: "Correct", evidenceLineIndices: [2] }, { criterionId: "working", score: 6, explanation: "Correct", evidenceLineIndices: [1] }], totalScore: 10, feedback: "Correct", confidence: 1, reviewRequired: true, reviewReason: "Teacher approval", provider: "test", model: "test" };
const storage = PrivateStorage.of({ put: () => Effect.void, remove: () => Effect.void, get: () => Effect.succeed(new Uint8Array([1, 2, 3])) });
const modelLayer = (fetcher: typeof fetch) => Layer.mergeAll(Layer.succeed(GradingConfig, { ...config, ocrProvider: "openrouter", gradingProvider: "openrouter", gradingModel: "openai/test-model" }), Layer.succeed(OpenRouterTransport, makeOpenRouterTransport(Redacted.make("test-key-not-a-secret"), fetcher)), Layer.succeed(PrivateStorage, storage));
const completion = (content: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }), { status: 200 });

describe("shared canonical schemas and provider parity", () => {
  for (const fixture of GRADING_FIXTURES) it(`mock oracle scores known fixture: ${fixture.answer + fixture.working}`, async () => {
    const program = Effect.gen(function* () {
      const answer = yield* (yield* OCRProvider).extract({ submissionId, source: { type: "typed", text: fixture.text } });
      return yield* (yield* TextGradingProvider).grade({ question, answer, deterministicEvidence: [] });
    }).pipe(Effect.provide(MockProvidersLive.pipe(Layer.provide(Layer.succeed(GradingConfig, { ...config, mockLatencyMs: 0 })))));
    const result = await Effect.runPromise(program);
    expect(result.totalScore).toBe(fixture.answer + fixture.working);
    expect(result.reviewRequired).toBe(true);
  });
  it("chooses reproducible, varied OCR fixtures for canvas submissions", async () => {
    const mockConfig = { ...config, ocrProvider: "mock" as const, gradingProvider: "mock" as const, mockLatencyMs: 0, mockSeed: 42 };
    const layer = MockProvidersLive.pipe(Layer.provide(Layer.succeed(GradingConfig, mockConfig)));
    const ids = Array.from({ length: 50 }, () => randomUUID());
    const extract = (id: string) => Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* OCRProvider).extract({ submissionId: id, source: { type: "image", objectKey: `students/test/${id}.png` } });
    }).pipe(Effect.provide(layer)));
    const answers = await Promise.all(ids.map(extract));
    expect(new Set(answers.map((answer) => answer.fullText)).size).toBeGreaterThan(1);
    expect(answers.every((answer) => GRADING_FIXTURES.some((fixture) => fixture.text === answer.fullText))).toBe(true);
    expect((await extract(ids[0])).fullText).toBe(answers[0].fullText);
  });
  it("rejects excessive, invented, missing, duplicate, inconsistent scores and invented evidence", async () => {
    const invalids = [
      { ...valid, totalScore: 99 },
      { ...valid, criterionResults: [{ ...valid.criterionResults[0], score: 5 }, valid.criterionResults[1]], totalScore: 11 },
      { ...valid, criterionResults: [{ ...valid.criterionResults[0], criterionId: "invented" }, valid.criterionResults[1]] },
      { ...valid, criterionResults: [valid.criterionResults[0]] },
      { ...valid, criterionResults: [valid.criterionResults[0], valid.criterionResults[0]], totalScore: 8 },
      { ...valid, criterionResults: [{ ...valid.criterionResults[0], evidenceLineIndices: [99] }, valid.criterionResults[1]] },
      { ...valid, confidence: 2 }, { ...valid, criterionResults: [{ ...valid.criterionResults[0], score: -1 }, valid.criterionResults[1]] },
    ];
    for (const raw of invalids) expect(await Effect.runPromise(validateGrade(raw, request).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { code: "invalid_output" } });
  });
  it("rejects missing/misordered OCR lines and wrong submission bindings", async () => {
    for (const raw of [{ ...extracted, lines: [] }, { ...extracted, problemSubmissionId: randomUUID() }, { ...extracted, fullText: "invented" }, { ...extracted, lines: [{ ...extracted.lines[0], index: 3 }] }]) {
      expect(await Effect.runPromise(validateOCR(raw, { submissionId, source: { type: "typed", text: COMPLETE_WORK } }).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
    }
  });
  it("live text adapter uses OpenRouter request format and canonical grade validation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completion(valid));
    const result = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* TextGradingProvider).grade(request); }).pipe(Effect.provide(OpenRouterTextGradingLive.pipe(Layer.provide(modelLayer(fetcher))))));
    expect(result).toMatchObject({ totalScore: 10, provider: "openrouter", model: "openai/test-model" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "openai/test-model", response_format: { type: "json_object" }, max_tokens: config.gradingMaxTokens });
    expect(body).not.toHaveProperty("temperature"); // GPT-6 Luna does not support temperature.
    expect(body.messages[0].content).toContain("UNTRUSTED DATA");
    expect(JSON.parse(body.messages[1].content).student_work.fullText).toBe(COMPLETE_WORK);
  });
  it("live OCR sends private image bytes and normalizes to the same OCR schema", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completion({ lines: extracted.lines, fullText: COMPLETE_WORK }));
    const imageKey = `students/${randomUUID()}/${randomUUID()}.png`;
    const result = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* OCRProvider).extract({ submissionId, source: { type: "image", objectKey: imageKey } }); }).pipe(Effect.provide(OpenRouterOCRLive.pipe(Layer.provide(modelLayer(fetcher))))));
    expect(result).toMatchObject({ problemSubmissionId: submissionId, ocrProvider: "openrouter", sourceImageObjectKey: imageKey, fullText: COMPLETE_WORK });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.messages[1].content[1].image_url.url).toBe("data:image/png;base64,AQID");
  });
  it("typed live OCR bypasses inference instead of paying to transcribe text", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* OCRProvider).extract({ submissionId, source: { type: "typed", text: COMPLETE_WORK } }); }).pipe(Effect.provide(OpenRouterOCRLive.pipe(Layer.provide(modelLayer(fetcher))))));
    expect(result.ocrProvider).toBe("typed"); expect(fetcher).not.toHaveBeenCalled();
  });
  for (const status of [429, 503, 401]) it(`classifies HTTP ${status} without exposing response bodies`, async () => {
    const transport = makeOpenRouterTransport(Redacted.make("hidden"), async () => new Response("sensitive provider body", { status }));
    const result = await Effect.runPromise(transport.chat({ stage: "grading", model: "openai/test", maxTokens: 256, messages: [] }).pipe(Effect.either));
    expect(result).toMatchObject({ _tag: "Left", left: { retryable: status !== 401, code: status === 429 ? "rate_limited" : status === 401 ? "unauthorized" : "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("sensitive provider body");
  });
  it("propagates Retry-After for queue-level backoff", async () => {
    const transport = makeOpenRouterTransport(Redacted.make("hidden"), async () => new Response("", { status: 429, headers: { "Retry-After": "30" } }));
    expect(await Effect.runPromise(transport.chat({ stage: "grading", model: "openai/test", maxTokens: 256, messages: [] }).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { retryAfterSeconds: 30 } });
  });
  it("Supabase private storage uses server-only credentials and identical object keys", async () => {
    const key = `students/${randomUUID()}/${randomUUID()}.png`;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => init?.method === "GET" ? new Response(new Uint8Array([1, 2, 3])) : new Response("{}"));
    try {
      const provider = ConfigProvider.fromMap(new Map([["STORAGE_PROVIDER", "supabase"], ["SUPABASE_URL", "https://test.supabase.co"], ["SUPABASE_SERVICE_ROLE_KEY", "test-server-key"]]));
      const result = await Effect.runPromise(Effect.gen(function* () {
        const storage = yield* PrivateStorage;
        yield* storage.put(key, new Uint8Array([1, 2, 3]));
        const bytes = yield* storage.get(key);
        yield* storage.remove(key);
        return bytes;
      }).pipe(Effect.provide(PrivateStorageLive), Effect.withConfigProvider(provider)));
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
      expect(fetcher.mock.calls[0][0]).toBe(`https://test.supabase.co/storage/v1/object/student-work/${key}`);
      expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer test-server-key", "x-upsert": "false" });
    } finally { fetcher.mockRestore(); }
  });
  it("rejects malformed and truncated completions", async () => {
    for (const response of [new Response("not json"), new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }))]) {
      const service = makeOpenRouterTransport(Redacted.make("hidden"), async () => response);
      expect(await Effect.runPromise(service.chat({ stage: "ocr", model: "google/test", maxTokens: 256, messages: [] }).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { code: "invalid_output" } });
    }
  });
  it("uses allowlisted deterministic checks but never interprets math/code unsafely", () => {
    expect(evaluateCriteria(question, extracted)[0].outcome).toBe("MATCH");
    expect(evaluateCriteria(question, { ...extracted, lines: extracted.lines.map((line) => ({ ...line, confidence: 0.2 })), ocrProvider: "openrouter" })[0].outcome).toBe("INCONCLUSIVE");
    const numericQuestion = { ...question, criteria: [{ ...question.criteria[0], evaluator: { type: "numeric" as const, answers: ["4"], tolerance: 0.01 } }] };
    expect(evaluateCriteria(numericQuestion, { ...extracted, lines: [{ ...extracted.lines[0], text: "4.001" }] })[0].outcome).toBe("MATCH");
    expect(evaluateCriteria(numericQuestion, extracted)[0].outcome).toBe("INCONCLUSIVE");
  });
  it("bounds PNG dimensions, validates CRC/data and rejects non-images", async () => {
    const png = new PNG({ width: 10, height: 10 }); png.data.fill(255);
    const bytes = PNG.sync.write(png);
    expect(await Effect.runPromise(validateImage(bytes))).toEqual(bytes);
    const bad = Buffer.from(bytes); bad.writeUInt32BE(9000, 16);
    for (const input of [bad, Buffer.from("not an image"), Buffer.alloc(3 * 1024 * 1024)]) expect(await Effect.runPromise(validateImage(input).pipe(Effect.either))).toMatchObject({ _tag: "Left" });
  });
  it("keeps seeded latency reproducible, bounded, and long-tailed", () => {
    const values = Array.from({ length: 1000 }, (_, n) => mockDelay(String(n), "ocr", config));
    expect(values).toEqual(Array.from({ length: 1000 }, (_, n) => mockDelay(String(n), "ocr", config)));
    const sorted = values.toSorted((a, b) => a - b);
    expect(sorted[990]).toBeGreaterThan(sorted[500] * 3);
    expect(sorted.at(-1)).toBeLessThanOrEqual(config.mockLatencyMs * 20);
  });
});
