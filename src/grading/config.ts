import { Config, Context, Effect, Layer } from "effect";
import { ConfigurationError } from "../core/errors";

const integer = (name: string, fallback: number, min: number, max: number) => Config.integer(name).pipe(
  Config.withDefault(fallback), Config.validate({ message: `${name} is outside its allowed range`, validation: (value) => value >= min && value <= max }),
);
export const gradingConfig = Config.all({
  appMode: Config.literal("normal", "test", "load-test")("APP_MODE").pipe(Config.withDefault("normal")),
  ocrProvider: Config.literal("mock", "openrouter")("OCR_PROVIDER").pipe(Config.withDefault("openrouter")),
  gradingProvider: Config.literal("mock", "openrouter")("GRADING_PROVIDER").pipe(Config.withDefault("openrouter")),
  ocrModel: Config.string("OPENROUTER_OCR_MODEL").pipe(Config.withDefault("google/gemini-3.5-flash")),
  gradingModel: Config.string("OPENROUTER_GRADING_MODEL").pipe(Config.withDefault("openai/gpt-6-luna")),
  concurrency: integer("WORKER_CONCURRENCY", 2, 1, 20), leaseSeconds: integer("WORKER_LEASE_SECONDS", 120, 15, 900),
  maxAttempts: integer("WORKER_MAX_ATTEMPTS", 3, 1, 10), pollMs: integer("WORKER_POLL_MS", 1000, 50, 60000),
  ocrMaxTokens: integer("OCR_MAX_TOKENS", 4096, 256, 16000), gradingMaxTokens: integer("GRADING_MAX_TOKENS", 4096, 256, 16000),
  ocrTimeoutMs: integer("OCR_TIMEOUT_MS", 15000, 10, 120000), gradingTimeoutMs: integer("GRADING_TIMEOUT_MS", 20000, 10, 120000),
  mockLatencyMs: integer("MOCK_LATENCY_MS", 500, 0, 10000),
  mockSeed: integer("MOCK_SEED", 42, 0, 2147483647),
  failureMode: Config.literal("none", "transient", "permanent", "malformed", "timeout")("MOCK_FAILURE_MODE").pipe(Config.withDefault("none")),
  failureRate: Config.number("MOCK_FAILURE_RATE").pipe(Config.withDefault(0), Config.validate({ message: "MOCK_FAILURE_RATE must be between 0 and 1", validation: (n) => n >= 0 && n <= 1 })),
});
export type GradingSettings = Config.Config.Success<typeof gradingConfig>;
export class GradingConfig extends Context.Tag("goblins/GradingConfig")<GradingConfig, GradingSettings>() {}
export const GradingConfigLive = Layer.effect(GradingConfig, Effect.gen(function* () {
  const config = yield* gradingConfig.pipe(Effect.mapError(() => new ConfigurationError({ message: "Invalid grading/worker configuration. Check the documented settings." })));
  if (config.appMode === "normal" && (config.ocrProvider === "mock" || config.gradingProvider === "mock")) return yield* new ConfigurationError({ message: "Mock providers require APP_MODE=test or APP_MODE=load-test. Normal grading uses live inference." });
  return config;
}));
