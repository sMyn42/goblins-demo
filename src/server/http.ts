import "server-only";
import { Effect } from "effect";
import { headers } from "next/headers";
import type { AppError } from "../core/errors";
import { InvalidInput } from "../core/errors";
import type { Store, Passwords } from "../core/ports";
import type { SubmissionRepository } from "../grading/ports";
import type { PrivateStorage } from "../storage/service";
import { runtime } from "./runtime";
import { readLimitedBody } from "./limited-body";

export async function sameOrigin() {
  const origin = (await headers()).get("origin");
  const configured = process.env.APP_ORIGIN ?? (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : undefined);
  try { return Boolean(configured && origin === new URL(configured).origin); } catch { return false; }
}
export async function api<A>(program: Effect.Effect<A, AppError, Store | Passwords | SubmissionRepository | PrivateStorage>, mutation = false) {
  if (mutation && !await sameOrigin()) return Response.json({ error: "Request origin not accepted." }, { status: 403 });
  try {
    const result = await runtime.runPromise(program.pipe(Effect.either));
    if (result._tag === "Right") return Response.json(result.right, { headers: { "Cache-Control": "private, no-store" } });
    const error = result.left;
    const status = error._tag === "Unauthenticated" ? 401 : error._tag === "Forbidden" ? 403 : error._tag === "Conflict" ? 409 : error._tag === "InvalidInput" ? 400 : error._tag === "RateLimited" ? 429 : 503;
    const message = error._tag === "InvalidInput" || error._tag === "Conflict" ? error.message : status === 503 ? "Service unavailable. Please retry." : "Request not permitted.";
    if (status === 503) console.error("api_failure", { category: error._tag });
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("api_failure", { category: "unexpected" });
    return Response.json({ error: "Service unavailable. Please retry." }, { status: 503 });
  }
}
export const jsonBody = (request: Request, limit = 64000) => Effect.tryPromise({
  try: async () => JSON.parse(new TextDecoder().decode(await readLimitedBody(request.body, limit))) as unknown,
  catch: () => new InvalidInput({ message: `Send a valid JSON request smaller than ${Math.floor(limit / 1024)} KB.` }),
});
