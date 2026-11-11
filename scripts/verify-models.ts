import "../src/server/env";
import { Effect } from "effect";
import { gradingConfig } from "../src/grading/config";

Effect.runPromise(Effect.gen(function* () {
  const config = yield* gradingConfig;
  const models = yield* Effect.tryPromise(async (signal) => {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal });
    if (!response.ok) throw new Error();
    return (await response.json()).data as { id: string; architecture?: { input_modalities?: string[] } }[];
  }).pipe(Effect.timeout("15 seconds"));
  const ocr = models.find((item) => item.id === config.ocrModel);
  if (!ocr?.architecture?.input_modalities?.includes("image")) return yield* Effect.fail(new Error("OCR model not listed with image input"));
  console.log(`OCR model verified: ${config.ocrModel} (image input)`);
  if (config.gradingModel) {
    if (!config.gradingModel.startsWith("openai/") || !models.some((item) => item.id === config.gradingModel)) return yield* Effect.fail(new Error("OpenAI grading model not listed"));
    console.log(`Text model verified: ${config.gradingModel}`);
  } else console.log("No text model configured. Set OPENROUTER_GRADING_MODEL before enabling live grading.");
})).catch(() => { console.error("Model verification failed. Check model IDs/catalog availability. No inference was performed."); process.exitCode = 1; });
