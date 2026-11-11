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

## 1. Provision a separate test stack

Use a dedicated Supabase project (database **and** Storage), a dedicated GCP project if possible, and Cloud Run services with names containing `loadtest`, for example:

- `goblins-loadtest-web`
- `goblins-loadtest-worker`
- private bucket `goblins-loadtest-work`
- Secret Manager secrets `goblins-loadtest-database`, `goblins-loadtest-storage-key`, and `goblins-loadtest-monitor-token`

The database must be a fresh isolated Supabase project with pgmq enabled. Do not restore production/demo data. Create the private PNG bucket using the app's existing setup script after exporting the **test** Supabase variables. Apply the checked-in migrations to that database:

```bash
export DATABASE_URL="$LOADTEST_DATABASE_URL"
export PGMQ_INSTALL_MODE=existing
npm run db:migrate

export SUPABASE_URL="$LOADTEST_SUPABASE_URL"
export SUPABASE_SERVICE_ROLE_KEY="$LOADTEST_STORAGE_SERVICE_ROLE_KEY"
export SUPABASE_STORAGE_BUCKET="$LOADTEST_STORAGE_BUCKET"
npm run setup:storage
```

The commands above use existing app setup; ensure the shell variables contain only test-project credentials. Never paste credential values into a command that will be saved in shell history.

After migrations, add a test-only guard row. The load runner and bootstrap both refuse to proceed without it:

```sql
CREATE TABLE public.loadtest_environment_guard (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  environment text NOT NULL CHECK (environment = 'isolated-load-test'),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.loadtest_environment_guard (id, environment)
VALUES (true, 'isolated-load-test');
REVOKE ALL ON public.loadtest_environment_guard FROM PUBLIC, anon, authenticated;
```

Run this SQL only against the new test database. The load-test DB connection should use a test-project role that can read the guard and inspect the app/pgmq tables. It is never written into the app's normal `DATABASE_URL` by this module.

## 2. Build and deploy the isolated Cloud Run services

Build the application image from the commit under test. Use the repository Cloud Build config, but a **new test-only image repository**:

```bash
export LOADTEST_GCP_PROJECT='your-isolated-project-id'
export LOADTEST_GCP_REGION='us-central1'
export LOADTEST_IMAGE="$LOADTEST_GCP_REGION-docker.pkg.dev/$LOADTEST_GCP_PROJECT/goblins-loadtest/app:$(git rev-parse --short HEAD)"
gcloud builds submit . --project "$LOADTEST_GCP_PROJECT" \
  --config cloudbuild.yaml --substitutions="_IMAGE=$LOADTEST_IMAGE"
```

Create the three Secret Manager secrets from the isolated database URL, isolated Supabase service-role key, and a random monitor token. The same monitor token value must be exported locally and referenced by the web service; do not print it:

```bash
export LOADTEST_WORKER_MONITOR_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$LOADTEST_DATABASE_URL" | gcloud secrets create goblins-loadtest-database --project "$LOADTEST_GCP_PROJECT" --data-file=-
printf '%s' "$LOADTEST_STORAGE_SERVICE_ROLE_KEY" | gcloud secrets create goblins-loadtest-storage-key --project "$LOADTEST_GCP_PROJECT" --data-file=-
printf '%s' "$LOADTEST_WORKER_MONITOR_TOKEN" | gcloud secrets create goblins-loadtest-monitor-token --project "$LOADTEST_GCP_PROJECT" --data-file=-
```

If the named secret already exists in the **test project**, add a new version rather than reusing a production secret. Grant only the dedicated Cloud Run service identities access to these test secrets.

Deploy a dedicated web service and worker from the same image. These are example starting settings; the runner reads back and records the actual Cloud Run configuration. Configure worker min/max to the cohort being run (start at one), with CPU always allocated so the background poller continues between HTTP requests:

```bash
export LOADTEST_SUPABASE_URL='https://your-test-project.supabase.co'
export LOADTEST_STORAGE_BUCKET='goblins-loadtest-work'
export LOADTEST_WORKER_ENV='APP_MODE=load-test,OCR_PROVIDER=mock,GRADING_PROVIDER=mock,MOCK_SEED=42,MOCK_FAILURE_MODE=none,MOCK_FAILURE_RATE=0,MOCK_LATENCY_MS=500,WORKER_CONCURRENCY=2,WORKER_MAX_ATTEMPTS=3,STORAGE_PROVIDER=supabase,SUPABASE_URL='$LOADTEST_SUPABASE_URL',SUPABASE_STORAGE_BUCKET='$LOADTEST_STORAGE_BUCKET',PGMQ_INSTALL_MODE=existing'

gcloud run deploy goblins-loadtest-worker \
  --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --image "$LOADTEST_IMAGE" --no-allow-unauthenticated \
  --command=node --args=dist/worker.mjs --no-cpu-throttling \
  --min-instances=1 --max-instances=1 --concurrency=1 --memory=512Mi \
  --set-secrets="DATABASE_URL=goblins-loadtest-database:latest,SUPABASE_SERVICE_ROLE_KEY=goblins-loadtest-storage-key:latest" \
  --set-env-vars="$LOADTEST_WORKER_ENV"

gcloud run deploy goblins-loadtest-web \
  --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --image "$LOADTEST_IMAGE" --allow-unauthenticated \
  --min-instances=1 --max-instances=20 --concurrency=80 --memory=1Gi \
  --set-secrets="DATABASE_URL=goblins-loadtest-database:latest,SUPABASE_SERVICE_ROLE_KEY=goblins-loadtest-storage-key:latest,WORKER_MONITOR_TOKEN=goblins-loadtest-monitor-token:latest" \
  --set-env-vars="$LOADTEST_WORKER_ENV"

export LOADTEST_BASE_URL="$(gcloud run services describe goblins-loadtest-web --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" --format='value(status.url)')"
gcloud run services update goblins-loadtest-web \
  --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --update-env-vars="APP_ORIGIN=$LOADTEST_BASE_URL"
```

Leave `MOCK_FIXED_OCR_LATENCY_MS` and `MOCK_FIXED_GRADING_LATENCY_MS` unset or at `-1`; preflight requires the seeded 500ms-base log-normal latency and rejects fixed-latency overrides.

Ensure both services use the same test `DATABASE_URL` secret and the test Supabase URL/bucket. Do not configure `OPENROUTER_API_KEY`. The preflight requires the providers to be mock, the seed to be 42, an explicit worker failure mode/rate, a matching test storage bucket, and the expected worker-instance count. It fails closed on a service/image or configuration mismatch. Cloud Monitoring read access is needed to measure actual Cloud Run worker instances; worker heartbeat counts are recorded separately and are not presented as a substitute. Scale, capacity, and failure runs fail correctness if they capture no nonzero Cloud Monitoring worker-instance sample.

For repeat runs, update the worker's configured min/max to the requested value **before** the run, leaving HTTP request concurrency and `WORKER_CONCURRENCY=2` recorded as configured. Example for the 2-instance comparison:

```bash
gcloud run services update goblins-loadtest-worker \
  --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --min-instances=2 --max-instances=2
```

Use `--min-instances=5 --max-instances=5` for the five-instance comparison. Wait until the new worker heartbeats are ready. The load runner checks the deployed service configuration and fresh ready heartbeats before sending traffic. It does not deploy or resize Cloud Run services itself.

## 3. Install Locust and configure fail-closed target guards

Use Python 3.10+ and install the pinned-range dependencies in a virtual environment. Authenticate gcloud and Application Default Credentials with permissions limited to the isolated project (Cloud Run service viewer and Monitoring viewer are sufficient for the runner):

```bash
python3 -m venv .venv-load
source .venv-load/bin/activate
python -m pip install -r tests/load/requirements.txt
gcloud auth login
gcloud auth application-default login
```

Export the following variables in the test shell. Do **not** source the app's `.env` or `.env.local`. The production values below are host/bucket identifiers only, used as deny-list guards; no production credentials are requested or read:

```bash
export LOADTEST_ENVIRONMENT=isolated
export LOADTEST_CONFIRM_ISOLATED=I_CONFIRMED_SEPARATE_LOADTEST_INFRASTRUCTURE
export LOADTEST_GCP_PROJECT='your-isolated-project-id'
export LOADTEST_GCP_REGION='us-central1'
export LOADTEST_WEB_SERVICE=goblins-loadtest-web
export LOADTEST_WORKER_SERVICE=goblins-loadtest-worker
export LOADTEST_BASE_URL="$LOADTEST_BASE_URL"
export LOADTEST_DATABASE_URL='postgresql://...test-project-only...'
export LOADTEST_EXPECTED_DATABASE_HOST='db.your-test-project.supabase.co'
export LOADTEST_PRODUCTION_DATABASE_HOST='db.your-production-project.supabase.co'
export LOADTEST_SUPABASE_URL='https://your-test-project.supabase.co'
export LOADTEST_PRODUCTION_SUPABASE_URL='https://your-production-project.supabase.co'
export LOADTEST_STORAGE_BUCKET=goblins-loadtest-work
export LOADTEST_PRODUCTION_STORAGE_BUCKET=student-work
export LOADTEST_DATABASE_SECRET_NAME=goblins-loadtest-database
export LOADTEST_STORAGE_SECRET_NAME=goblins-loadtest-storage-key
export LOADTEST_MONITOR_SECRET_NAME=goblins-loadtest-monitor-token
export LOADTEST_WORKER_MONITOR_TOKEN="$LOADTEST_WORKER_MONITOR_TOKEN"
export LOADTEST_WORKER_CONCURRENCY=2
export LOADTEST_RUN_ID="run-$(date -u +%Y%m%dT%H%M%S)"
```

`LOADTEST_DATABASE_URL` is only read by this module when that exact `LOADTEST_` variable is set; it is checked against the expected test host and the production-host deny list. Both test and production Supabase project URLs and bucket names must be different. The isolated database guard row and Cloud Run secret references are also verified. Generated session tokens and raw results go under ignored `tests/load/.state/` and `tests/load/artifacts/` directories.

Run the preflight first; it sends no load and does not need a student manifest:

```bash
python tests/load/run.py --preflight-only --cohort scale_50
```

Only proceed when it reports `Preflight PASS`. It verifies the actual Cloud Run service URL/image/config, mock-only settings, separate DB/Storage identifiers, empty pgmq queue, web readiness, and worker heartbeats.

## 4. Provision synthetic accounts through Goblins flows

Create the teacher, class, published assignments, 1,550 students, and session tokens with the existing Goblins `register`, `createClass`, and `publishPractice` application functions. This setup is not load traffic; the Locust submission, teacher, progress, image upload, and image-readback traffic goes to the real Cloud Run web service. The bootstrap honors Goblins' global registration rate limit by creating at most 100 accounts/minute; initial provisioning takes roughly 16 minutes. It never inserts user or session rows directly.

```bash
npm exec -- tsx tests/load/bootstrap.ts --run-id "$LOADTEST_RUN_ID"
```

The resulting manifest contains valid bearer-equivalent session tokens. Keep it private and use it only against the isolated Cloud Run service. Do not attach it to a ticket or commit it. Session expiry is seven days. Use a fresh `LOADTEST_RUN_ID` and fresh isolated database/assignment set for a new bootstrap.

## 5. Run the staged tests

Run all three sequential baseline sizes with one worker instance:

```bash
python tests/load/run.py --plan scale
```

The 1,250-student cohort is a five-minute ramp plus ten-minute sustain; the queue is observed during load and after Locust stops. Each run refuses to reuse a consumed one-attempt question or start while the isolated queue is non-empty. Every run writes raw Locust CSV, logs, counters, time-series JSONL, generated PNG plots, a machine-readable summary, and `report.md` into its own ignored directory under `tests/load/artifacts/`.

The following cohorts need the matching worker service configuration and failure mode/rate before each run. Run one at a time; the runner verifies the worker configuration and will refuse a mismatch:

```bash
# Approval smoke test (one student, one teacher approval after an unreleased grade)
python tests/load/run.py --plan approval

# Capacity comparisons: change worker min/max to exactly 2, then exactly 5.
python tests/load/run.py --cohort capacity_250_2_workers
python tests/load/run.py --cohort capacity_250_5_workers

# Failure experiments, all at one worker instance and WORKER_CONCURRENCY=2.
python tests/load/run.py --cohort failure_baseline_250
# Set MOCK_FAILURE_MODE=transient and MOCK_FAILURE_RATE=0.05 on both services, then:
python tests/load/run.py --cohort failure_transient_5pct_250
# Update the rate to 0.1 on both services, then:
python tests/load/run.py --cohort failure_transient_10pct_250
# Set MOCK_FAILURE_MODE=permanent and MOCK_FAILURE_RATE=0.05 on both services, then:
python tests/load/run.py --cohort failure_permanent_5pct_250

# Hard-cutoff/manual-recovery test. The worker provider timeout must exceed the 25s run deadline.
gcloud run services update goblins-loadtest-worker --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --update-env-vars=MOCK_FAILURE_MODE=timeout,MOCK_FAILURE_RATE=0.5,WORKER_LEASE_SECONDS=30,OCR_TIMEOUT_MS=60000,GRADING_TIMEOUT_MS=60000,WORKER_HEARTBEAT_INTERVAL_MS=15000
gcloud run services update goblins-loadtest-web --project "$LOADTEST_GCP_PROJECT" --region "$LOADTEST_GCP_REGION" \
  --update-env-vars=MOCK_FAILURE_MODE=timeout,MOCK_FAILURE_RATE=0.5
python tests/load/run.py --cohort failure_hard_cutoff_manual_20

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
