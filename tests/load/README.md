# Isolated Cloud Run load tests

This module drives the real Goblins Cloud Run web service and worker with Locust. It exercises the existing authenticated APIs, the isolated Supabase Postgres/pgmq queue and private Storage bucket, and the real Cloud Run worker fleet. OCR and grading are **mock-only**. The runner refuses a worker configured with OpenRouter credentials and never reads `.env`, `.env.local`, `DATABASE_URL`, or production service settings.

> **Never point this module at production, a live demo, or a database/bucket containing real student work.** Create dedicated test infrastructure first. The runner requires explicit test/production host comparisons, a test-only Cloud Run service name, a database guard row, and an operator confirmation string. These safeguards are intentionally redundant.

## What the scenarios do

- Locust authenticates using session tokens created by Goblins' existing `register` and `createClass` application flows. Each synthetic student views the published assignment, makes exactly one submission for that unique question, then polls their own progress. One teacher reads `/dashboard` and the existing teacher roster/progress API.
- Every student submits a 1000×500 PNG rendered with deterministic algebra strokes in the same dimensions as Goblins' answer canvas. Every upload uses the real `POST /api/submissions` route, goes to the isolated private Supabase Storage bucket, and is read back through the student's authorized image endpoint. The worker uses the application's mock OCR and grading providers: image OCR selects a seeded, finite answer fixture per submission and the grader returns its corresponding rubric fixture; neither pretends to interpret pixels or provides a real model judgment.
- The scale plan runs **50, 250, and 1,250 distinct student accounts** in sequential stages, with a one-minute, two-minute, and five-minute ramp respectively, followed by five- or ten-minute sustain periods. Each stage has a separate assignment and a non-overlapping student slice. Each student submits once per assignment/problem.
- Selected 250-student stages are repeated with exactly 2 and 5 configured worker instances. Failure cohorts include a no-fault baseline, 5% and 10% transient failures, 5% permanent failures, and a 20-student timeout/manual-recovery case with a 50% stage-level hang-selection rate. Transient errors exercise retries; permanent failures remain recorded. The timeout case injects deterministic hangs into selected OCR/grading calls, keeps the worker heartbeat/queue-probe loop running, and puts provider timeouts beyond the run hard cutoff.
- The `approval_smoke_1` cohort verifies a completed grade remains hidden before approval, then approves one grade through the existing teacher endpoint and verifies the student sees it only after refresh. The timeout/manual-recovery cohort manually grades all hard-cutoff failures, verifies each original image/failure/run is retained and the teacher view shows the manual-grade audit, confirms drafts stay hidden, then explicitly approves one manual grade. Other cohorts deliberately do not approve grades.
- Each run verifies DB submission uniqueness, grading/retry outcomes, failure/source preservation, private-image readback, student privacy, teacher/student status agreement after refresh, approval invariants, and queue drain. It records Locust percentiles, queue depth/age, worker heartbeats/active jobs/completions, and Cloud Monitoring Cloud Run instance counts.

The fixture output, log-normal long-tail delay, and failure selection are seeded by persisted submission ID, stage, and `MOCK_SEED=42`; a submission's delay and fault selection are stable across retries, while transient faults succeed on a later attempt. New submissions have new IDs, so a repeated cohort is not promised to produce the exact same answers/failures. With `MOCK_LATENCY_MS=500`, stage latency is capped at 20× the base. Failure rates are configured rates, not guarantees of an exact observed percentage.

## 1. Provision isolated cloud accounts and local settings

Create a dedicated Supabase project (database **and** Storage) and a separate GCP project with billing enabled. The test GCP project must differ from production. Enable Supabase Queues/pgmq in the test project; do not restore production/demo data. The deploy helper expects the GCP project and Supabase project to exist, but it creates the Cloud Run-side resources.

Copy `tests/load/.env.test.example` to the ignored `tests/load/.env.test` if needed, then fill it with the isolated database URL, test Supabase URL/service-role key, test DB hostname, and test bucket. Also fill the **non-secret production identifiers** used only for fail-closed comparisons: production GCP project ID, DB hostname, Supabase project URL, and storage bucket. Keep test and production identifiers distinct. Do not source `.env.local` or copy production credentials into this file.

Authenticate gcloud for the isolated GCP project and Application Default Credentials for the later runner. The deployment command never reads `.env.local`; it explicitly sources only `tests/load/.env.test`.

## 2. Deploy the isolated Cloud Run stack and apply migrations

From this directory (`goblins/tests/load`), run the non-mutating preflight first, then explicitly deploy:

```bash
cd tests/load
./deploy-cloud-run.sh --check
./deploy-cloud-run.sh --deploy
```

The first command validates isolation settings, gcloud authentication, and target-project access without creating resources. The explicit `--deploy` command enables required APIs, creates the test Artifact Registry repository and runtime identity, uploads the test DB/storage/monitor secrets through stdin, builds the runtime and tools images, then runs a Cloud Run release job **before** app rollout. That job applies all checked-in database migrations, creates/verifies the private Storage bucket, and installs/verifies the test-only database guard. It then deploys the public test web service and private mock-only worker, sets `APP_ORIGIN`, and checks `/api/ready`.

The helper never creates or changes the GCP project or Supabase project. The GCP project must already have billing enabled; the Supabase project must already have pgmq enabled and provide valid test credentials. The helper uses only `APP_MODE=load-test`, mock OCR/grading, and no OpenRouter key. It uses names containing `loadtest`, and refuses matching production GCP, database, Supabase, or bucket identifiers. The monitor token is generated if omitted; the resulting URL and token are saved with mode `0600` under ignored `tests/load/.state/` for the load runner. The release job pins Secret Manager versions and does not print secret values.

Cloud Build/Run, Secret Manager, monitoring, database, and always-on worker usage may incur charges. The deployer needs permissions to enable APIs, create Artifact Registry/Secret Manager/Cloud Run resources and service identities, and submit builds. The Cloud Build identity must also be able to push to the repository. This is a staging-like **isolated mock load-test stack**, not a production-like live-inference staging environment.

The worker starts at one instance with CPU always allocated, `WORKER_CONCURRENCY=2`, mock mode, and explicit zero injected-failure rate. For the separate capacity comparisons, update the worker min/max to exactly 2 or 5 before the corresponding cohort; the runner verifies and records deployed settings. Cloud Monitoring read access is needed to measure actual Cloud Run worker instances; heartbeat counts are reported separately.

## 3. Install Locust and configure fail-closed target guards

Use Python 3.10+ and install the pinned-range dependencies in a virtual environment. Authenticate gcloud and Application Default Credentials with permissions limited to the isolated project (Cloud Run service viewer and Monitoring viewer are sufficient for the runner):

```bash
python3 -m venv .venv-load
.venv-load/bin/pip install -r tests/load/requirements.txt
gcloud auth login
gcloud auth application-default login
```

Copy `tests/load/.env.test.example` to the ignored `tests/load/.env.test` if it does not already exist (`cp -n tests/load/.env.test.example tests/load/.env.test`), then fill only isolated-test credentials and the non-secret production identifiers used for deny-list checks. Do not source `.env` or `.env.local`.

After deployment, run the explicit wrapper from the repository root. It sources only `tests/load/.env.test` and the private deployment URL/token files; the Python runner itself still does not auto-load dotenv files:

```bash
./tests/load/with-env.sh python tests/load/run.py --preflight-only --cohort scale_50
```

Only proceed if it reports `Preflight PASS`. The preflight verifies actual Cloud Run service URL/image/config, mock-only settings, separate DB/Storage identifiers, empty pgmq queue, web readiness, guard row, and worker heartbeats.

The convenience scale helper also sources that file. First run setup once; this performs preflight, then bootstraps all 1,550 synthetic accounts (about 16 minutes, no load traffic). Then run the sizes independently to separate their artifacts and test windows:

```bash
./tests/load/run-scale.sh --setup
./tests/load/run-scale.sh --xsmall  # 50 students
./tests/load/run-scale.sh --small   # 250 students
./tests/load/run-scale.sh --medium  # 1,250 students
# Or run all three sequentially:
./tests/load/run-scale.sh --all
```

The deploy helper creates the GCP-side image repository, secrets, release job, and Cloud Run services; it applies migrations, configures Storage, and installs the guard before rollout. It does not create the GCP or Supabase projects. `run-scale.sh` only bootstraps/runs the baseline scale plan; approval, capacity, and failure cohorts remain separate commands below.

## 4. Provision synthetic accounts through Goblins flows

`./tests/load/run-scale.sh --setup` creates the teacher, class, published assignments, 1,550 synthetic students, and session tokens using Goblins' existing `register`, `createClass`, and `publishPractice` application flows. It honors the global registration rate limit (at most 100 accounts/minute) and takes roughly 16 minutes. This setup is not load traffic; Locust later sends the real submission, teacher, progress, image-upload, and readback traffic to the deployed Cloud Run web service. It never inserts user or session rows directly.

The resulting private manifest contains bearer-equivalent session tokens. Keep it only under ignored `tests/load/.state/`, use it only against this isolated stack, and do not attach it to a ticket or commit it. Session expiry is seven days. Use a fresh `LOADTEST_RUN_ID` and a fresh isolated database/assignment set for a new bootstrap; do not bootstrap again over a partially completed setup without investigating first.

## 5. Run the staged tests

Run all three sequential baseline sizes with one worker instance:

```bash
./tests/load/with-env.sh python tests/load/run.py --plan scale
```

The 1,250-student cohort is a five-minute ramp plus ten-minute sustain; the queue is observed during load and after Locust stops. Each run refuses to reuse a consumed one-attempt question or start while the isolated queue is non-empty. Every run writes raw Locust CSV, logs, counters, time-series JSONL, generated PNG plots, a machine-readable summary, and `report.md` into its own ignored directory under `tests/load/artifacts/`.

The following cohorts need the matching worker service configuration and failure mode/rate before each run. Run one at a time; the runner verifies the worker configuration and will refuse a mismatch. For the inline `gcloud` updates, source the test file in the current shell first (`set -a; source tests/load/.env.test; set +a`); do not print the environment afterward:

```bash
# Approval smoke test (one student, one teacher approval after an unreleased grade)
./tests/load/with-env.sh python tests/load/run.py --plan approval

# Capacity comparisons: change worker min/max to exactly 2, then exactly 5.
./tests/load/with-env.sh python tests/load/run.py --cohort capacity_250_2_workers
./tests/load/with-env.sh python tests/load/run.py --cohort capacity_250_5_workers

# Failure experiments, all at one worker instance and WORKER_CONCURRENCY=2.
./tests/load/with-env.sh python tests/load/run.py --cohort failure_baseline_250
# Set MOCK_FAILURE_MODE=transient and MOCK_FAILURE_RATE=0.05 on both services, then:
./tests/load/with-env.sh python tests/load/run.py --cohort failure_transient_5pct_250
# Update the rate to 0.1 on both services, then:
./tests/load/with-env.sh python tests/load/run.py --cohort failure_transient_10pct_250
# Set MOCK_FAILURE_MODE=permanent and MOCK_FAILURE_RATE=0.05 on both services, then:
./tests/load/with-env.sh python tests/load/run.py --cohort failure_permanent_5pct_250

# Hard-cutoff/manual-recovery test. The worker provider timeout must exceed the 25s run deadline.
gcloud run services update goblins-loadtest-worker --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --update-env-vars=MOCK_FAILURE_MODE=timeout,MOCK_FAILURE_RATE=0.5,WORKER_LEASE_SECONDS=30,OCR_TIMEOUT_MS=60000,GRADING_TIMEOUT_MS=60000,WORKER_HEARTBEAT_INTERVAL_MS=15000
gcloud run services update goblins-loadtest-web --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --update-env-vars=MOCK_FAILURE_MODE=timeout,MOCK_FAILURE_RATE=0.5
./tests/load/with-env.sh python tests/load/run.py --cohort failure_hard_cutoff_manual_20

# Restore the baseline worker timing/failure mode before any later standard cohort.
gcloud run services update goblins-loadtest-worker --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --update-env-vars=MOCK_FAILURE_MODE=none,MOCK_FAILURE_RATE=0,WORKER_LEASE_SECONDS=120,OCR_TIMEOUT_MS=15000,GRADING_TIMEOUT_MS=20000
gcloud run services update goblins-loadtest-web --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --update-env-vars=MOCK_FAILURE_MODE=none,MOCK_FAILURE_RATE=0
```

For each fault experiment, update the web and worker revisions together, without adding any model API key. For example:

```bash
gcloud run services update goblins-loadtest-worker --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" --update-env-vars=MOCK_FAILURE_MODE=transient,MOCK_FAILURE_RATE=0.05
gcloud run services update goblins-loadtest-web --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" --update-env-vars=MOCK_FAILURE_MODE=transient,MOCK_FAILURE_RATE=0.05
```

Change the mode/rate values for each experiment. Each cohort has its own immutable assignment but uses synthetic accounts from the isolated classroom; the one-submission rule applies to each unique question. The scale cohorts use non-overlapping account slices. Repeated capacity/failure experiments use a separate assignment and therefore a distinct one-attempt submission per student/problem.

## Results and cleanup

- `metrics.jsonl` records DB-visible queue depth/oldest age, assignment status counts, worker active/waiting/persisting/completed jobs, worker heartbeat count, and Cloud Monitoring Cloud Run instance/CPU samples over time and queue drain.
- `locust_stats.csv` and `locust_stats_history.csv` contain request counts, failures, throughput, and response-time percentiles. The report plots throughput vs concurrent users, p50/p95/p99, queue depth/age, worker activity/instances/completion rate, outcome counts, drain, and a cross-run capacity curve.
- `summary.json` records measured correctness, actual configured Cloud Run settings, observed instance-count maxima if Cloud Monitoring returned samples, and aggregate outcomes. `report.md` explicitly calls out missing Cloud Monitoring data and does not claim an unmeasured capacity or root cause.
- Reports include real results only. This repository has no measured capacity figure until an operator runs these tests against a provisioned isolated stack. Do not treat mock grading latency as a paid-provider SLA.
- After the run, keep or remove the private session manifest according to your security policy: `rm -rf tests/load/.state`. Review artifacts for local retention, then clean up only the dedicated load-test Cloud Run services, secrets, bucket contents, and Supabase project. The runner never performs destructive cleanup.
