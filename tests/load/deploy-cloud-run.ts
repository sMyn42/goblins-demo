import { randomBytes } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_DIR = resolve(process.env.LOADTEST_STATE_DIR ?? resolve(ROOT, "tests/load/.state"));
const env = process.env;
const deploy = process.argv.includes("--deploy");
const confirmation = "I_CONFIRMED_SEPARATE_LOADTEST_INFRASTRUCTURE";

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Required test setting is missing: ${name}`);
  return value;
}

function origin(name: string): string {
  const raw = required(name);
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTPS project origin without credentials or a path.`);
  }
  return parsed.origin;
}

function validate(): void {
  if (required("LOADTEST_ENVIRONMENT") !== "isolated" || required("LOADTEST_CONFIRM_ISOLATED") !== confirmation) {
    throw new Error("Explicit isolated-load-test confirmation is required.");
  }
  const project = required("LOADTEST_GCP_PROJECT");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error("LOADTEST_GCP_PROJECT must be a GCP project ID.");
  if (project === required("LOADTEST_PRODUCTION_GCP_PROJECT")) throw new Error("Load-test GCP project must differ from production.");
  if (!/^[a-z]+-[a-z]+\d+$/.test(required("LOADTEST_GCP_REGION"))) throw new Error("LOADTEST_GCP_REGION must be a Cloud Run region.");
  const serviceNames = [required("LOADTEST_WEB_SERVICE"), required("LOADTEST_WORKER_SERVICE")];
  if (serviceNames.some((name) => !/^[a-z][a-z0-9-]{3,62}$/.test(name) || !name.toLowerCase().includes("loadtest"))) {
    throw new Error("Both Cloud Run service names must be dedicated names containing 'loadtest'.");
  }
  const testDb = new URL(required("LOADTEST_DATABASE_URL"));
  if (!["postgres:", "postgresql:"].includes(testDb.protocol)) throw new Error("LOADTEST_DATABASE_URL must be a PostgreSQL URL.");
  const host = testDb.hostname.toLowerCase().replace(/\.$/, "");
  const expectedHost = required("LOADTEST_EXPECTED_DATABASE_HOST").toLowerCase().replace(/\.$/, "");
  const productionHost = required("LOADTEST_PRODUCTION_DATABASE_HOST").toLowerCase().replace(/\.$/, "");
  if (host !== expectedHost || host === productionHost || ["localhost", "127.0.0.1", "::1"].includes(host) || host.endsWith(".local")) {
    throw new Error("Database host isolation check failed.");
  }
  const testSupabase = origin("LOADTEST_SUPABASE_URL");
  const productionSupabase = origin("LOADTEST_PRODUCTION_SUPABASE_URL");
  if (testSupabase === productionSupabase) throw new Error("Test Supabase project must differ from production.");
  const bucket = required("LOADTEST_STORAGE_BUCKET");
  if (!/^[a-z0-9-]+$/.test(bucket) || !/load.?test|test/i.test(bucket) || bucket === required("LOADTEST_PRODUCTION_STORAGE_BUCKET")) {
    throw new Error("Storage bucket must be clearly test-only and differ from production.");
  }
  for (const name of ["LOADTEST_DATABASE_SECRET_NAME", "LOADTEST_STORAGE_SECRET_NAME", "LOADTEST_MONITOR_SECRET_NAME"]) {
    const secretName = required(name);
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(secretName) || !secretName.toLowerCase().includes("loadtest")) {
      throw new Error(`${name} must be a dedicated Secret Manager name containing 'loadtest'.`);
    }
  }
  if (!required("LOADTEST_STORAGE_SERVICE_ROLE_KEY")) throw new Error("Test Supabase service-role key is required for the storage setup job.");
  if (env.LOADTEST_WORKER_MONITOR_TOKEN && env.LOADTEST_WORKER_MONITOR_TOKEN.length < 32) {
    throw new Error("LOADTEST_WORKER_MONITOR_TOKEN must be at least 32 characters when supplied.");
  }
  const concurrency = Number(env.LOADTEST_WORKER_CONCURRENCY || "2");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("LOADTEST_WORKER_CONCURRENCY must be an integer from 1 to 20.");
}

async function gcloud(args: string[], options: { input?: string; visible?: boolean } = {}): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("gcloud", [...args, "--quiet"], {
      stdio: ["pipe", options.visible ? "inherit" : "pipe", options.visible ? "inherit" : "pipe"],
      cwd: ROOT,
    });
    let output = "";
    child.stdout?.on("data", (data) => { if (output.length < 1024 * 1024) output += String(data); });
    child.stderr?.resume(); // Never echo captured diagnostics that could contain configuration.
    child.once("error", () => reject(new Error("Google Cloud CLI is unavailable; install it and authenticate with gcloud auth login.")));
    child.once("close", (code) => code === 0
      ? resolvePromise(output.trim())
      : reject(new Error(`gcloud ${args.slice(0, 3).join(" ")} failed; check project permissions and Cloud operation logs.`)));
    child.stdin?.end(options.input);
  });
}

async function exists(args: string[]): Promise<boolean> {
  try { await gcloud(args); return true; } catch { return false; }
}

async function ensureSecret(name: string, value: string, project: string, serviceAccount: string): Promise<string> {
  const projectArgs = ["--project", project];
  if (!await exists(["secrets", "describe", name, ...projectArgs])) {
    await gcloud(["secrets", "create", name, "--replication-policy=automatic", ...projectArgs]);
  }
  const versionPath = await gcloud([
    "secrets", "versions", "add", name, "--data-file=-", "--format=value(name)", ...projectArgs,
  ], { input: value });
  const version = versionPath.split("/").at(-1);
  if (!version || !/^\d+$/.test(version)) throw new Error(`Could not pin a Secret Manager version for ${name}.`);
  await gcloud([
    "secrets", "add-iam-policy-binding", name,
    `--member=serviceAccount:${serviceAccount}`, "--role=roles/secretmanager.secretAccessor", ...projectArgs,
  ]);
  return `${name}:${version}`;
}

async function writePrivate(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function main(): Promise<void> {
  validate();
  const project = required("LOADTEST_GCP_PROJECT");
  const region = required("LOADTEST_GCP_REGION");
  const projectArgs = ["--project", project];
  const active = await gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
  if (!active) throw new Error("No active gcloud login. Run gcloud auth login first.");
  const describedProject = await gcloud(["projects", "describe", project, "--format=value(projectId)", ...projectArgs]);
  if (describedProject !== project) throw new Error("gcloud did not confirm the configured isolated project.");

  const webService = required("LOADTEST_WEB_SERVICE");
  const workerService = required("LOADTEST_WORKER_SERVICE");
  const repository = "goblins-loadtest";
  const databaseSecret = required("LOADTEST_DATABASE_SECRET_NAME");
  const storageSecret = required("LOADTEST_STORAGE_SECRET_NAME");
  const monitorSecret = required("LOADTEST_MONITOR_SECRET_NAME");
  const runtimeAccountId = "goblins-loadtest-runtime";
  const serviceAccount = `${runtimeAccountId}@${project}.iam.gserviceaccount.com`;

  if (!deploy) {
    console.log(`Load-test deployment check passed for isolated project ${project} (${region}).`);
    console.log(`Would create/update ${webService}, ${workerService}, and the ${repository} image repository; migrations/storage/guard run in a Cloud Run job.`);
    console.log("No resources changed. Run ./deploy-cloud-run.sh --deploy to deploy the isolated mock-only stack.");
    return;
  }

  const token = env.LOADTEST_WORKER_MONITOR_TOKEN || randomBytes(32).toString("hex");
  console.log(`Deploying isolated mock-only load-test services to ${project}/${region}. Cloud resources and the always-on worker may incur charges.`);
  await gcloud([
    "services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com", "monitoring.googleapis.com", "iam.googleapis.com", ...projectArgs,
  ], { visible: true });

  if (!await exists(["artifacts", "repositories", "describe", repository, "--location", region, ...projectArgs])) {
    await gcloud(["artifacts", "repositories", "create", repository, "--repository-format=docker", "--location", region, ...projectArgs], { visible: true });
  }
  if (!await exists(["iam", "service-accounts", "describe", serviceAccount, ...projectArgs])) {
    await gcloud(["iam", "service-accounts", "create", runtimeAccountId, "--display-name=Goblins isolated load-test runtime", ...projectArgs], { visible: true });
  }

  // Values are supplied to gcloud over stdin and never placed in command-line arguments.
  const database = await ensureSecret(databaseSecret, required("LOADTEST_DATABASE_URL"), project, serviceAccount);
  const storageKey = await ensureSecret(storageSecret, required("LOADTEST_STORAGE_SERVICE_ROLE_KEY"), project, serviceAccount);
  const monitor = await ensureSecret(monitorSecret, token, project, serviceAccount);

  const image = `${region}-docker.pkg.dev/${project}/${repository}/app:${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomBytes(3).toString("hex")}`;
  await gcloud(["builds", "submit", ".", "--config=cloudbuild.yaml", `--substitutions=_IMAGE=${image}`, ...projectArgs], { visible: true });

  const common = [...projectArgs, "--region", region, "--service-account", serviceAccount];
  const supabaseUrl = origin("LOADTEST_SUPABASE_URL");
  const bucket = required("LOADTEST_STORAGE_BUCKET");
  const concurrency = env.LOADTEST_WORKER_CONCURRENCY || "2";
  const baseEnv = [
    "APP_MODE=load-test", "OCR_PROVIDER=mock", "GRADING_PROVIDER=mock", "MOCK_SEED=42",
    "MOCK_FAILURE_MODE=none", "MOCK_FAILURE_RATE=0", "MOCK_LATENCY_MS=500",
    `WORKER_CONCURRENCY=${concurrency}`, "WORKER_MAX_ATTEMPTS=3",
    "STORAGE_PROVIDER=supabase", `SUPABASE_URL=${supabaseUrl}`, `SUPABASE_STORAGE_BUCKET=${bucket}`,
    "PGMQ_INSTALL_MODE=existing",
  ].join(",");
  const guardEnv = [
    "LOADTEST_ENVIRONMENT=isolated", `LOADTEST_CONFIRM_ISOLATED=${confirmation}`,
    `LOADTEST_GCP_PROJECT=${project}`, `LOADTEST_PRODUCTION_GCP_PROJECT=${required("LOADTEST_PRODUCTION_GCP_PROJECT")}`,
    `LOADTEST_EXPECTED_DATABASE_HOST=${required("LOADTEST_EXPECTED_DATABASE_HOST")}`,
    `LOADTEST_PRODUCTION_DATABASE_HOST=${required("LOADTEST_PRODUCTION_DATABASE_HOST")}`,
    `LOADTEST_SUPABASE_URL=${supabaseUrl}`, `LOADTEST_PRODUCTION_SUPABASE_URL=${origin("LOADTEST_PRODUCTION_SUPABASE_URL")}`,
    `LOADTEST_STORAGE_BUCKET=${bucket}`, `LOADTEST_PRODUCTION_STORAGE_BUCKET=${required("LOADTEST_PRODUCTION_STORAGE_BUCKET")}`,
  ].join(",");
  const backendSecrets = `DATABASE_URL=${database},SUPABASE_SERVICE_ROLE_KEY=${storageKey}`;

  // Apply migrations, create/verify the private bucket, and install the test-only DB guard before app rollout.
  await gcloud([
    "run", "jobs", "deploy", "goblins-loadtest-release", ...common,
    "--image", `${image}-tools`, "--command=/bin/bash",
    "--args=-lc,npm run db:migrate && npm run setup:storage && npm exec -- tsx tests/load/setup-guard.ts",
    "--tasks=1", "--max-retries=0", "--task-timeout=600s",
    "--set-secrets", backendSecrets,
    "--set-env-vars", `${baseEnv},${guardEnv}`,
  ], { visible: true });
  await gcloud(["run", "jobs", "execute", "goblins-loadtest-release", ...projectArgs, "--region", region, "--wait"], { visible: true });

  const webSecrets = `${backendSecrets},WORKER_MONITOR_TOKEN=${monitor}`;
  await gcloud([
    "run", "deploy", webService, ...common, "--image", image,
    "--allow-unauthenticated", "--min-instances=1", "--max-instances=20",
    "--concurrency=80", "--memory=1Gi", "--set-secrets", webSecrets,
    "--set-env-vars", `${baseEnv},APP_ORIGIN=https://pending.invalid`,
    "--startup-probe=httpGet.path=/api/ready,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=24",
  ], { visible: true });
  const baseUrl = await gcloud(["run", "services", "describe", webService, ...projectArgs, "--region", region, "--format=value(status.url)"]);
  if (!baseUrl.startsWith("https://")) throw new Error("Cloud Run did not return an HTTPS test web URL.");
  await gcloud(["run", "services", "update", webService, ...projectArgs, "--region", region, "--update-env-vars", `APP_ORIGIN=${baseUrl}`], { visible: true });

  await gcloud([
    "run", "deploy", workerService, ...common, "--image", image,
    "--no-allow-unauthenticated", "--command=node", "--args=dist/worker.mjs", "--no-cpu-throttling",
    "--min-instances=1", "--max-instances=1", "--concurrency=1", "--memory=512Mi",
    "--set-secrets", backendSecrets, "--set-env-vars", baseEnv,
    "--startup-probe=httpGet.path=/ready,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=24",
  ], { visible: true });

  const ready = await fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(20_000) });
  if (!ready.ok) throw new Error("Test web deployment completed but database/queue readiness failed; do not start load.");
  await writePrivate(resolve(STATE_DIR, "base-url"), baseUrl);
  await writePrivate(resolve(STATE_DIR, "monitor-token"), token);
  console.log(`Load-test web is ready at ${baseUrl}. Worker is private and configured for mock OCR/grading.`);
  console.log("Local .state/base-url and .state/monitor-token were written with mode 0600 for the runner. No production service was changed.");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Load-test deployment failed. No secret values were logged.");
  process.exitCode = 1;
}
