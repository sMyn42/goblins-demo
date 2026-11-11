# Load Testing Status

## Current status

No reproducible Cloud Run/Supabase load test has been run by this harness. There are therefore no verified capacity figures, queue-depth measurements, worker limits, or bottleneck conclusions to report. Local tests and stub flows validate the harness only; they are not cloud capacity measurements.

Earlier notes proposed testing bursts of up to 1,250 users, scaling beyond two grading workers, and eventually considering workloads above 10,000 users. These are hypotheses and test targets—not measured results or current capacity claims. The staged isolated cohorts are designed to gather evidence for those questions using synthetic accounts and mock OCR/grading.

## Questions for an isolated live run

- How do submission latency, queue depth/age, grading completion rate, and queue drain change across the 50-, 250-, and 1,250-student cohorts?
- Do two or five worker instances improve throughput, and what do Cloud Run instance telemetry and worker-slot observations show?
- How does the teacher dashboard/roster API respond while synthetic students submit and poll progress?
- Do injected transient failures recover, and do hung providers reach the hard cutoff while worker keepalives remain healthy?
- Are hard-cutoff failures still visible as submitted work, manually recoverable by a teacher, and hidden from students until explicit approval?

Use only the dedicated isolated stack described in `tests/load/README.md`. Reports must contain measurements from an actual run and must distinguish worker-heartbeat counts from Cloud Run instance metrics. Do not infer paid-provider SLAs from mock-provider results.
