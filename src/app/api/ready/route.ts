import { Effect } from "effect";
import { runtime } from "../../../server/runtime";
import { GradingQueue } from "../../../grading/ports";
export async function GET() {
  try {
    await runtime.runPromise(Effect.flatMap(GradingQueue, (queue) => queue.ready).pipe(Effect.timeout("3 seconds")));
    return Response.json({ status: "ready" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
