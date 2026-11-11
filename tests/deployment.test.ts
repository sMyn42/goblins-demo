import { describe, expect, it } from "vitest";
import { cloudPreflight } from "../src/deployment/config";
const env = {
  GCP_PROJECT: "goblins-testing", GCP_REGION: "us-east1", CLOUD_DATABASE_URL: "postgresql://user:secret-value@db.example.com:5432/postgres",
  SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "private-storage-value", OPENROUTER_API_KEY: "existing-private-value",
  OPENROUTER_OCR_MODEL: "google/gemini-3.5-flash", OPENROUTER_GRADING_MODEL: "openai/gpt-6-luna",
};
describe("Cloud Run deployment preflight", () => {
  it("requires production project, durable database and storage, not just an inference key", () => {
    const check = cloudPreflight({ OPENROUTER_API_KEY: "already-entered" });
    expect(check.missing).toContain("GCP_PROJECT"); expect(check.missing).toContain("CLOUD_DATABASE_URL");
    expect(check.missing).not.toContain("OPENROUTER_API_KEY");
  });
  it("accepts the requested models and hosted infrastructure", () => { expect(cloudPreflight(env)).toEqual({ missing: [], errors: [] }); });
  it("rejects local database connections and never prints their credentials", () => {
    for (const url of ["postgres://user:never-print@localhost/db", "postgres://user:never-print@127.0.0.1/db", "postgres://user:never-print@postgres/db"]) {
      const check = cloudPreflight({ ...env, CLOUD_DATABASE_URL: url });
      expect(check.errors).toHaveLength(1); expect(JSON.stringify(check)).not.toContain("never-print");
    }
  });
  it("does not reuse a localhost web origin for a Cloud Run deployment", () => {
    expect(cloudPreflight({ ...env, APP_ORIGIN: "http://localhost:3000" }).errors).toEqual([]);
    expect(cloudPreflight({ ...env, CLOUD_APP_ORIGIN: "http://localhost:3000" }).errors).toHaveLength(1);
  });
  it("rejects credential-bearing Supabase URLs without leaking values", () => {
    const check = cloudPreflight({ ...env, SUPABASE_URL: "https://user:do-not-log@example.supabase.co" });
    expect(check.errors).toHaveLength(1); expect(JSON.stringify(check)).not.toContain("do-not-log");
  });
});
