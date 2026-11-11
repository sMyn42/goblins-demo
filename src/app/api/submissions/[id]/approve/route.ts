import { Effect, Schema } from "effect";
import { approveSubmission } from "../../../../../grading/application";
import { decode } from "../../../../../core/contracts";
import { api, jsonBody } from "../../../../../server/http";
import { sessionToken } from "../../../../../server/session";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await sessionToken(), id = (await params).id;
  return api(jsonBody(request).pipe(Effect.flatMap((body) => decode(Schema.Struct({ revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()) }), body)), Effect.flatMap((body) => approveSubmission(token, id, body.revision)), Effect.as({ approved: true })), true);
}
