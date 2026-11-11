import { Effect, Layer } from "effect";
import { GradingConfig } from "./config";
import { MockOCRLive, MockTextGradingLive } from "./mock-providers";
import { OpenRouterOCRLive, OpenRouterTextGradingLive, OpenRouterTransportLive } from "./openrouter";

// Construct only the selected branches. Mock mode never requires a key or makes HTTP calls.
export const ProvidersLive = Layer.unwrapEffect(Effect.gen(function* () {
  const config = yield* GradingConfig;
  const ocr = config.ocrProvider === "mock" ? MockOCRLive : OpenRouterOCRLive.pipe(Layer.provide(OpenRouterTransportLive));
  const grading = config.gradingProvider === "mock" ? MockTextGradingLive : OpenRouterTextGradingLive.pipe(Layer.provide(OpenRouterTransportLive));
  return Layer.merge(ocr, grading);
}));
