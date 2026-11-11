# Testing and acceptance

## What has been verified

- **69/69** service/unit/integration tests.
- **12/12** production Chromium browser scenarios, using an actual separate compiled worker.
- TypeScript, ESLint, Next production build and worker bundle.
- Real PostgreSQL worker SIGKILL/restart recovery: two attempts, one logical grade, durable `waiting_for_teacher` result.
- Production dependency audit: zero advisories at verification time.
- Both requested model IDs/capabilities checked in the OpenRouter catalog.
- A separately opted-in **paid synthetic-image smoke** through real pgmq → Gemini OCR → GPT-6 Luna → persisted provisional 10/10, one grading attempt, expected transcription. This is not a handwriting/grading quality benchmark.

Production cloud infrastructure is handled separately. These local checks do not establish remote deployment, throughput, capacity, broad model quality, or measured inference cost.

## Normal workflow: real inference

Normal defaults are live. Keep the existing `OPENROUTER_API_KEY` in ignored `.env`/`.env.local`; do not paste it into chat or expose it with `NEXT_PUBLIC_`.

```dotenv
APP_MODE=normal
OCR_PROVIDER=openrouter
GRADING_PROVIDER=openrouter
OPENROUTER_OCR_MODEL=google/gemini-3.5-flash
OPENROUTER_GRADING_MODEL=openai/gpt-6-luna
```

Run the app and worker separately. If no worker is running, accepted submissions remain durably submitted until it returns. Restart workers after configuration/code changes.

Teacher: create class → add/edit problems and rubrics → approve each rubric (problem collapses) → publish. Student: join/select assignment → submit typed/canvas work per problem. Teacher: select student or assignment → open review deck → inspect/correct/save → approve/release each problem.

Every problem always has a status. Assignment status remains Not submitted/In progress while problems are missing, then reflects submitted/processing/auto-grading/waiting-for-teacher/failure/finalized state once all problems are submitted. Short-lived stages may pass between polls; the UI reads authoritative persisted states rather than inventing local progress.

Totals are labelled:

- **Approved points so far:** released problems only; remaining grades pending.
- **Provisional total/points so far:** only when draft results are visible under the teacher's setting.
- **Final assignment total:** only when every problem is finalized.

Provider failures never create a zero score. A genuine zero score from completed grading remains provisional until teacher approval.

## Automated local suite (no model charges)

The browser harness explicitly sets `APP_MODE=test` and both mock provider flags for web/worker. Service tests inject mock/config Layers; HTTP contract tests simulate transport responses. The SQL/queue is real pgmq, not an in-memory fake.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run build:worker

createdb goblins_e2e             # skip if it already exists
DATABASE_URL=postgres://localhost:5432/goblins_e2e PGMQ_INSTALL_MODE=sql npm run db:migrate
npx playwright install chromium
TEST_DATABASE_URL=postgres://localhost:5432/goblins_e2e E2E_PRODUCTION=1 npm run test:e2e
```

Do not use a production database here. Playwright launches the web and compiled worker on ports 3100/3120 using `.data/e2e-images`. It leaves uniquely named synthetic accounts/results for inspection. If a dev server is already running, use the production-mode browser command rather than stopping someone else's server.

Coverage includes auth/ownership/cookie safeguards, form preservation/styling, transaction rollback, duplicates, run fencing, immutable versions, multi-assignment/multi-problem references, rubric approval/collapse, live-polled statuses, private image access, mock failure handling, live HTTP contracts, draft redaction/toggling, score limits, correction history, stale/concurrent review rejection, explicit release, and fresh-browser feedback.

The multi-problem browser scenario verifies keyboard navigation/evidence highlighting, audited score correction, per-problem status, partial collection progress, all-submitted assignment status, provisional/approved/final totals, and no final total before all problems are approved. Screenshots are synthetic test data.

The malicious cross-origin test intentionally prints a framework rejection log. To refresh screenshots, add `UPDATE_SCREENSHOTS=1` to the browser command.

### Actual process interruption

```sh
npm run build:worker
TEST_DATABASE_URL=postgres://localhost:5432/goblins_e2e npm run test:recovery
```

Uses port 3130, kills the actual worker with SIGKILL after processing starts, waits beyond the real queue/run lease, restarts, and asserts one logical grade after two attempts. It writes ignored `artifacts/recovery-report.json`. No model calls occur; the child worker explicitly uses the test profile.

## Explicit mock/load-test mode

Never run mock and live workers against the same database/queue. Use an isolated test database and matching web/worker settings:

```sh
APP_MODE=load-test OCR_PROVIDER=mock GRADING_PROVIDER=mock npm run worker
```

Normal workers reject mock providers. Load-test mode keeps the same request/response schemas, queue, orchestration, validators, persistence and review path. Mock images return a fixed fixture transcription regardless of pixels; they are not OCR intelligence. Unknown mock inputs/contracts fail explicitly rather than fabricate scores. Historical mock results remain truthfully labelled even after the app switches to live mode.

Default fixture question: **Solve x + 3 = 7. Show your work.** Rubric: answer 4 points, subtraction work 6 points. Exact typed fixtures:

| Work | Expected mock score |
|---|---|
| `x + 3 = 7` newline `x = 7 - 3` newline `x = 4` | 10 |
| `x = 4` | 4 |
| `4` | 4 |
| `x + 3 = 7` newline `x = 7 - 3` newline `x = 5` | 3 |
| `x = 5` | 0 |

One attempt per student/problem; use different synthetic students or problems to compare fixtures.

### Failure injection

These examples must also select the mock/load-test profile and an isolated test database. Existing secrets remain unchanged.

```sh
APP_MODE=load-test OCR_PROVIDER=mock GRADING_PROVIDER=mock MOCK_FAILURE_MODE=transient MOCK_FAILURE_RATE=1 npm run worker
APP_MODE=load-test OCR_PROVIDER=mock GRADING_PROVIDER=mock MOCK_FAILURE_MODE=malformed MOCK_FAILURE_RATE=1 npm run worker
APP_MODE=load-test OCR_PROVIDER=mock GRADING_PROVIDER=mock MOCK_FAILURE_MODE=timeout MOCK_FAILURE_RATE=1 OCR_TIMEOUT_MS=100 npm run worker
APP_MODE=load-test OCR_PROVIDER=mock GRADING_PROVIDER=mock MOCK_FAILURE_MODE=permanent MOCK_FAILURE_RATE=1 npm run worker
```

After fixing the profile and restarting the test worker, teacher **Retry grading** safely re-enqueues a failed problem. No failed answer can be approved as a completed grade. `MOCK_SEED`/`MOCK_LATENCY_MS` control seeded log-normal latency and bounded tails independently of fixture correctness.

## Real inference smoke and quality evaluation

`npm run verify:models` performs a free catalog lookup, not inference.

`npm run smoke:inference` is a no-inference preflight by default. To explicitly repeat the small paid synthetic-image test, use a **dedicated migrated database whose name ends in `_live_smoke`**, with an empty queue:

```sh
createdb goblins_live_smoke      # skip if it already exists
DATABASE_URL=postgres://localhost:5432/goblins_live_smoke PGMQ_INSTALL_MODE=sql npm run db:migrate
ALLOW_LIVE_SMOKE=1 TEST_DATABASE_URL=postgres://localhost:5432/goblins_live_smoke npm run smoke:inference
```

This renders synthetic algebra as a PNG, preserves it privately, submits/enqueues through the application, and runs the production worker orchestration with real providers. It does not approve/release a grade. Results go to ignored `artifacts/live-smoke-report.json`. It exercises real inference and can incur charges; it is not part of the automatic unit/browser suite.

For quality evaluation, human-review `tests/quality/cases.json`, correct its 18 proposed score ranges, and fill `reviewedBy`/`reviewedAt`. Then explicitly opt in with `ALLOW_LIVE_EVAL=1 npm run eval:quality`. Without review/opt-in, the CLI performs no inference. The report covers score-range agreement, midpoint MAE, false-positive full credit, alternative-method agreement, latency and failures.

That initial quality manifest is text-only: typed OCR bypasses inference. A separate human-reviewed handwriting/transcription dataset is required before claiming OCR quality. Inspect OpenRouter billing/usage for actual cost; the scripts do not fabricate measured token/image costs. The synthetic smoke does not replace that benchmark.

## Data and rollout safety

Images are private and original bytes are retained. A storage-first submission can leave an orphan after ambiguous failures; cleanup must wait a safety window and verify DB references. Do not blindly delete images or reset another person's classroom DB. Deletion/regrade/retention UI is not implemented.

For production, include/apply **`0003_multiple_problems_and_teacher_review.sql`** before deploying the updated app/worker. It adds problem ordering, reviewed grades/revisions, visibility settings, append-only history and protections. Use Supabase Storage, not ephemeral Cloud Run local disk. Production credentials/infra operations are intentionally separate from this local regression suite.
