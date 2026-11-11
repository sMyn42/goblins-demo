import { Effect } from "effect";
import { practiceOverview, publishPractice } from "../../../grading/application";
import { sessionToken } from "../../../server/session";
import { api, jsonBody } from "../../../server/http";

export async function GET() { return api(practiceOverview(await sessionToken())); }
export async function POST(request: Request) {
  const token = await sessionToken();
  return api(jsonBody(request, 512000).pipe(Effect.flatMap((body) => publishPractice(token, body))), true);
}
