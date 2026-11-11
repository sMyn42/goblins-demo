export type DeploymentEnvironment = Record<string, string | undefined>;
export function cloudPreflight(env: DeploymentEnvironment) {
  const required = ["GCP_PROJECT", "GCP_REGION", "CLOUD_DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY"];
  const missing = required.filter((name) => !env[name]?.trim());
  const errors: string[] = [];
  if (env.GCP_PROJECT && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.GCP_PROJECT)) errors.push("GCP_PROJECT must be a project ID, not a display name or project number.");
  if (env.GCP_REGION && !/^[a-z]+-[a-z]+\d+$/.test(env.GCP_REGION)) errors.push("GCP_REGION must be a Cloud Run region, such as us-east1.");
  if (env.CLOUD_DATABASE_URL) {
    try {
      const url = new URL(env.CLOUD_DATABASE_URL);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.includes(".") || /localhost|127\.0\.0\.1|\[::1\]|\.local$/.test(url.hostname)) throw new Error();
    } catch { errors.push("CLOUD_DATABASE_URL must point to durable hosted PostgreSQL, not the local development database."); }
  }
  if (env.SUPABASE_URL) {
    try { const url = new URL(env.SUPABASE_URL); if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(); }
    catch { errors.push("SUPABASE_URL must be the HTTPS project origin, without credentials or paths."); }
  }
  if (env.CLOUD_APP_ORIGIN) {
    try { const url = new URL(env.CLOUD_APP_ORIGIN); if (url.protocol !== "https:" || url.hostname === "localhost" || url.origin !== env.CLOUD_APP_ORIGIN) throw new Error(); }
    catch { errors.push("CLOUD_APP_ORIGIN must be an exact HTTPS origin; omit it to use the generated Cloud Run URL."); }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(env.GCP_REPOSITORY ?? "goblins")) errors.push("Invalid GCP_REPOSITORY.");
  if (!/^[a-z0-9-]+$/.test(env.SUPABASE_STORAGE_BUCKET ?? "student-work")) errors.push("Invalid SUPABASE_STORAGE_BUCKET.");
  if (env.CLOUD_PGMQ_INSTALL_MODE && !["existing", "extension", "sql"].includes(env.CLOUD_PGMQ_INSTALL_MODE)) errors.push("Invalid CLOUD_PGMQ_INSTALL_MODE.");
  if (env.OPENROUTER_OCR_MODEL && !/^google\/[a-zA-Z0-9._:/-]+$/.test(env.OPENROUTER_OCR_MODEL)) errors.push("OCR model must use the google/ namespace.");
  if (env.OPENROUTER_GRADING_MODEL && !/^openai\/[a-zA-Z0-9._:/-]+$/.test(env.OPENROUTER_GRADING_MODEL)) errors.push("Grading model must use the openai/ namespace.");
  return { missing, errors };
}
