import { Effect } from "effect";
import { submissionImage } from "../../../../../grading/application";
import { runtime } from "../../../../../server/runtime";
import { sessionToken } from "../../../../../server/session";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const result = await runtime.runPromise(submissionImage(await sessionToken(), (await params).id).pipe(Effect.either));
    if (result._tag === "Left") return new Response("Image unavailable", { status: result.left._tag === "StorageError" ? 503 : 403 });
    return new Response(Buffer.from(result.right), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
  } catch { return new Response("Image unavailable", { status: 503 }); }
}
