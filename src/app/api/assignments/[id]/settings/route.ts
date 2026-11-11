import { Effect } from "effect";
import { setDraftVisibility } from "../../../../../grading/application";
import { api, jsonBody } from "../../../../../server/http";
import { sessionToken } from "../../../../../server/session";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await sessionToken(), id = (await params).id;
  return api(jsonBody(request).pipe(Effect.flatMap((body) => setDraftVisibility(token, id, body)), Effect.as({ saved: true })), true);
}
