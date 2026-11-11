# Goblins AI Auto-Grader — Product & Engineering Plan
**Updated: November 10, 2026 — revised for Effect, Gemini OCR, teacher approval, and Locust load testing**

## 1. Executive summary

Build a publicly hosted, teacher-focused AI auto-grader around one complete classroom workflow:

**Create → Assign → Collect → Grade → Review → Return feedback → Reuse.**

The product hypothesis: teachers will reuse an AI grader when it meaningfully reduces grading time while preserving grading quality, useful feedback, and teacher control.

This is a **minimum complete workflow**, not a miniature LMS. Keep the user-facing loop coherent while constraining implementation: one supported subject/problem domain, one OpenRouter-routed Gemini vision/OCR model, one OpenRouter-routed OpenAI text-grading model, a small deterministic evaluator registry, one class per student, and one attempt per assignment.

The differentiating experience is the teacher's **class review deck**: an efficient, evidence-backed way to inspect questionable answers, correct grades, and return feedback.

## 2. Product hypothesis and validation

### Core questions
- Can a teacher create and publish an assignment in under three minutes?
- Can a student join and submit without assistance?
- Can a typical class be graded without the teacher inspecting every answer?
- Can a teacher review flagged answers faster than grading everything manually?
- Does the teacher trust the grade evidence and feedback enough to publish another assignment?

### Product metrics
Track teacher signup, class creation, assignment publication, first student join, first submission, grading completion, review opened, override made, feedback released, and second assignment published.

Derived measures:
- Time from signup to first published assignment.
- Time from publication to first submission.
- Time from final submission to grading completion.
- Time spent reviewing flagged answers.
- Fraction of submissions requiring review.
- Fraction of AI grades overridden, overall and by criterion.
- Second-assignment publication rate.

The strongest early retention signal is **a teacher publishing a second assignment**, not merely logging in or complimenting the demo.

## 3. Scope and non-goals

### MVP scope
- Teacher account creation/login.
- Teacher creates one class and shares a join code.
- Student joins that class with a simple account.
- Teacher creates an assignment with editable questions, expected answers, teacher solutions, and rubric.
- Teacher approves a generated or manually authored rubric before publishing.
- Student submits handwritten work on a basic canvas, with typed fallback.
- Submission is persisted and graded asynchronously.
- Student and teacher see explicit grading-status transitions.
- Teacher approves every grade before it becomes final; an assignment-level setting optionally allows students to see a clearly labelled draft grade while awaiting approval.
- OCR extracts ordered answer lines and preserves the source image.
- Hybrid grading combines deterministic checks and LLM judgment.
- Teacher sees class progress and a review deck for incorrect, ambiguous, low-confidence, or failed answers.
- Teacher edits scores/feedback and releases finalized results.
- One attempt per student per assignment.

### Non-goals
No full LMS, calendars, broad analytics, multiple attempts, multiple classes per student, real-time tutoring, universal subject support, arbitrary teacher code, general-purpose rules engine, multiple OCR/LLM vendors, sophisticated drawing editor, advanced queue admin UI, multi-region deployment, sharding, or enterprise identity.

### Narrow the domain
Start with one domain where text/equations are sufficient and deterministic checks are useful, such as introductory algebra. State what is and is not supported. A reliable narrow grader is better than a universal grader that silently fails on edge cases.

## 4. User journeys and UX

### Teacher journey
1. Create account and sign in.
2. Create a class and get a join code.
3. Create an assignment.
4. Add/edit questions, expected answers, teacher solutions, and point values.
5. Draft a rubric with AI or author one manually.
6. Inspect and approve the rubric.
7. Publish and share the class code.
8. Monitor submissions and grading status.
9. Open the review deck.
10. Correct grades and feedback.
11. Release finalized results.
12. See class progress and create the next assignment.

### Student journey
1. Join a class using the teacher's code.
2. Create a simple student account and sign in.
3. Open assigned work.
4. Write on a basic canvas or use typed fallback.
5. Submit and see status: `submitted` → `processing` → `auto_grading` → `waiting_for_teacher` → `finalized` (or `failed/retryable`).
6. If the teacher enabled draft visibility for this assignment, see the provisional AI grade and feedback while it is waiting for teacher approval. Otherwise see only the status until the grade is finalized.
7. See the teacher-approved final grade and feedback.

### Grading-status contract
Use a single persisted state machine, not UI-local guesses. Both student and teacher views subscribe/poll against the same authoritative status. Status transitions are written transactionally with grading-run/result changes. Suggested states: `submitted`, `processing`, `auto_grading`, `waiting_for_teacher`, `finalized`, `retryable_failure`, `permanent_failure`. Keep failure distinct from a zero score.

Keep the student flow simple. Do not expose internal grading states or promise an instant result while asynchronous processing is underway.

### Teacher dashboard
The default teacher experience is **student-centric**: the teacher can always open a class roster and see each student's assignment progress, current grading status, draft/final grade, and which items need approval. A question-centric/review-deck view may be an additional way to work through pending approvals, but must not replace the student-centric overview.

Show:
- Students assigned, completed, pending, and failed.
- Completion percentage.
- Class average for finalized grades.
- Highest and lowest finalized assignment grade.
- Answers awaiting review.
- Per-student submission/grading status.
- Link to review flagged work.

Only finalized grades contribute to aggregates. Distinguish pending, processing, failed, awaiting review, and finalized.

### Teacher review deck — core differentiator
One student-question answer per card/slide. Show:
- Student name prominently, assignment, and question.
- Original image or typed answer.
- OCR lines in order.
- Rubric criteria and points awarded.
- Evidence supporting each criterion score.
- AI interpretation, confidence, and reason for review.
- Editable score and feedback.
- Previous/next navigation, keyboard shortcuts, and save/confirm.

Default to incorrect, ambiguous, low-confidence, or failed answers. High-confidence correct answers should not force unnecessary review. Preserve the original AI grade when a teacher overrides it, with who/what/when audit history.

### Feedback and approval policy
- **Every auto-grade is provisional until the teacher explicitly approves it.** The teacher rubber-stamps each grade before it becomes final and visible as a final result.
- Each assignment has one simple setting: `Show draft grades to students while awaiting teacher approval` (default off).
- When enabled, students can see the provisional score/feedback with an unmistakable `Draft — awaiting teacher approval` label. It is never presented as final.
- When disabled, students see status only until teacher approval.
- Teacher can edit score and feedback before approving.
- Provider failure never becomes a zero grade and cannot be approved as though it were a completed grade.

## 5. Assignment authoring and rubric

Keep these concepts distinct and editable:
- Question prompt and maximum points.
- Expected answer(s).
- Teacher solution/worked example.
- Grading instructions.
- Rubric criteria.

### AI-assisted rubric authoring
Generate a draft from the question, expected answer, teacher solution, point maximum, and instructions. The teacher can edit, add, remove, reorder, change points, specify accepted alternatives, and set evaluation method. The teacher must approve before publishing.

### Criterion schema
Each criterion includes:
- Stable ID and description.
- Maximum points.
- Evaluation method: `deterministic`, `ai`, or `hybrid`.
- Full-credit and partial-credit conditions.
- Accepted alternatives.
- Review policy.
- Optional deterministic evaluator type/configuration.
- AI-specific instructions where needed.

Example 10-point algebra question:
- Correct final answer/equivalence: 4 points, deterministic where safe.
- Valid algebraic transformations: 3 points, AI.
- Sufficient work shown: 2 points, AI.
- Required notation: 1 point, deterministic if unambiguous.

### Versioning
Published questions and rubrics are immutable versions. Editing creates a new version. Each submission stores the exact question/rubric versions used. Existing submissions stay tied to those versions unless the teacher explicitly initiates a regrade. If a question changes, prompt the teacher to confirm its expected answer and rubric remain valid. Never silently change the grading contract for existing work.

## 6. Grading pipeline

### Stages
1. Student submits work.
2. API validates and persists submission and source image.
3. A durable pgmq message is enqueued with the submission ID.
4. Effect worker claims the job.
5. OCR stage sends the image to Google Gemini 3.5 Flash through OpenRouter and extracts ordered lines.
6. Answer is normalized into the canonical representation.
7. Deterministic evaluators run for eligible criteria.
8. Text-grading stage sends the question, rubric, OCR text, and evidence to the configured OpenAI model through OpenRouter.
9. Results are validated and persisted idempotently.
10. Answers needing attention enter the teacher review deck.
11. Student receives the score/feedback for that problem; teacher sees updated progress and can review or override as appropriate.

### Provider contract and mock parity
Both external stages must have stable internal request/response contracts. The mock implementations must return the **same response shape as the real provider adapters**, not simplified mock-only objects. This lets the exact same parsing, validation, grading orchestration, persistence, and UI code run in mock and live modes.

- `OCRProvider`: accepts the same image input/reference and returns the canonical OCR result, including ordered lines, confidence where available, and provider/model metadata. `MockOCRProvider` returns fixture-backed OCR results in precisely that shape.
- `TextGradingProvider`: accepts the same question, rubric, OCR text/lines, and deterministic evidence; returns the exact structured grading result expected from the real model adapter. `MockTextGradingProvider` returns fixture-backed scores, criterion explanations, evidence references, feedback, confidence, and review flags in that shape.
- Validate both mock and real responses with the same schemas. Tests should fail if either implementation drifts from the contract.
- Mocks simulate latency, timeouts, 429s, 5xx responses, malformed output, and seeded failure rates. Keep fixture correctness deterministic; use configurable seeded behavior for performance/reliability tests.

### OpenRouter configuration
Use OpenRouter's OpenAI-compatible chat-completions API for both model calls, with one `OPENROUTER_API_KEY` and configurable model IDs. The OCR adapter sends image content to Google Gemini 3.5 Flash (`google/gemini-3.5-flash`) and normalizes its response into the canonical OCR schema. The text-grading adapter sends text/rubric content to a configurable OpenAI model and normalizes its response into the grading schema. Configure separate model IDs, timeouts, and token limits for the two stages.

Gemini 3.5 Flash is multimodal and accepts image input through OpenRouter. Use the OpenRouter model ID `google/gemini-3.5-flash` as the initial OCR default; keep it configurable so it can be benchmarked or replaced. Keep the OpenRouter key server-side.

### Canonical OCR representation
Every answer becomes ordered lines, whether handwritten or typed.

```ts
interface ExtractedAnswer {
  id: string;
  problemSubmissionId: string;
  lines: AnswerLine[];
  fullText: string;
  sourceImageObjectKey?: string;
  ocrProvider: string;
  ocrModel: string;
  createdAt: string;
}
interface AnswerLine {
  index: number;
  text: string; // faithful OCR transcription
  normalizedText?: string;
  latex?: string;
  confidence?: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  kind: "text" | "equation" | "diagram" | "unknown";
}
```

Preserve provider-original text. Normalized math/LaTeX is supplemental and never overwrites source text. Keep uncertain/illegible lines. Bounding boxes can link evidence to the original image if supported. Typed answers enter the same downstream contract with a source type indicating OCR was not needed.

### Criterion-level hybrid grading
Do not classify the whole answer as deterministic or AI-graded. Decide independently per rubric criterion.

Deterministic outcomes:
- `MATCH`: safely establishes the criterion is satisfied.
- `MISMATCH`: safely establishes it is not satisfied.
- `INCONCLUSIVE`: cannot safely decide.

A confident `MATCH` may short-circuit the LLM for that criterion. A `MISMATCH` must not rule out partial credit, an alternative method, or valid reasoning; those may still need the judge.

Use a small allowlisted evaluator registry:
- Exact text match.
- Accepted-answer set membership.
- Numeric equivalence with configured tolerance.
- Required intermediate result.
- Narrow symbolic equivalence only if a small expression subset is well tested.

Do not execute arbitrary teacher code or build a general symbolic algebra system for the MVP.

### LLM judge contract
Inputs:
- Versioned question prompt.
- Teacher solution and expected answers.
- Approved rubric and criterion point limits.
- OCR lines and confidence/evidence metadata.
- Deterministic evaluator outcomes.
- Original image when necessary and supported.

Structured output:
- Score per criterion.
- Explanation for each score.
- Evidence line indices.
- Accepted alternative method, if relevant.
- Misconception/first incorrect step, if identifiable.
- Student-facing feedback draft.
- Confidence.
- Review-required flag and reason.

Validate server-side: no score exceeds criterion maximum; no invented criteria; aggregate score stays within problem maximum; evidence indices exist; output matches schema. Invalid output becomes retry or explicit review/failure, never a fabricated grade.

### Review routing
Require human review when OCR confidence is low, lines are missing, judge confidence is low, answer is ambiguous, a criterion is inconclusive, a surprising mismatch/alternative method is likely, pipeline fails permanently, or policy requires approval.

## 7. Architecture and technology

### Proposed stack
- Next.js, React, TypeScript.
- Tailwind CSS and shadcn/ui.
- Next.js route handlers initially.
- Effect throughout the application service and worker layers: `Context.Tag` service contracts, `Layer` implementations, typed errors, configuration, concurrency, retries, and timeouts.
- PostgreSQL + Supabase (database, Auth if used, and Storage).
- Supabase Queues (pgmq) for durable asynchronous jobs; no Redis initially.
- Cloud Run for the web/API service and separately deployed Effect worker.
- OpenRouter-compatible API for both OCR and text grading, using one `OPENROUTER_API_KEY` and separate configurable model IDs.
- Mock OCR and mock text-grading Layers implementing exactly the same contracts and response schemas as the live adapters.
- Structured logs and basic metrics; OpenTelemetry if time permits.

Keep provider names, model IDs, timeouts, and limits configurable. Verify selected endpoints and capabilities; do not assume OCR confidence scores or bounding boxes exist.

### Effect conventions
Use Effect as the consistent application/worker programming model rather than wrapping isolated functions only. Build the actual services, not just interfaces or pseudocode: implement and deploy the Supabase-backed queue/repository, Cloud Run worker, Gemini OCR HTTP adapter, OpenAI grading HTTP adapter, mock OCR service, mock text-grading service, and status/approval persistence endpoints. Each service must be runnable locally and deployable; mock and live providers are real implementations selected by config. Define provider and infrastructure contracts with `Context.Tag`; provide mock and live implementations as `Layer`s; model expected failures with typed errors; use Effect configuration for provider/model settings; and use Effect concurrency, timeout, retry, and scoped resource management in the worker. Keep domain schemas independent of provider SDK response types.

### Environment configuration
Keep secrets and model IDs out of source control. Initial configuration should include `SUPABASE_URL`, server-side Supabase credentials, `OPENROUTER_API_KEY`, `OPENROUTER_OCR_MODEL=google/gemini-3.5-flash`, `OPENROUTER_GRADING_MODEL`, `OCR_PROVIDER=mock|openrouter`, `GRADING_PROVIDER=mock|openrouter`, and mock latency/failure profile settings. The user will fill in the actual key and model IDs during setup. Never expose the OpenRouter key to the browser.

### Component boundaries
- Web/API: auth, authorization, authoring, submissions, review, student results.
- PostgreSQL: authoritative product state.
- Object storage: original images and derived artifacts.
- Effect worker: claims pgmq messages and orchestrates OCR, deterministic evaluation, text grading, validation, and persistence.
- OpenRouter OCR adapter: sends image input to Google Gemini 3.5 Flash.
- OpenRouter text-grading adapter: sends the normalized student work and rubric to the configured OpenAI model.
- Mock provider Layers: mirror both live adapters' request/response contracts and can be selected through configuration.
- Supabase pgmq: durable job storage, visibility/claim behavior, and retry handling.

### Queue design
Start with one `grading_jobs` queue and one Effect worker pipeline; split OCR and text grading into separate queues only if measurements show a need. Deterministic evaluation runs between OCR and text grading. Queue payloads contain submission IDs/small metadata only—not images, full answers, or large prompts. Run the worker as a separately deployed Cloud Run service, not inside a web request handler. Claim bounded batches, limit concurrency, and acknowledge messages only after durable state transitions. Use pgmq visibility/lease and retry semantics deliberately; make processing idempotent because delivery can repeat.

### Reliability
- PostgreSQL is source of truth; pgmq is the durable queue in the same managed database.
- Persist submission metadata before enqueueing; use a transaction or database-side operation so accepted submissions cannot be orphaned between persistence and enqueue.
- Treat queue delivery as at-least-once; grading writes must be idempotent.
- Bound worker concurrency and provider-specific rate limits.
- Use timeouts and exponential backoff with jitter.
- Handle rate limits/transient errors explicitly.
- Recover stalled jobs and expose terminal failures.
- Provide safe manual retry.
- Never silently drop a submission or convert processing failure into zero.


## 8. Authentication, authorization, and data model

### Authentication
Use simple username/passphrase auth:
- Hash with a maintained Argon2id implementation; do not implement hashing yourself.
- Use opaque random session tokens; store only token hashes.
- Store sessions in PostgreSQL.
- HTTP-only, Secure-in-production, SameSite cookies.
- Rate-limit login attempts; use generic credential errors.
- Enforce resource ownership and class membership server-side.

Skip OAuth, email verification, MFA, password reset, and enterprise SSO.

### Class membership
For MVP, each student belongs to exactly one class: `students.class_id NOT NULL`. Future multi-class support can introduce `class_memberships(student_id, class_id)`.

### Core entities
`users`, `teacher_profiles`, `classes`, `students`, `assignments`, `assignment_versions`, `questions`, `question_versions`, `rubrics`, `rubric_versions`, `rubric_criteria`, `submissions`, `problem_submissions`, `extracted_answers`, `answer_lines`, `grading_runs`, `criterion_results`, `grades`, `teacher_overrides`, `feedback`, `outbox_events`, `sessions`.

Use foreign keys and constraints for ownership, version relationships, point limits where practical, and uniqueness/idempotency keys.

## 9. Evaluation strategy

Keep three kinds of validation separate.

### A. Deterministic fixture oracle
Known input with expected OCR lines or typed representation, pipeline route, criterion score/range, review status, and final state. It validates application behavior without provider calls.

Fixtures:
- Confident correct.
- Equivalent expression.
- Valid alternative solution.
- Wrong final answer.
- Correct setup with arithmetic error.
- Partial work.
- Blank response.
- Illegible/low-confidence handwriting.
- Diagram/mixed text and math only if supported.

### B. Provider-behavior simulator
Implement `MockOCRProvider` and `MockTextGradingProvider` as Effect Layers. **Deploy these mock provider services and run them on the same Cloud Run worker infrastructure used by the real pipeline**; do not replace the real worker with an in-process fake or a local-only mock during load tests. The worker should select mock/live provider Layers by configuration. The mocks must exercise the actual queue claim, orchestration, persistence, state transitions, teacher approval, and status-notification paths. Each must implement the same service interface and return the same validated response schema as its corresponding live OpenRouter adapter. Use fixture-backed outputs so the full production parsing, validation, orchestration, persistence, and UI path is exercised without real model calls.

Simulate performance and failure behavior separately from grading correctness:
- OCR/text-grading latency distributions including slow tails.
- Image sizes, OCR line counts, and response sizes.
- Input/output token-size distributions.
- Confidence distributions and review rates.
- 429 rate limits, transient 5xx errors, timeouts, malformed responses, and retry behavior.

Use seeded randomness for repeatability. Keep a deterministic fixture mode for correctness tests and configurable seeded profiles for load/resilience tests. Model latency with a realistic long-tailed distribution (for example, log-normal or a calibrated empirical distribution), not only a uniform min/max delay: report p50/p95/p99 and include rare slow calls. Add bounded simulated provider concurrency and configurable 429/503/timeout behavior. Use the same canonical schemas and validators for mock and live provider responses. Calibrate latency and payload assumptions using a small number of real OpenRouter calls and document the assumptions.

### C. Real model quality evaluation
Create a human-reviewed benchmark of roughly 15–20 submissions with expected score ranges and review decisions. Measure OCR transcription quality, exact score agreement, mean absolute grading error, false-positive full-credit rate, partial-credit agreement, alternative-method acceptance, review-flag precision/recall, latency, and estimated cost per submission.

A load test does not establish grading quality. Report quality and throughput separately.

## 10. Load testing and scaling

### Tool and command-line workflow
Use **Locust** for repeatable CLI-first load tests. Keep the `locustfile.py`, seed-data helper, and scenario configuration in the repository. A developer should be able to run a short smoke test or a multi-hour classroom-day simulation with one command, without opening a dashboard or manually provisioning individual students.

Example commands (after installing Locust and setting the deployed base URL and test credentials):

```bash
# quick smoke: 30 virtual students, ramp 5/sec, run 3 minutes
locust -f tests/load/locustfile.py --headless \
  -H "$TARGET_URL" -u 30 -r 5 -t 3m --stop-timeout 30

# classroom-day soak: 500 concurrent virtual students, ramp 10/sec, run N hours
locust -f tests/load/locustfile.py --headless \
  -H "$TARGET_URL" -u 500 -r 10 -t 4h --stop-timeout 60 \
  --csv=artifacts/classroom-day
```

Locust supports headless runs with user count, spawn rate, and run duration via CLI, and distributed master/worker generation when one load-generator host is insufficient. See the official [headless CLI documentation](https://docs.locust.io/en/latest/running-without-web-ui.html), [configuration reference](https://docs.locust.io/en/latest/configuration.html), and [distributed load generation](https://docs.locust.io/en/latest/running-distributed.html).

### Virtual-student model and cloud load generators
A Locust virtual user represents a student session; it is a lightweight simulated client (typically a greenlet), **not one dedicated Cloud Run worker/container per student**. Do not launch one cloud worker per virtual student: that would add cost and distort the workload. Instead, run one Locust process for small tests, then a small number of distributed Locust generator workers (for example, Cloud Run instances or other controlled compute) if the load generator itself becomes the bottleneck. The system under test remains the Cloud Run web/API and Effect grading workers.

Each virtual student should have a stable unique test identity and its own session. The test scenario should:
- Enroll/seed many virtual students in one test class and assignment.
- Have all students repeatedly submit work for the **same published question** over a configurable `N`-hour period, with realistic think-time/jitter and occasional synchronized waves.
- Use distinct submission IDs/idempotency keys per attempt; optionally replay selected requests to test duplicate delivery.
- Generate overlapping writes to shared assignment/question rows and nearby student/submission/grade rows, without having clients mutate immutable question/rubric definitions.
- Poll or subscribe to grading status and verify the sequence through `waiting_for_teacher`.
- Verify students do not see final grades before teacher approval; test both draft-visibility settings.
- Use a separate teacher virtual user or test controller to approve pending grades, enabling an end-to-end lifecycle test.
- Check that each accepted submission has exactly one logical grading result, correct ownership, and no cross-student data leakage.

This tests database contention and race conditions from concurrent submissions to a shared assignment/question while preserving unique student/submission records. Add targeted tests for concurrent duplicate submissions, simultaneous worker claims, status transition races, and two teachers attempting to approve/update the same grade.

### Mock provider behavior on cloud workers
During load tests, configure the deployed Effect worker to use the mock OCR and mock text-grading Layers. The mocks must run in the actual deployed worker execution path and return the exact same canonical response objects as the live Gemini/OpenAI adapters. They should have:
- A seeded, configurable long-tail latency distribution for OCR and grading independently.
- Bounded concurrency and optional simulated provider rate limits.
- Configurable 429, 5xx, timeout, malformed-response, and recovery windows.
- Stable fixture outputs for correctness checks, with latency/failure randomness isolated from fixture grading correctness.

The load generator should hit the real deployed submission API and database-backed queue. It must not bypass pgmq or invoke mock grading directly. This is how the test measures queueing, worker execution, database writes, and status progression rather than just the mock endpoint's speed.

### Scenarios
1. Baseline: one classroom (~30 students).
2. Quick burst: 1,000 submissions over 30 seconds.
3. Larger burst: 10,000 submissions with a defined arrival distribution.
4. Classroom-day soak: N virtual students repeatedly submit to the same question over N hours.
5. Slow provider: long-tail latency and bounded mock-provider concurrency.
6. Provider outage/rate limiting: 429/503s, timeout window, then recovery.
7. Worker interruption during in-flight work.
8. Duplicate submission and duplicate queue delivery.
9. Concurrent status updates and teacher approval races.
10. Backlog drain after submissions stop or provider recovers.

### Metrics and correctness assertions
Measure submission API acceptance p50/p95/p99; queue depth and oldest-message age; time in each status; queue wait; OCR and grading duration p50/p95/p99; completed jobs/sec; worker concurrency and instance count; database connection usage, query latency, lock waits/deadlocks and transaction retries where observable; retry/failure/stalled-job rates; duplicate side effects; time to drain backlog; approval delay; and draft/final visibility correctness.

Correctness assertions matter as much as throughput:
- Every acknowledged submission is durably enqueued.
- Every accepted submission reaches a known state; none silently disappears.
- One logical grade exists per submission/rubric version.
- A student's submission and grade are visible only to authorized users.
- No final grade is exposed before teacher approval.
- Draft grade is exposed only when the assignment setting enables it.
- Status transitions are monotonic and valid; stale workers cannot overwrite newer terminal states.

### Expected pipeline chokepoints to instrument
1. **Submission/API + object storage:** upload duration, request body size, DB insert latency, and the atomic persist-and-enqueue boundary.
2. **Postgres/pgmq:** queue insertion/claim/ack latency, hot indexes, row/table lock waits, connection-pool saturation, and transaction contention around shared assignment/question records.
3. **Worker scheduling:** Cloud Run cold starts, max instances, CPU/memory, poll interval, batch size, per-worker concurrency, and shutdown/recovery behavior.
4. **External inference:** OpenRouter rate limits, provider latency tails, timeouts, token/image payload size, and cost. Mock runs isolate this from actual provider intelligence/cost while preserving realistic latency/failure behavior.
5. **Result persistence/status fan-out:** concurrent updates, idempotency constraints, stale-worker writes, status polling/subscription load, and teacher approval transactions.
6. **Teacher approval throughput:** every grade requires an explicit approval, so approval backlog is a product workflow bottleneck distinct from machine grading throughput. Measure pending approvals and time-to-approval separately.

### Scaling narrative
- **1k:** one web/API service, Supabase Postgres/pgmq/Storage, bounded Cloud Run Effect workers.
- **10k:** horizontally scale grading workers, tune concurrency/provider limits, connection pooling, and queue-age-based scaling/admission control.
- **100k:** isolate workloads, admission control and cost budgets, tune database access, partition only when measured.
- **1M:** evaluate sharding, regional architecture, tenant isolation, multi-region storage, provider capacity/fallback, formal SLOs.

These are architectural stages, not claims the take-home implementation achieved those scales. State what was measured versus projected.

## 11. Failure-state UX

| Failure | System behavior | Teacher-visible behavior |
|---|---|---|
| OCR unavailable | Retry with backoff | Processing; no invented grade |
| OCR permanently fails | Explicit failure | Review/retry |
| LLM rate-limited | Respect limit and retry | Still processing |
| Invalid LLM output | Validate, retry or flag | Review if unresolved |
| Worker crashes | Recover stalled job | Processing until recovery |
| Duplicate delivery | Idempotent writes | No duplicate grade/feedback |
| Queue/database unavailable | Do not report submission as accepted until durable persistence/enqueue succeeds; otherwise show retryable error | Clear retry state; no lost submission |
| Low OCR confidence | Continue cautiously or flag | Original work and uncertainty visible |
| Ambiguous answer | Human review | Reason for flag visible |

## 12. Security, privacy, and data handling

- Enforce teacher ownership and student class membership on every request.
- Validate upload type, size, and image dimensions.
- Keep provider keys server-side.
- Avoid logging student work or personal data.
- Use least-privilege credentials and private networking.
- Define deletion behavior for classes, assignments, submissions, and images.
- Store only student information needed for the workflow.
- Document external providers that process student work.
- Treat student submissions/OCR as untrusted LLM input; delimit content and tell the judge not to follow instructions embedded in student work.

## 13. Demo plan

Seed a realistic class of ~10 students with correct, equivalent-notation, alternative, partial-credit, incorrect, ambiguous, and low-confidence answers.

Demo:
1. Teacher creates assignment.
2. Teacher edits and approves rubric.
3. Teacher publishes and shares class code.
4. Students submit handwritten/typed work.
5. Grading runs asynchronously.
6. Teacher sees class progress.
7. Teacher opens review deck and inspects flagged work.
8. Teacher edits a score and feedback.
9. Teacher releases results.
10. Student sees finalized grade and feedback.
11. Teacher returns to dashboard and can create another assignment.

Use seeded results for reliability if live provider calls make the walkthrough unpredictable. Be transparent about live versus fixture-backed components.

## 14. README and engineering handoff

Include:
- Product purpose and supported domain.
- Screenshots or short demo recording.
- Local setup and environment variables.
- Migrations and seed instructions.
- Architecture diagram and data model.
- Grading pipeline and rubric contract.
- Queue, outbox, retry, and idempotency design.
- Deployment topology and worker startup.
- Load-test commands/scenarios and results.
- Quality-evaluation methodology/results.
- Known limitations and next steps.

Separate measured results from projections. Never imply simulated provider behavior equals real provider throughput.

## 15. Implementation sequence

### Phase 1 — Foundation
Set up repository, Next.js, TypeScript, Effect, Supabase project/schema, Storage, and Cloud Run deployment. Establish configuration/secrets handling and a minimal deployed web app.
**Exit:** app deploys and can persist/read a basic record.

### Phase 2 — Effect contracts and mock vertical slice
Define Effect service contracts with `Context.Tag` for the queue, submission repository, OCR provider, and text-grading provider. Implement the actual mock OCR and mock text-grading services/Effect Layers, deploy them on Cloud Run, and make the grading worker call them through the same service boundaries it will use for live inference. Their outputs must match the exact canonical response schemas used by live adapters. Add deterministic fixtures and a simple student submission path. Implement pgmq enqueue/claim/ack and an Effect worker with bounded concurrency, typed failures, timeouts, retries, and idempotent persistence.
**Exit:** a submitted answer flows through mock OCR → canonical OCR result → mock text grading → canonical grade result → persisted grade, using the same schemas and orchestration intended for production.

### Phase 3 — Minimal teacher/student product
Implement one class, a narrow assignment/question editor or seeded assignment, editable/approved rubric, student join with cross-device identity, basic canvas plus typed fallback, per-problem score/feedback, and teacher progress/grade report. Persist original work and show processing/failure states.
**Exit:** a teacher and student can complete the narrow workflow, including returning on another device.

### Phase 4 — Live OpenRouter model adapters
Implement the actual OpenRouter-compatible Gemini 3.5 Flash image-to-text OCR adapter (`google/gemini-3.5-flash`) and an OpenRouter-compatible text-grading adapter using a configurable OpenAI model. Both use `OPENROUTER_API_KEY`, the OpenRouter chat-completions request format, and separate model IDs/configuration. Normalize live outputs into the exact same schemas used by the mocks and validate them with the same validators. Add a small human-reviewed quality benchmark.
**Exit:** switch from mocks to live models through configuration only; no worker or product-flow changes.

### Phase 5 — Teacher/student status and approval UX
Build the student-centric teacher roster, per-assignment draft-grade visibility setting, shared grading-status state machine, student status view, optional draft-grade display, and teacher approval/rubber-stamp flow for every grade. Add review evidence, editable score/feedback, override history, and final release.
**Exit:** teacher can always see each student's progress; both roles see consistent status; students never see a final grade before explicit teacher approval.

### Phase 6 — Deployed load and failure testing
Add a Locust CLI suite with short smoke, burst, and N-hour classroom-day scenarios. Run repeatable mock-backed tests against the deployed submission API, pgmq, actual Cloud Run Effect workers, database writes, and status updates. Use distributed Locust generator workers only if the load generator becomes a bottleneck; do not create one Cloud Run worker per virtual student. Test normal classroom, 1k/10k bursts, slow providers, 429/503s, worker interruption, duplicate delivery, and backlog recovery. Report queue depth/age, throughput, latency, retries, and drain time. Run only a small real-model quality test to control API cost.
**Exit:** report separates simulated infrastructure throughput from real model quality and clearly labels measured versus projected capacity.

### Phase 7 — Polish and handoff
Seed demo data, improve loading/processing/review/failure states, document setup and secrets, deployment, mock/live provider switching, load-test commands/results, and known limitations. Record a short walkthrough if time allows.
**Exit:** another engineer can run, understand, test, deploy, and demo the workflow.

## 16. Prioritization under time pressure

Cut in this order:
1. Fancy canvas features; retain basic drawing and typed fallback.
2. Advanced dashboard metrics; retain status and review count.
3. AI rubric generation; retain editable manual/seeded rubric.
4. OCR bounding-box visualization; retain ordered lines and original image.
5. More deterministic evaluator types; keep a few reliable ones.
6. Complex deployment automation; retain reproducible deployment/worker instructions.
7. Broad subject support; stay in one domain.

Do not cut durable submission persistence, server-side authorization, explicit processing/failure states, idempotent grading, teacher review/override, reproducible fixtures, or honest load-test reporting.

## 17. Definition of done

- Teacher creates class and publishes versioned assignment.
- Student joins and submits from another browser/device.
- Submission survives process restart.
- OCR output is ordered lines and original evidence is preserved.
- Hybrid grading respects criterion limits and rubric versions.
- Provider failures never become fabricated grades.
- Duplicate jobs do not duplicate grading side effects.
- Teacher sees flagged answers, student name, evidence, and can edit/release grade and feedback.
- Student sees released feedback.
- Dashboard aggregates finalized grades only.
- Fixture tests are repeatable.
- Load tests document scenarios, assumptions, metrics, and actual results.
- README explains run, deploy, test, and architecture.

## 18. Guiding principles

1. Complete the workflow before broadening it.
2. The rubric is the grading contract.
3. Grade at criterion level, not with one opaque whole-answer decision.
4. Make evidence and uncertainty visible.
5. Teachers retain control over questionable decisions.
6. Persist first; enqueue reliably; process idempotently.
7. Provider failure is not student failure.
8. Measure model quality separately from system throughput.
9. Distinguish measured capacity from scaling projections.
10. Optimize for teacher trust and repeat use, not feature count.
