# Worker readiness and long-tail latency

Apply **`0004_worker_progress_heartbeats.sql`** before deploying the updated worker/web app.

Readiness no longer depends on when an inference batch finishes. A supervised independent loop probes PostgreSQL/pgmq and publishes operational heartbeats while OCR/grading waits continue. Monitoring has a separate one-connection pool, server statement timeout, Effect deadline and single-flight guard: a timed-out physical query cannot accumulate overlapping probes.

Defaults:

| Setting | Default |
|---|---:|
| `WORKER_HEARTBEAT_INTERVAL_MS` | 15000 |
| `WORKER_PROBE_TIMEOUT_MS` | 3000 |
| `WORKER_HEARTBEAT_STALE_MS` | 60000 |
| `WORKER_INTERNAL_STALL_MS` | 30000 |

Freshness must exceed interval + two probe timeouts. Durations use a monotonic clock. `/ready` fails before the first probe, on queue/probe failure or staleness, failed/stopped polling loops, stalled internal DB work, or shutdown. A valid external provider wait is not an internal stall. `/health` is loop/process liveness; `/status` exposes local progress. These worker endpoints remain behind private Cloud Run ingress/IAM.

The worker reports active jobs, OCR/grading wait counts/ages, poll/batch ages, completions, failed attempts and provider timeouts. No student/work/run IDs, prompts, images or credentials are included. PostgreSQL timestamps heartbeat receipt; the main service marks expired records stale rather than assuming workers are alive indefinitely. Records are one per process boot; the fleet query considers at most the latest 1000 records from the last day. Older rows can be pruned administratively.

`GET /api/worker-status` lets the web service read fleet reports. It requires `Authorization: Bearer <WORKER_MONITOR_TOKEN>` and is disabled unless that separate operator token is at least 32 characters. Configure it as a web-service Secret Manager secret; grant the web runtime access. It is not the OpenRouter key and is never a browser/public variable. A successful monitoring response means the registry was read, not that a worker is necessarily ready: inspect `readyWorkers`, each record's `fresh`/`ready`, and its snapshot. Snapshots are last-reported gauges, not a new source of grading state.

## Reproduce without model charges

Use an isolated, migrated local test database with an empty queue and no other workers. The test temporarily renames its queue to simulate an outage and restores it afterward. Never target production.

```sh
createdb goblins_worker_latency_test
DATABASE_URL=postgres://localhost:5432/goblins_worker_latency_test PGMQ_INSTALL_MODE=sql npm run db:migrate
npm run build:worker
TEST_DATABASE_URL=postgres://localhost:5432/goblins_worker_latency_test npm run test:latency
```

Default: a **150-second** fixed mock OCR call through the actual compiled worker and real pgmq. The script checks readiness during the wait, forces a genuine queue outage, observes readiness 503 with liveness 200, restores the queue, sees readiness recover during the same call, and verifies one attempt/read/grade. Main-service heartbeat records are checked too. Results/samples go to ignored `artifacts/worker-latency-report.json`.

Quick CI smoke: add `LATENCY_TEST_MS=10000`. The report explicitly labels whether the run exceeded 120 seconds. Virtual-clock tests exercise 150/300-second waits and timeouts without sleeping in real time.

For deployed load tests, explicitly select `APP_MODE=load-test`, both mock providers, and e.g. `MOCK_FIXED_OCR_LATENCY_MS=150000`, `MOCK_FIXED_GRADING_LATENCY_MS=0`, `OCR_TIMEOUT_MS=180000`, `WORKER_LEASE_SECONDS=300`. `-1` fixed latency means use the seeded log-normal profile; zero means no delay. Normal mode remains live.

**Heartbeats do not renew leases, acknowledge jobs, finalize grades or bypass deadlines.** Whole-run deadlines still expire before the DB/queue lease and stale-run fences remain authoritative. Budget the lease for both stages and retries; provider timeouts/retryable failures remain explicit. Healthy event-loop/DB communication is not proof that a provider is healthy or grading correctly.

Validation: six targeted virtual/single-flight tests, a real-DB registry/privacy test, operator endpoint browser test and real-process latency smoke. The shortened real-process run and full virtual durations are reported separately; no deployed throughput claim is made.
