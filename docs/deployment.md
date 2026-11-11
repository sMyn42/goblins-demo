# Production deployment handoff

Target: **Cloud Run web app + separately deployed Cloud Run inference worker**, backed by durable Supabase PostgreSQL/pgmq and private Storage. Infrastructure setup is being handled by the operator; the coding agent has not executed or verified the remote rollout.

Supabase project supplied by the operator: `https://chixlvbkzlscdrafzeds.supabase.co`. This public project URL is not a database connection string or a server-side storage credential.

## Production configuration

Keep secrets in ignored configuration/Secret Manager, never chat, Git, build arguments or browser variables. Reuse the already-entered `OPENROUTER_API_KEY` from `.env`/`.env.local`; no second key entry is required.

The deployment preflight uses these names:

```dotenv
GCP_PROJECT=your-project-id
GCP_REGION=your-chosen-region
CLOUD_DATABASE_URL=your-hosted-postgres-connection-string
SUPABASE_URL=https://chixlvbkzlscdrafzeds.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-side-storage-credential
SUPABASE_STORAGE_BUCKET=student-work
OPENROUTER_OCR_MODEL=google/gemini-3.5-flash
OPENROUTER_GRADING_MODEL=openai/gpt-6-luna
```

`CLOUD_DATABASE_URL` is deliberately separate from local `DATABASE_URL`. Local `APP_ORIGIN=http://localhost:3000` is not reused for the cloud origin. Optional `CLOUD_APP_ORIGIN` selects an exact HTTPS custom origin; otherwise the script uses the generated Cloud Run URL. Optional `GCP_REPOSITORY` defaults to `goblins`; `GCP_SERVICE_ACCOUNT` can name an existing runtime identity.

Do not replace server credentials with Supabase anonymous/browser keys. Restrict the runtime service account and secret grants to the required backend resources. Configure TLS/private networking/backups appropriately. Supabase transaction-pooler compatibility is supported by disabling prepared statements in the SQL client; choose a connection endpoint reachable from Cloud Run.

## Release ordering — important

The updated product requires all checked-in migrations, particularly:

- `0002_multiple_assignments_and_publication_keys.sql`
- **`0003_multiple_problems_and_teacher_review.sql`**

Include the new migration and snapshot/journal files in the release. Apply migrations once **before** rolling out updated web/worker replicas; do not run independent migrations from every replica. Existing assignment/question/rubric IDs, original work and grades are preserved.

The latest migration removes the single-problem restriction, adds ordered questions/instructions, separate mutable visibility settings, reviewed results/revisions and append-only correction history. It protects original AI results/released grades and enables RLS/revokes browser-role access on the new private tables.

For Supabase, enable Queues/pgmq and use a trusted backend SQL role with the required ownership/BYPASSRLS and table/queue permissions. Anonymous/authenticated browser roles have no direct access. Existing pgmq is never silently replaced. Local `PGMQ_INSTALL_MODE=sql` uses the pinned official SQL-only distribution; cloud setup defaults to the native extension and can be explicitly selected with `CLOUD_PGMQ_INSTALL_MODE=existing|extension|sql` as appropriate.

## Private image storage

Configure `STORAGE_PROVIDER=supabase` for **both** web and worker. Run `npm run setup:storage` with production server credentials to create/verify the private bucket. New buckets are PNG-only with a 2 MB limit; public existing buckets are rejected.

Cloud Run local disk is ephemeral; the app refuses local image storage when `K_SERVICE` is present. Private originals are retrieved only through authorized application endpoints. Database and Storage credentials stay on the server.

## Deployment automation

With an installed/authenticated Google Cloud CLI and explicit target configuration:

```sh
npm run cloud:check             # no resource creation or inference
npm run deploy:cloud            # actual billed deployment operations
```

The script requires production configuration and an active GCP login. It:

1. Enables required Cloud Run/Build/Artifact Registry/Secret Manager APIs and creates the selected repository/runtime identity if needed.
2. Uploads existing secret **values through stdin**, not command-line arguments; grants the runtime identity secret access and pins secret versions.
3. Builds runtime and tools images remotely with `cloudbuild.yaml` (local Docker is not required for this path).
4. Runs a Cloud Run release job to migrate the database and verify private Storage before app rollout.
5. Deploys the public HTTPS web app, then pins `APP_ORIGIN` to its URL/custom origin.
6. Deploys the private, long-lived inference worker with real Gemini/OpenAI providers and the OpenRouter key supplied only to the worker.
7. Checks web readiness. Manual end-to-end acceptance is still required; CLI success alone is not a classroom-readiness claim.

The script can create billable resources. Cloud Build's identity must be able to push to the chosen repository, and the deploying identity must have the necessary API/Run/IAM/Secret Manager permissions. Do not solve permission errors by making private data public or granting broad anonymous access.

`bash scripts/deploy-cloud-run.sh` delegates to the same TypeScript command. The script has not been exercised against a real GCP project by the coding agent. Container files are supplied but were not run locally because Docker was unavailable.

## Cloud Run runtime requirements

- Web: `npm start`, production HTTPS/Secure/HttpOnly/SameSite cookies, exact `APP_ORIGIN`, server-only DB/storage credentials.
- Worker: `node dist/worker.mjs`, instance-based CPU allocation (`--no-cpu-throttling`), at least one warm instance, bounded instance count/concurrency. Request-only CPU/scale-to-zero is not sufficient for this polling design.
- Both: matching DB and Storage, stable immutable build artifacts, correct model/config settings. Cloud Run supplies each process's `PORT`.
- Normal worker profile: `APP_MODE=normal`, `OCR_PROVIDER=openrouter`, `GRADING_PROVIDER=openrouter`. Live inference incurs provider charges. Do not attach a mock worker to the production queue.
- Worker `/health` is liveness; `/ready` reflects a recent successful queue poll. Web `/api/ready` checks DB/queue access with a deadline. Verify platform probes and the updated schema on the target.
- For multiple web replicas/rolling builds, follow Next.js guidance for a stable shared `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` and consistent build artifacts.

Git, Docker and Cloud Build upload contexts exclude `.env*` secrets, `.data`, traces and artifacts. Do not check rendered secret-bearing environment files into source control. Pin/review image digests for a hardened production release.

## Acceptance checks after rollout

1. Verify migrations, private bucket, web/worker readiness, and safe logs.
2. Create teacher/class, publish an assignment with two approved problems; join from a separate student browser.
3. Submit typed and image work; verify original private image access and per-problem status.
4. Confirm assignment remains In progress until all problems are submitted, then follows grading status.
5. Test draft visibility off/on without leaking hidden numeric totals.
6. Correct a score/feedback, inspect original AI grade and who/what/when history, and confirm stale revisions cannot overwrite it.
7. Approve one problem: no final assignment total yet. Approve the rest: final total/feedback appears, including on a fresh device/login.
8. Verify failed work cannot be approved as a zero and can be retried after recovery.
9. Interrupt/restart the worker and verify one logical result after lease recovery.

For load testing, use a **separate** deployed stack/queue/storage with explicit test/load-test profile and mocks. Phase 6 Locust tests must exercise actual cloud pgmq/workers, not a bypass. Local functional tests and a single real synthetic inference smoke do not prove remote capacity or broad model quality.

## Remaining production hardening

Human-reviewed grading/handwriting quality and cost calibration; reference-aware orphan/deletion/retention workflows; provider/DB/queue alerts and budgets; edge abuse protection; operational recovery drills; and deployed load measurements. Password recovery, deletion UI and post-publication regrade/version editing are not implemented. Obtain appropriate consent before sending real student work through OpenRouter/Google/OpenAI.
