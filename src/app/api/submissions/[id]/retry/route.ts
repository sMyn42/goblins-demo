import { Effect } from "effect";
import { retrySubmission } from "../../../../../grading/application";
import { api } from "../../../../../server/http";
import { sessionToken } from "../../../../../server/session";
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(retrySubmission(await sessionToken(), (await params).id).pipe(Effect.as({ retrying: true })), true);
}
