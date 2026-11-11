import { Effect } from "effect";
import { submitAnswer, submitImage } from "../../../grading/application";
import { sessionToken } from "../../../server/session";
import { api, jsonBody } from "../../../server/http";
import { readLimitedBody } from "../../../server/limited-body";
import { InvalidInput } from "../../../core/errors";
import { authenticate } from "../../../core/auth";
import { MAX_IMAGE_BYTES } from "../../../storage/service";

export async function POST(request: Request) {
  const token = await sessionToken();
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    return api(Effect.gen(function* () {
      yield* authenticate(token);
      const form = yield* Effect.tryPromise({
        try: async () => new Response(Buffer.from(await readLimitedBody(request.body, MAX_IMAGE_BYTES + 16000)), { headers: { "Content-Type": contentType } }).formData(),
        catch: () => new InvalidInput({ message: "Invalid upload or image exceeds 2 MB." }),
      });
      const file = form.get("image");
      if (!(file instanceof File) || file.type !== "image/png" || file.size > MAX_IMAGE_BYTES) return yield* new InvalidInput({ message: "Upload a PNG smaller than 2 MB." });
      const bytes = yield* Effect.promise(async () => new Uint8Array(await file.arrayBuffer()));
      const id = yield* submitImage(token, { questionId: form.get("questionId"), idempotencyKey: form.get("idempotencyKey") }, bytes);
      return { id };
    }), true);
  }
  return api(jsonBody(request).pipe(Effect.flatMap((input) => submitAnswer(token, input)), Effect.map((id) => ({ id }))), true);
}
