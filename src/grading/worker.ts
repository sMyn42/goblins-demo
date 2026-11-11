import { randomUUID } from "node:crypto";
import { Effect, Random, Schedule } from "effect";
import { GradingConfig, type GradingSettings } from "./config";
import { observeWorker } from "../worker/health";
import { evaluateCriteria } from "./deterministic";
import { ProviderFailure, validateGrade, validateOCR } from "./contracts";
import { GradingQueue, OCRProvider, SubmissionRepository, TextGradingProvider, type Job, type RunInput } from "./ports";

const providerCall = <A>(effect: Effect.Effect<A, ProviderFailure>, stage: "ocr" | "grading", config: GradingSettings, runId: string) => Effect.gen(function* () {
  yield* observeWorker((health) => health.jobPhase(runId, stage === "ocr" ? "waiting_ocr" : "waiting_grading"));
  return yield* effect.pipe(Effect.timeoutFail({ duration: stage === "ocr" ? config.ocrTimeoutMs : config.gradingTimeoutMs, onTimeout: () => new ProviderFailure({ stage, code: "timeout", retryable: true }) }), Effect.tapError((error) => error.code === "timeout" ? observeWorker((health) => health.providerTimeout) : Effect.void));
}).pipe(
  Effect.ensuring(observeWorker((health) => health.jobPhase(runId, "persisting"))),
  Effect.retry({ times: 1, while: (error) => error.retryable && error.code !== "rate_limited", schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered) }),
);
const pipeline = (run: RunInput) => Effect.gen(function* () {
  const config = yield* GradingConfig;
  const repo = yield* SubmissionRepository;
  const ocr = yield* OCRProvider;
  const grader = yield* TextGradingProvider;
  const ocrRequest = { submissionId: run.submissionId, source: run.source, attempt: run.attempt };
  const answer = yield* providerCall(ocr.extract(ocrRequest).pipe(Effect.flatMap((raw) => validateOCR(raw, ocrRequest))), "ocr", config, run.runId);
  yield* repo.recordOCR(run, answer);
  const request = {
    question: run.question, answer, attempt: run.attempt,
    deterministicEvidence: evaluateCriteria(run.question, answer),
  };
  const grade = yield* providerCall(grader.grade(request).pipe(Effect.flatMap((raw) => validateGrade(raw, request))), "grading", config, run.runId);
  yield* repo.complete(run, grade);
  yield* observeWorker((health) => health.completed);
});

export const processJob = (job: Job) => Effect.gen(function* () {
  const config = yield* GradingConfig;
  const queue = yield* GradingQueue;
  const repo = yield* SubmissionRepository;
  if (!job.submissionId) {
    yield* Effect.logWarning("Archived malformed queue payload; no student work logged.");
    return yield* queue.acknowledge(job.id);
  }
  const runId = randomUUID();
  yield* observeWorker((health) => health.jobPhase(runId, "claiming_run"));
  return yield* Effect.gen(function* () {
  const run = yield* repo.begin(job.submissionId!, runId, config.leaseSeconds);
  if (run === "terminal" || run === "missing") return yield* queue.acknowledge(job.id);
  if (run === "busy") return yield* queue.defer(job.id, 2);
  if (run.attempt > config.maxAttempts) {
    yield* repo.fail(run, "retry_exhausted", true);
    return yield* queue.acknowledge(job.id);
  }
  // A whole-run deadline expires BEFORE the DB fence/queue visibility lease.
  // Stale workers cannot write once the lease expires or a new run takes ownership.
  yield* pipeline(run).pipe(
    Effect.timeoutFail({ duration: config.leaseSeconds * 1000 - 5000, onTimeout: () => new ProviderFailure({ stage: "grading", code: "timeout", retryable: true }) }),
    Effect.matchEffect({
      onSuccess: () => queue.acknowledge(job.id),
      onFailure: (error) => Effect.gen(function* () {
        if (error._tag === "LeaseLost") return yield* queue.defer(job.id, 2);
        if (error._tag === "StorageError") return yield* queue.defer(job.id, 5);
        yield* observeWorker((health) => health.failed);
        const permanent = !error.retryable || run.attempt >= config.maxAttempts;
        yield* repo.fail(run, `${error.stage}_${error.code}`, permanent);
        if (permanent) yield* queue.acknowledge(job.id);
        else {
          const jitter = yield* Random.next;
          yield* queue.defer(job.id, Math.max(error.retryAfterSeconds ?? 0, Math.min(60, Math.ceil(2 ** run.attempt + jitter * 2))));
        }
      }),
    }),
  );
  }).pipe(Effect.ensuring(observeWorker((health) => health.jobEnded(runId))));
}).pipe(Effect.catchAll((error) => Effect.logWarning(`Grading job delayed: ${error._tag}. Durable queue will redeliver.`)));

export const runBatch = Effect.gen(function* () {
  const config = yield* GradingConfig;
  const queue = yield* GradingQueue;
  yield* observeWorker((health) => health.pollStarted);
  const jobs = yield* queue.claim(config.leaseSeconds, config.concurrency);
  yield* observeWorker((health) => health.claimSucceeded(jobs.length));
  yield* Effect.forEach(jobs, processJob, { concurrency: config.concurrency, discard: true });
  yield* observeWorker((health) => health.pollFinished);
  return jobs.length;
});
