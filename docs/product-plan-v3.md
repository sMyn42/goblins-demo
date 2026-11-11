# Goblins AI Auto-Grader — Product & Engineering Plan
**Updated: November 10, 2026**

## 1. Executive summary

Build a publicly hosted, teacher-focused AI auto-grader around one complete classroom workflow:

**Create → Assign → Collect → Grade → Review → Return feedback → Reuse.**

The product hypothesis: teachers will reuse an AI grader when it meaningfully reduces grading time while preserving grading quality, useful feedback, and teacher control.

This is a **minimum complete workflow**, not a miniature LMS. Keep the user-facing loop coherent while constraining implementation: one supported subject/problem domain, one OCR provider, one LLM judge, a small deterministic evaluator registry, one class per student, and one attempt per assignment.

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
5. Submit and receive confirmation.
6. Later, see the released grade and teacher feedback.

Keep the student flow simple. Do not expose internal grading states or promise an instant result while asynchronous processing is underway.

### Teacher dashboard
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

### Feedback release policy
- High-confidence correct answers may be finalized automatically only if the teacher enables that policy.
- Incorrect, ambiguous, low-confidence, and failed answers wait for review.
- Feedback is not released until finalized.
- Teacher can edit feedback before release.
- Provider failure must never become a zero grade.

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
3. Transactional outbox event is written in the same DB transaction.
4. Dispatcher publishes the job to BullMQ.
5. OCR worker extracts ordered lines.
6. Answer is normalized into the canonical representation.
7. Deterministic evaluators run for eligible criteria.
8. LLM judge evaluates criteria needing interpretation, partial credit, alternative reasoning, or unresolved deterministic results.
9. Results are validated and persisted idempotently.
10. Answers needing attention enter the teacher review deck.
11. Finalized grades/feedback are released.

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
- Effect for typed services/errors where it adds clarity; avoid needless abstraction.
- PostgreSQL + Drizzle.
- Redis + BullMQ.
- S3-compatible storage or Cloudflare R2 for images.
- One OCR provider behind an interface.
- OpenRouter for LLM judge behind an interface.
- Web/API service plus separate long-lived worker process.
- Structured logs and basic metrics; OpenTelemetry if time permits.

Keep provider names, model IDs, timeouts, and limits configurable. Verify selected endpoints and capabilities; do not assume OCR confidence scores or bounding boxes exist.

### Component boundaries
- Web/API: auth, authorization, authoring, submissions, review, student results.
- PostgreSQL: authoritative product state.
- Object storage: original images and derived artifacts.
- Outbox dispatcher: reliably publishes committed work.
- OCR workers: call provider and persist answer lines.
- Grading workers: deterministic evaluation, LLM judging, validation, persistence.
- Redis/BullMQ: job coordination, retries, concurrency, rate limiting.

### Queue design
Use separate `ocr` and `llm-grading` queues. Deterministic evaluation can run inside the grading worker. Queue payloads contain IDs/small metadata only—not images, full answers, or large prompts. Run workers as independent long-lived processes, not inside serverless request handlers.

### Reliability
- PostgreSQL is source of truth; Redis is not.
- Write submission and outbox event in one DB transaction.
- Dispatcher retries publication if Redis is unavailable.
- BullMQ is at-least-once; grading writes must be idempotent.
- Bound worker concurrency and provider-specific rate limits.
- Use timeouts and exponential backoff with jitter.
- Handle rate limits/transient errors explicitly.
- Recover stalled jobs and expose terminal failures.
- Provide safe manual retry.
- Never silently drop a submission or convert processing failure into zero.

### Redis operations
Use private networking/authentication and TLS where supported; consider AOF persistence; set `maxmemory-policy noeviction`; separate dev/prod; monitor memory, connections, queue depth, oldest job age, retries, and stalled jobs. Do not overbuild Redis operations for the assignment.

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
Simulate performance, not model intelligence:
- OCR/LLM latency distributions including slow tails.
- Image sizes and OCR line counts.
- Token/input/output size distributions.
- Confidence distributions.
- Rate limits, transient failures, timeouts, retries.

Use seeded randomness for repeatability. Calibrate using a small number of real provider calls and document assumptions.

### C. Real model quality evaluation
Create a human-reviewed benchmark of roughly 15–20 submissions with expected score ranges and review decisions. Measure OCR transcription quality, exact score agreement, mean absolute grading error, false-positive full-credit rate, partial-credit agreement, alternative-method acceptance, review-flag precision/recall, latency, and estimated cost per submission.

A load test does not establish grading quality. Report quality and throughput separately.

## 10. Load testing and scaling

### Scenarios
1. Baseline classroom: ~30 students.
2. Burst: 1,000 submissions over 30 seconds.
3. Larger burst: 10,000 submissions with a defined arrival distribution.
4. Stress until throughput, queue age, or latency violates target.
5. Worker crash during processing.
6. OCR outage/rate limit.
7. LLM outage/rate limit.
8. Redis restart/unavailability followed by outbox catch-up.
9. Duplicate delivery to verify idempotency.
10. Backlog drain after provider outage.

### Metrics
Submission API acceptance p50/p95/p99; queue wait by stage; OCR and LLM duration p50/p95/p99; end-to-end latency; completed jobs/sec; queue depth/oldest age; worker utilization/concurrency; retries/failures/stalled jobs; duplicate side effects; deterministic short-circuit rate; estimated cost/submission.

### Reliability invariant
Every accepted submission reaches a known terminal state or explicit review/failure state. No accepted work silently disappears.

### Scale narrative
- **1k:** one web/API service, PostgreSQL, Redis/BullMQ, object storage, bounded worker pools.
- **10k:** horizontally scale workers, tune concurrency, provider rate limits, connection pooling, autoscale from queue depth/age.
- **100k:** isolate workloads, admission control and cost budgets, tune DB access, partition only when measured.
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
| Redis unavailable | Persist submission/outbox | Accepted; processing delayed |
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
Set up repository, app, styling, database, migrations; deploy minimal web app and separate worker; implement teacher/student auth and authorization; create class/join flow.
**Exit:** teacher creates a class and student joins.

### Phase 2 — Assignment authoring
Implement assignment/question editing, expected answers, teacher solutions, rubric draft/manual path, rubric editing/approval, immutable versions.
**Exit:** teacher publishes a versioned assignment with approved rubric.

### Phase 3 — Student submission
Build assignment view and basic canvas, typed fallback, object storage, transactional submission/outbox persistence.
**Exit:** student submits and work is durably recorded.

### Phase 4 — Asynchronous grading
Implement outbox dispatcher/BullMQ, OCR adapter, ordered answer lines, deterministic evaluator registry, LLM judge adapter/schema validation, idempotency, retries, explicit states, review routing.
**Exit:** submission reliably reaches grade or explicit review/failure.

### Phase 5 — Teacher review and student results
Build dashboard/statuses, review deck/evidence/editable score and feedback, original AI result and override history, feedback release, student result view.
**Exit:** teacher reviews, corrects, and releases a grade.

### Phase 6 — Evaluation and load testing
Build fixture oracle and provider simulator, run small real-provider quality benchmark, run baseline/burst/failure/duplicate/backlog tests, record bottlenecks and scale assumptions.
**Exit:** repeatable report separates correctness, quality, and throughput.

### Phase 7 — Polish and handoff
Seed demo class, improve empty/loading/processing/review/failure states, write README/deployment instructions, record walkthrough if time allows.
**Exit:** another engineer can run, understand, test, and demo the workflow.

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
