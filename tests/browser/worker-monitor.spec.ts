import { test, expect } from "@playwright/test";

test("operator fleet monitoring is protected and the main web service sees the separate worker heartbeat", async ({ request }) => {
  expect((await request.get("/api/worker-status")).status()).toBe(401);
  expect((await request.get("/api/worker-status", { headers: { Authorization: "Bearer incorrect" } })).status()).toBe(401);
  await expect.poll(async () => {
    const response = await request.get("/api/worker-status", { headers: { Authorization: "Bearer e2e-operator-token-not-a-real-secret-12345" } });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const report = await response.json();
    const serialized = JSON.stringify(report);
    for (const forbidden of ["studentId", "submissionId", "objectKey", "passwordHash", "tokenHash", "OPENROUTER_API_KEY"]) expect(serialized).not.toContain(forbidden);
    return report.readyWorkers;
  }, { timeout: 20000 }).toBeGreaterThan(0);
});
