import "../src/server/env";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cloudPreflight } from "../src/deployment/config";

const env = process.env;
const deploy = process.argv.includes("--deploy");
async function gcloud(args: string[], options: { input?: string; visible?: boolean } = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("gcloud", [...args, "--quiet"], { stdio: ["pipe", options.visible ? "inherit" : "pipe", options.visible ? "inherit" : "pipe"] });
    let output = "";
    child.stdout?.on("data", (data) => { if (output.length < 1024 * 1024) output += String(data); });
    // Capture no sensitive stderr in error messages. Secret values are stdin only.
    child.stderr?.resume();
    child.once("error", () => reject(new Error("Google Cloud CLI is unavailable. Install it and run gcloud auth login.")));
    child.once("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`gcloud ${args.slice(0, 3).join(" ")} failed. Check the selected project's permissions and Google Cloud operation logs.`)));
    child.stdin?.end(options.input);
  });
}
async function exists(args: string[]) { try { await gcloud(args); return true; } catch { return false; } }

async function main() {
  const check = cloudPreflight(env);
  if (check.missing.length || check.errors.length) {
    console.error("Cloud deployment blocked. No resources changed; existing OpenRouter key was not printed or modified.");
    if (check.missing.length) console.error(`Missing variable names: ${check.missing.join(", ")}`);
    for (const error of check.errors) console.error(error);
    throw new Error("Fill the production settings in ignored .env.local; see docs/deployment.md.");
  }
  const accounts = await gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
  if (!accounts) throw new Error("No active Google Cloud login. Run gcloud auth login first.");
  const project = env.GCP_PROJECT!, region = env.GCP_REGION!, repository = env.GCP_REPOSITORY ?? "goblins";
  const projectArgs = ["--project", project];
  await gcloud(["projects", "describe", project, ...projectArgs, "--format=value(projectId)"]);
  if (!deploy) { console.log("Cloud configuration and login preflight passed. No resources created and no inference performed. Run npm run deploy:cloud to deploy."); return; }
  console.log(`Deploying web and live inference worker to project ${project}, region ${region}. The always-on worker and live inference can incur charges.`);
  await gcloud(["services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com", ...projectArgs], { visible: true });
  if (!await exists(["artifacts", "repositories", "describe", repository, "--location", region, ...projectArgs])) {
    await gcloud(["artifacts", "repositories", "create", repository, "--repository-format=docker", "--location", region, ...projectArgs]);
  }
  const serviceAccount = env.GCP_SERVICE_ACCOUNT ?? `goblins-runtime@${project}.iam.gserviceaccount.com`;
  if (!await exists(["iam", "service-accounts", "describe", serviceAccount, ...projectArgs])) {
    if (env.GCP_SERVICE_ACCOUNT) throw new Error("Configured GCP_SERVICE_ACCOUNT does not exist or is not accessible.");
    await gcloud(["iam", "service-accounts", "create", "goblins-runtime", "--display-name=Goblins runtime", ...projectArgs]);
  }
  async function secret(name: string, value: string) {
    if (!await exists(["secrets", "describe", name, ...projectArgs])) await gcloud(["secrets", "create", name, "--replication-policy=automatic", ...projectArgs]);
    const versionName = await gcloud(["secrets", "versions", "add", name, "--data-file=-", "--format=value(name)", ...projectArgs], { input: value });
    const version = versionName.split("/").at(-1);
    if (!version || !/^\d+$/.test(version)) throw new Error("Could not pin the new secret version.");
    await gcloud(["secrets", "add-iam-policy-binding", name, `--member=serviceAccount:${serviceAccount}`, "--role=roles/secretmanager.secretAccessor", ...projectArgs]);
    return `${name}:${version}`;
  }
  const database = await secret("goblins-database-url", env.CLOUD_DATABASE_URL!);
  const storage = await secret("goblins-supabase-service-key", env.SUPABASE_SERVICE_ROLE_KEY!);
  // Reuse the key already loaded from .env / .env.local. Never pass its value as an argument.
  const openrouter = await secret("goblins-openrouter-key", env.OPENROUTER_API_KEY!);
  const image = `${region}-docker.pkg.dev/${project}/${repository}/goblins:${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomBytes(3).toString("hex")}`;
  await gcloud(["builds", "submit", ".", "--config=cloudbuild.yaml", `--substitutions=_IMAGE=${image}`, ...projectArgs], { visible: true });
  const common = [...projectArgs, "--region", region, "--service-account", serviceAccount];
  const storageEnv = `STORAGE_PROVIDER=supabase,SUPABASE_URL=${new URL(env.SUPABASE_URL!).origin},SUPABASE_STORAGE_BUCKET=${env.SUPABASE_STORAGE_BUCKET ?? "student-work"}`;
  const backendSecrets = `DATABASE_URL=${database},SUPABASE_SERVICE_ROLE_KEY=${storage}`;
  // A release job applies migrations and verifies the private bucket before apps roll out.
  await gcloud(["run", "jobs", "deploy", "goblins-release", ...common, "--image", `${image}-tools`, "--command=/bin/bash", "--args=-lc,npm run db:migrate && npm run setup:storage", "--tasks=1", "--max-retries=0", "--task-timeout=300s", "--set-secrets", backendSecrets, "--set-env-vars", `${storageEnv},PGMQ_INSTALL_MODE=${env.CLOUD_PGMQ_INSTALL_MODE ?? "extension"}`], { visible: true });
  await gcloud(["run", "jobs", "execute", "goblins-release", ...projectArgs, "--region", region, "--wait"], { visible: true });
  const models = `OCR_PROVIDER=openrouter,GRADING_PROVIDER=openrouter,OPENROUTER_OCR_MODEL=${env.OPENROUTER_OCR_MODEL ?? "google/gemini-3.5-flash"},OPENROUTER_GRADING_MODEL=${env.OPENROUTER_GRADING_MODEL ?? "openai/gpt-6-luna"}`;
  await gcloud(["run", "deploy", "goblins-web", ...common, "--image", image, "--allow-unauthenticated", "--max-instances=3", "--memory=512Mi", "--set-secrets", backendSecrets, "--set-env-vars", `${storageEnv},APP_ORIGIN=https://pending.invalid`, "--startup-probe=httpGet.path=/api/ready,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=24"], { visible: true });
  const web = await gcloud(["run", "services", "describe", "goblins-web", ...projectArgs, "--region", region, "--format=value(status.url)"]);
  if (!web.startsWith("https://")) throw new Error("Cloud Run did not return an HTTPS web URL.");
  await gcloud(["run", "services", "update", "goblins-web", ...projectArgs, "--region", region, "--update-env-vars", `APP_ORIGIN=${env.CLOUD_APP_ORIGIN ?? web}`], { visible: true });
  await gcloud(["run", "deploy", "goblins-worker", ...common, "--image", image, "--no-allow-unauthenticated", "--command=node", "--args=dist/worker.mjs", "--no-cpu-throttling", "--min-instances=1", "--max-instances=2", "--concurrency=1", "--memory=512Mi", "--set-secrets", `${backendSecrets},OPENROUTER_API_KEY=${openrouter}`, "--set-env-vars", `${storageEnv},${models}`, "--startup-probe=httpGet.path=/ready,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=24"], { visible: true });
  const ready = await fetch(`${web}/api/ready`, { signal: AbortSignal.timeout(15000) });
  if (!ready.ok) throw new Error("Web deployment completed but database/queue readiness failed. Do not treat the rollout as verified.");
  console.log(`Cloud Run web: ${web}\nCloud Run worker: private, live Gemini OCR + OpenAI grading. Perform the two-browser acceptance checks in docs/testing.md before classroom use.`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Deployment failed. No secret values were logged."); process.exitCode = 1; });
