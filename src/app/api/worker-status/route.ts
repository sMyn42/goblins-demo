import { createHash, timingSafeEqual } from "node:crypto";
import { Effect } from "effect";
import { runtime } from "../../../server/runtime";
import { WorkerHeartbeats } from "../../../worker/heartbeat-store";

export async function GET(request: Request) {
  // This is operator telemetry, not a student/teacher data endpoint. Disabled unless configured.
  const expected = process.env.WORKER_MONITOR_TOKEN;
  if (!expected || expected.length < 32) return Response.json({ error: "Worker monitoring is not configured." }, { status: 503 });
  const supplied = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(expected), digest(supplied))) return Response.json({ error: "Not authorized." }, { status: 401 });
  try {
    const workers = await runtime.runPromise(Effect.flatMap(WorkerHeartbeats, (registry) => registry.list).pipe(Effect.timeout("3 seconds")));
    return Response.json({ workers, readyWorkers: workers.filter((worker) => worker.ready).length, freshWorkers: workers.filter((worker) => worker.fresh).length,
      waitingOCR: workers.filter((worker) => worker.fresh).reduce((sum, worker) => sum + worker.snapshot.waitingOCR, 0),
      waitingGrading: workers.filter((worker) => worker.fresh).reduce((sum, worker) => sum + worker.snapshot.waitingGrading, 0),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch { return Response.json({ error: "Worker telemetry unavailable." }, { status: 503 }); }
}
