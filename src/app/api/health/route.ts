export async function GET() {
  return Response.json({ status: "ok", milestone: "grading-slice" }, { headers: { "Cache-Control": "no-store" } });
}
