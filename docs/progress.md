# Progress against v5

Authoritative plan: [product-plan-v5.md](product-plan-v5.md). Phases are dependency-ordered milestones, not calendar periods. The earlier v3 phase order is historical.

## Current checkpoint

**Phase 5's local review/status/approval workflow is implemented and regression-tested**, including the requested multiple assignments/problems and separate student/assignment navigation. Infrastructure is being handled by the operator. No completed Cloud Run rollout is claimed by the coding agent.

Measured locally:

- **69/69** service/unit/integration tests.
- **12/12** production Chromium scenarios using the separate compiled worker.
- Clean typecheck, lint, web production build and worker bundle.
- Actual PostgreSQL SIGKILL/restart recovery: two attempts, one logical grade, `waiting_for_teacher`.
- A separately opted-in **real Gemini → GPT-6 Luna synthetic-image inference smoke passed**, one grading attempt, expected 10/10 and expected OCR transcription. This is functional evidence, not a quality benchmark.
- Production dependency audit: zero advisories at the verification run.

## Phase 1 — Foundation

Implemented locally: Next.js/TypeScript/Effect, PostgreSQL/Drizzle, auth/class/join flow, server-only configuration, pgmq setup, Supabase-compatible RLS/role protections, private storage adapters/setup, Cloud Run deployment preparation and readiness endpoints. Redis/BullMQ are not used.

The operator supplied Supabase project `https://chixlvbkzlscdrafzeds.supabase.co` and is handling production infra. Remote schema/Storage/Cloud Run rollout has not been verified by local tests. Local tests explicitly use local test databases, not production credentials.

## Phase 2 — Durable pipeline

Implemented and tested: repository/queue/OCR/grading/storage Context services and Layers, canonical schemas, real pgmq enqueue/claim/archive, transactional acceptance, bounded concurrency/deadlines, retries/jitter/Retry-After, run fencing, idempotency, and explicit failures. Fixtures and seeded latency/failure simulators remain available **only in explicitly selected test/load-test mode**.

Remote mock-backed capacity/recovery testing remains Phase 6 work; local functional checks are not cloud throughput measurements.

## Phase 3 — Product workflow

Implemented: multiple assignments per class; up to 30 ordered problems per assignment; distinct expected answers, worked solution, instructions and rubric per problem; add/remove/reorder authoring; mandatory per-problem rubric approval; approved problem editors collapse and require re-approval after editing. Published versions remain immutable and submissions retain exact question/rubric version references.

Students have typed/canvas submission, private original PNG storage/retrieval, cross-device identity, and one attempt per problem. Separate Students/Assignments boxes lead to scoped detail views. The publishing form remains below the assignments list after publication. Publication keys prevent duplicate assignment creation on retries.

## Phase 4 — Live inference

Implemented and exercised: OpenRouter Gemini image OCR and GPT-6 Luna text grading, same orchestration and validators as mocks, separate model/token/timeout settings, bounded responses, abortable requests, typed safe errors and server-only keys. Typed work skips paid OCR. GPT-6 Luna requests omit unsupported `temperature`.

Normal defaults are live (`google/gemini-3.5-flash`, `openai/gpt-6-luna`). Normal workers reject mock providers unless an explicit test/load-test profile is selected. Both model IDs/capabilities were checked against the catalog, and the real synthetic-image smoke passed using the existing key.

The proposed 18-case quality manifest remains unreviewed. Human-reviewed grading/handwriting quality and cost calibration are **not** established by the smoke result. The quality CLI still requires explicit review/paid-run opt-in.

## Phase 5 — Review, status and release

Implemented locally:

- Student-centric class overview plus assignment-centric and student-specific views.
- Per-problem statuses, including Not submitted, plus assignment submission progress and aggregate status after all problems are submitted.
- Approved-so-far, optional provisional, and final totals without exposing hidden drafts or counting failures as zeros.
- Default-off per-assignment draft visibility, editable after publication in separate mutable settings (grading definitions remain immutable).
- Evidence deck with student/assignment/problem context, original typed/image work, faithful OCR, rubric maxima, criterion explanations, confidence, alternatives and review reasons.
- Citation-to-line highlighting, previous/next controls and keyboard navigation; unsaved corrections block deck navigation until saved/discarded.
- Editable criterion scores and feedback, mandatory correction reason, preserved original AI result, append-only who/what/when/reason history.
- Optimistic review revision checks; stale saves/approvals are rejected rather than silently overwriting another review.
- Explicit approval/release for every problem; failed work cannot be approved as a grade.
- Immutable released grades and original AI results; final assignment totals only when every problem is approved.
- Finalized-only assignment aggregates and student final feedback after fresh-browser login.

Regression fixes completed: explicit textarea labels, a browser-test URL navigation race, and optimistic draft-visibility checkbox state. The full 12-scenario suite passed after those fixes.

## Remaining / not claimed

- Remote production deployment and acceptance checks: operator-owned infra work.
- Phase 6: Locust CLI suite and deployed burst/soak/failure measurements.
- Human-reviewed OCR/grading benchmark and actual cost reporting.
- Post-publication version editor/regrade UI, password recovery, deletion/retention/reference-aware orphan cleanup, representative demo seed and further operational hardening.

No user-facing delete/regrade workflow is claimed. Existing 11 moderate development-only toolchain advisories remain separate from the clean production audit; no forced breaking downgrade was applied.

**Infra handoff:** include and apply `drizzle/0003_multiple_problems_and_teacher_review.sql` before rolling out the updated app/worker. Keep secrets out of Git/build contexts and do not mix live/mock workers on a queue. See docs/deployment.md and docs/testing.md.
