# Goblins

An introductory-algebra grading workspace built with **TypeScript, Effect 3, Next.js, Drizzle/PostgreSQL, and pgmq**. The UI uses a plain typeface, hunter green/warm neutrals, and direct Student/Teacher account entry.

**Current state:** the local product workflow and Phase 5 review/approval UX are implemented and regression-tested. **Normal operation uses real OpenRouter inference**: `google/gemini-3.5-flash` for image OCR and `openai/gpt-6-luna` for text grading. Tests/load tests select mocks explicitly. Remote infrastructure is being handled separately; no completed Cloud Run rollout is claimed by this checkout.

Worker readiness uses independent DB/queue probes and persisted progress keepalives, not batch completion. See [worker health and long-tail reproduction](docs/worker-health.md). Apply migration `0004_worker_progress_heartbeats.sql` before rollout.

Specification: [v5](docs/product-plan-v5.md). [Progress](docs/progress.md) · [Testing](docs/testing.md) · [Deployment](docs/deployment.md).

[Review deck screenshot](docs/screenshots/review-deck.png) · [Multi-problem student view](docs/screenshots/multiple-problems.png). Screenshots use synthetic mock-backed browser-test accounts, not real-model quality evidence.

## Run locally

Requirements: Node.js 22+ (24 recommended), npm, PostgreSQL 14+. Redis is not used.

```sh
npm ci
createdb goblins                 # skip if it already exists
```

Keep local configuration in **`.env.local`** and preserve any existing key in **`.env`**. Both are ignored; `.env.local` takes precedence, then `.env`, while exported variables override both.

```dotenv
DATABASE_URL=postgres://localhost:5432/goblins
APP_ORIGIN=http://localhost:3000
PGMQ_INSTALL_MODE=sql
STORAGE_PROVIDER=local
APP_MODE=normal
OCR_PROVIDER=openrouter
GRADING_PROVIDER=openrouter
OPENROUTER_OCR_MODEL=google/gemini-3.5-flash
OPENROUTER_GRADING_MODEL=openai/gpt-6-luna
```

`OPENROUTER_API_KEY` must be available server-side. If it is already in `.env`, **do not enter or duplicate it again**. Never use a `NEXT_PUBLIC_` variable for it.

```sh
npm run db:migrate
npm run dev
# Separate terminal, same directory:
npm run worker
```

Open <http://localhost:3000>. Web and worker must both run: the API persists/enqueues answers but never grades inline. If the worker is stopped, accepted work stays durably submitted until processing resumes. Restart the worker after changing provider configuration; normal submissions incur provider charges.

Worker health/readiness defaults to port 8081. Set `PORT` for the individual worker process, not in a shared dotenv file used by Next.js. Local web and worker must share `.data/images`.

`PGMQ_INSTALL_MODE=sql` installs pinned **official pgmq SQL** on a fresh local database, not a queue emulator. Existing pgmq is never silently overwritten/upgraded. On Supabase, enable Queues and select `existing` or use the reviewed release setup. [Vendor provenance](vendor/pgmq/README.md).

## Teacher/student workflow

1. Teacher creates an account/class and shares the `XXXX-XXXX-XXXX` join code.
2. The class dashboard has separate **Students** and **Assignments** boxes. The publishing form remains below the assignments list.
3. Add problems, edit prompts, expected answers, teacher solutions, grading instructions, point limits and rubric criteria. Approve each problem’s rubric: its editor collapses. Editing requires re-approval. Publish only when all problems are approved.
4. Students join/sign in from another browser/device, select an assignment, and submit typed work or use the basic mouse/stylus/touch canvas for each problem.
5. Each problem always shows its status. The assignment shows collection progress, then its overall grading status after every problem has been submitted. Processing failure is distinct from a zero score.
6. Teachers select a student for cross-assignment progress, or an assignment for class-wide progress. Open **Review pending answers** for the evidence deck.
7. Review original work, ordered OCR lines, criterion scores/explanations, cited evidence, AI confidence/review reasons, and alternative reasoning. Correct criterion scores/feedback if needed, enter a correction reason, save, then explicitly approve/release each problem.
8. Students see final scores/feedback after approval. The assignment’s total becomes final only when **all** problems are finalized. Before that, available totals are labelled approved-so-far or provisional; hidden drafts do not leak through totals.

There are multiple assignments per class and up to 30 problems per assignment. Each problem has one attempt per student. Published question/rubric versions are immutable and existing submissions retain their exact versions. Unpublished editor state is browser-memory-only.

### Review and release safeguards

- Student-centric class overview remains the default; the review deck is an additional view.
- The deck prioritizes failed, uncertain and incorrect work, with previous/next navigation and keyboard shortcuts. Evidence links highlight corresponding OCR lines.
- Every auto-grade waits for teacher approval. High-confidence correct work is not auto-released.
- Draft visibility defaults off and can be changed per assignment without mutating its grading definitions.
- Corrections preserve the original AI grade and create append-only who/what/when/reason history. Server-side point/criterion validation and optimistic revision checks reject stale saves/approvals.
- Released grades are immutable. Provider failures cannot be approved as completed grades; they can be retried safely after recovery.
- Class averages/highest/lowest include only fully finalized assignment totals.

## Inference and tests

Normal defaults are **live**, not mocks. Models and limits remain configurable:

```dotenv
APP_MODE=normal
OCR_PROVIDER=openrouter
GRADING_PROVIDER=openrouter
OPENROUTER_OCR_MODEL=google/gemini-3.5-flash
OPENROUTER_GRADING_MODEL=openai/gpt-6-luna
OCR_TIMEOUT_MS=15000
GRADING_TIMEOUT_MS=20000
OCR_MAX_TOKENS=4096
GRADING_MAX_TOKENS=4096
```

Typed work bypasses paid OCR. Images are sent to Gemini through OpenRouter; grading uses the approved question/solution/rubric and a configurable OpenAI model. Both adapters use chat completions and shared canonical schema/score/evidence validation. Student/OCR content is isolated as untrusted data, not instructions. GPT-6 Luna requests omit unsupported `temperature`.

```sh
npm run verify:models           # free catalog lookup, no inference
npm run smoke:inference         # no-cost preflight unless explicitly opted in
```

A **paid synthetic image smoke check already passed** through real pgmq → Gemini OCR → GPT-6 Luna → persisted provisional grade: one attempt, expected 10/10, exact expected transcription. It did not auto-release a grade. This proves connectivity and a basic functional path, **not** general handwriting/grading quality. The larger 18-case proposed benchmark still requires human review.

Mocks require an explicit `APP_MODE=test` or `APP_MODE=load-test` plus mock provider flags. Normal workers reject mock providers instead of silently returning fixtures. Unconditional mock warnings have been removed from normal publishing/submission UI; actual historical mock results remain truthfully labelled.

```sh
# Explicit mock/load-test worker, separate from normal grading:
APP_MODE=load-test OCR_PROVIDER=mock GRADING_PROVIDER=mock npm run worker
```

Use a **separate test database/storage** for mocks—do not run live and mock workers against the same queue. Mock images use a fixed fixture transcription, and unknown fixture input becomes an explicit failure, never a made-up zero. Details and failure injection: [docs/testing.md](docs/testing.md).

## Architecture

```text
Browser → Next.js UI/API → Effect services
  → PostgreSQL identities, immutable assignment/question/rubric versions,
    per-problem statuses/run fences, canonical OCR, original/reviewed grades,
    mutable draft-visibility settings and append-only correction history
  → PrivateStorage (local development / Supabase production)
  → one DB transaction: accepted problem submission + pgmq.send(ID)

Separate Effect worker → pgmq visibility claim + DB run fence
  → OCR → deterministic criterion checks → LLM judgment → shared validation
  → transactional grade + waiting_for_teacher → archive/ack

Teacher save/approve (revision checked) → final problem feedback
  → final assignment total only when every problem is approved
```

Queue payloads contain IDs only. Bounded batches/concurrency, deadlines, exponential/jittered retries, Retry-After handling and run fencing protect at-least-once processing. Duplicate delivery does not duplicate grades/events; failures do not fabricate scores. Deterministic evaluators are allowlisted exact/accepted-text and narrow numeric checks, never arbitrary teacher code. A mismatch does not rule out partial credit or valid alternative reasoning.

Code: `src/grading/`, `src/db/`, `src/components/`, `src/storage/`, `src/server/`, and independent `src/worker/main.ts`.

## Migrations and verification

```sh
npm run db:generate -- --name=describe_your_change
npm run db:migrate
npm run typecheck
npm run lint
npm test
npm run build
npm run build:worker
```

The migration sequence is descriptive and preserves existing work:

- `0000_auth_and_classes.sql`
- `0001_mock_grading_pipeline.sql`
- `0002_multiple_assignments_and_publication_keys.sql`
- **`0003_multiple_problems_and_teacher_review.sql`** — required before deploying the new app/worker. It includes multi-problem ordering, review revisions/results, visibility settings, protected audit history and RLS.

Use a trusted server-only SQL role with the required ownership/BYPASSRLS and table/pgmq privileges. Browser Supabase roles have no direct access to private application/queue data. Apply migrations once as a release step, not from every replica.

```sh
createdb goblins_e2e
DATABASE_URL=postgres://localhost:5432/goblins_e2e PGMQ_INSTALL_MODE=sql npm run db:migrate
npx playwright install chromium
TEST_DATABASE_URL=postgres://localhost:5432/goblins_e2e E2E_PRODUCTION=1 npm run test:e2e
TEST_DATABASE_URL=postgres://localhost:5432/goblins_e2e npm run test:recovery
```

Verified locally: **69 service/unit/integration tests**, **12 production Chromium scenarios**, clean types/lint/builds, and actual worker SIGKILL/restart recovery with two attempts and exactly one logical grade. Production npm audit has zero advisories at verification time; the existing 11 moderate development-toolchain advisories remain separately documented.

Tests explicitly choose mocks and launch the actual separate compiled worker against dedicated PostgreSQL. They do not make paid model calls. The live smoke and human-reviewed quality CLI are separately opt-in. [Testing instructions](docs/testing.md).

## Production handoff and remaining work

The production target is **Cloud Run web + separate Cloud Run inference worker**, with durable Supabase PostgreSQL/pgmq and private Storage. The supplied Supabase project is recorded in the deployment handoff; infrastructure setup/auth/secrets are being handled by the operator. **Remote deployment has not been verified by these local checks.** [Deployment instructions](docs/deployment.md).

Cloud Run needs Supabase Storage rather than ephemeral local files, and the polling worker needs instance-based CPU/minimum instances. Keys remain server-side and are never part of client bundles or build contexts. Live mode sends work through OpenRouter to Google/OpenAI; obtain appropriate consent before real classroom use.

Remaining: deployed Locust load/failure testing (Phase 6), a human-reviewed grading/handwriting benchmark, post-publication version/regrade UI, retention/deletion/reference-aware orphan cleanup, operational hardening and remote deployment verification. No full LMS, multiple attempts, password recovery, or sophisticated drawing tools are claimed.

Images are private/immutable. Storage-first persistence can leave an orphan after ambiguous failures; do not delete files until checking DB references and a safety window. There is no deletion UI yet. Published grading definitions, released grades and correction history have restrictive database protections.
