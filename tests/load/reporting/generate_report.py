"""Build a measured Markdown report and plots for one isolated Locust run."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
import statistics
from typing import Any

from plots import generate_plots, read_metrics


def _read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _number(row: dict[str, str], *keys: str) -> float | None:
    lowered = {key.strip().lower(): value for key, value in row.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value is None or value.strip() in {"", "N/A"}:
            continue
        try:
            return float(value)
        except ValueError:
            continue
    return None


def _aggregate_row(rows: list[dict[str, str]]) -> dict[str, str]:
    for row in rows:
        if (row.get("Name") or "").strip().lower() in {"aggregated", "total"}:
            return row
    return max(rows, key=lambda row: _number(row, "Request Count") or 0, default={})


def _stats(stats_path: Path, history_path: Path, cohort: dict[str, Any]) -> dict[str, Any]:
    rows = _read_csv(stats_path)
    aggregate = _aggregate_row(rows)
    return {
        "request_count": int(_number(aggregate, "Request Count") or 0),
        "request_failures": int(_number(aggregate, "Failure Count") or 0),
        "requests_per_second_average": _number(aggregate, "Requests/s", "Requests Per Second"),
        "locust_p50_ms": _number(aggregate, "50%", "Median Response Time"),
        "locust_p95_ms": _number(aggregate, "95%"),
        "locust_p99_ms": _number(aggregate, "99%"),
        "locust_history_rows": len(_read_csv(history_path)),
        "ramp_seconds": int(cohort["ramp_seconds"]),
        "accepted_submissions_per_ramp_second": None,
        "grading_terminal_jobs_per_second": None,
    }


def _all_summaries(artifact_dir: Path) -> list[dict[str, Any]]:
    summaries = []
    for path in artifact_dir.glob("*/summary.json"):
        try:
            summaries.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return summaries


def _max_metric(metrics: list[dict[str, Any]], key: str) -> float | None:
    values = []
    for row in metrics:
        value = row.get(key)
        try:
            if value is not None:
                values.append(float(value))
        except (TypeError, ValueError):
            pass
    return max(values) if values else None


def _mean_metric(metrics: list[dict[str, Any]], key: str) -> float | None:
    values = []
    for row in metrics:
        try:
            if row.get(key) is not None:
                values.append(float(row[key]))
        except (TypeError, ValueError):
            pass
    return statistics.fmean(values) if values else None


def _derive(summary: dict[str, Any], stats: dict[str, Any], metrics: list[dict[str, Any]]) -> dict[str, Any]:
    cohort = summary["cohort"]
    database = summary.get("database_results", {})
    students = int(cohort["students"])
    accepted = int(summary.get("locust_counters", {}).get("submission_accepted", 0))
    stats["accepted_submissions_per_ramp_second"] = round(accepted / max(1, int(cohort["ramp_seconds"])), 4)
    terminal = int(database.get("graded_waiting_for_teacher_count", 0)) + int(database.get("permanent_failure_count", 0)) + int(database.get("finalized_count", 0))
    span = float(database.get("grading_span_seconds", 0))
    stats["grading_terminal_jobs_per_second"] = round(terminal / span, 4) if terminal and span > 0 else None
    return {
        **stats,
        "expected_students": students,
        "accepted_submissions": accepted,
        "peak_queue_depth": _max_metric(metrics, "queue_depth"),
        "peak_queue_oldest_age_seconds": _max_metric(metrics, "queue_oldest_age_seconds"),
        "peak_worker_active_jobs": _max_metric(metrics, "worker_active_jobs"),
        "peak_worker_fresh_heartbeats": _max_metric(metrics, "worker_fresh_heartbeats"),
        "peak_worker_ready_heartbeats": _max_metric(metrics, "worker_ready_heartbeats"),
        "peak_cloud_run_instances_from_monitoring": _max_metric(metrics, "cloud_run_instance_count"),
        "peak_cloud_run_active_instances_from_monitoring": _max_metric(metrics, "cloud_run_active_instances"),
        "mean_cloud_run_cpu_utilization": _mean_metric(metrics, "cloud_run_cpu_utilization"),
        "peak_worker_completed_jobs_per_second": _max_metric(metrics, "worker_completed_jobs_per_second"),
        "metrics_sample_count": len(metrics),
    }


def _comparison_lines(summary: dict[str, Any], summaries: list[dict[str, Any]]) -> list[str]:
    current = summary.get("cohort", {})
    previous = [
        item for item in summaries
        if item.get("run_id") != summary.get("run_id")
        and item.get("cohort", {}).get("plan") == current.get("plan")
        and item.get("cohort", {}).get("failure_mode") == current.get("failure_mode")
        and item.get("correctness_passed")
        and item.get("derived_metrics")
    ]
    previous.sort(key=lambda item: item.get("completed_at", ""))
    if not previous:
        return ["No earlier correctness-passing run in this plan is available for comparison."]
    lines = ["| Run | Students | Worker instances (configured) | Accepted submissions/ramp s | Aggregate p95 (ms) | Drain (s) |", "|---|---:|---:|---:|---:|---:|"]
    for item in previous[-8:] + [summary]:
        derived = item.get("derived_metrics", {})
        lines.append(
            f"| `{item.get('cohort', {}).get('id', 'unknown')}` | {item.get('cohort', {}).get('students', '—')} "
            f"| {item.get('cloud_run_worker_instances_configured', '—')} "
            f"| {_fmt(derived.get('accepted_submissions_per_ramp_second'))} "
            f"| {_fmt(derived.get('locust_p95_ms'))} | {_fmt(item.get('drain_seconds'))} |"
        )
    return lines


def _bottleneck_observations(summary: dict[str, Any], derived: dict[str, Any]) -> tuple[list[str], str]:
    cohort = summary.get("cohort", {})
    capacity = int(summary.get("cloud_run_worker_instances_configured", 0)) * int(summary.get("configured_worker_concurrency", 0))
    peak_active = derived.get("peak_worker_active_jobs")
    peak_queue = derived.get("peak_queue_depth")
    cloud_instances = derived.get("peak_cloud_run_instances_from_monitoring")
    observations: list[str] = []
    if cloud_instances is None:
        observations.append("Cloud Monitoring returned no Cloud Run instance-count sample for this run; worker heartbeat counts are process telemetry, not a substitute for the requested Cloud Run instance measurement.")
    else:
        observations.append(f"Cloud Monitoring observed a peak of {int(cloud_instances)} worker-service instance(s); the service was configured for {summary.get('cloud_run_worker_instances_configured')}.")
    if peak_queue is None:
        observations.append("Queue depth could not be measured reliably; no queue-capacity conclusion is supported.")
    elif peak_queue > 0 and peak_active is not None and capacity > 0 and peak_active >= capacity:
        observations.append("The queue had backlog while observed active jobs reached the configured per-instance worker-slot budget. This is evidence of a worker-pool capacity limit; it does not isolate provider wait, database persistence, or CPU as the root cause.")
    elif peak_queue and peak_queue > 0 and peak_active is not None and capacity > peak_active:
        observations.append("A queue backlog was observed while worker snapshots showed spare configured job slots. Investigate worker readiness/polling, provider waits, or database/queue latency before increasing instance count.")
    elif peak_queue == 0:
        observations.append("No visible pgmq backlog was sampled; this run did not demonstrate a sustained grading-queue bottleneck at its tested arrival rate.")
    else:
        observations.append("The sampled queue/worker data are insufficient to identify a first bottleneck.")
    if derived.get("locust_p95_ms") is not None:
        observations.append(f"Aggregate Locust p95 was {_fmt(derived['locust_p95_ms'])} ms across submission, progress, dashboard, and image readback HTTP requests.")
    if cohort.get("failure_mode") == "transient":
        recovered = summary.get("database_results", {}).get("recovered_after_retry_count", 0)
        observations.append(f"{recovered} submission(s) completed after at least one worker attempt retry under transient fault injection.")
    if cohort.get("failure_mode") == "permanent":
        failures = summary.get("database_results", {}).get("permanent_failure_count", 0)
        observations.append(f"{failures} submission(s) ended in permanent failure under the configured injected-failure rate; source work remains in the submission records.")
    if cohort.get("failure_mode") == "timeout":
        timeout_run = summary.get("timeout_run", {})
        manual = summary.get("manual_override", {})
        observations.append(
            f"{timeout_run.get('hard_cutoff_failure_count', 0)} job(s) reached the whole-run hard cutoff; "
            f"keepalive overlap with a provider wait was observed: {timeout_run.get('keepalive_during_provider_wait', False)}."
        )
        observations.append(
            f"Manual recovery preserved {manual.get('failure_records_preserved', 0)} failure records; "
            f"teacher audit history was visible: {manual.get('teacher_view_shows_manual_grade_audit', False)}; "
            f"{manual.get('unapproved_manual_grades_hidden_from_students', 0)} drafts stayed hidden, "
            f"and one teacher-approved manual grade was visible after refresh: {manual.get('approved_manual_grade_visible_after_refresh', False)}."
        )

    if cloud_instances is None:
        next_step = "Enable Cloud Monitoring read access and capture the Cloud Run instance-count metric before making a worker-capacity recommendation."
    elif peak_queue and peak_queue > 0 and peak_active is not None and capacity > 0 and peak_active >= capacity and cohort.get("worker_instances", 1) == 1:
        next_step = "Repeat the same cohort and failure mode with the 2- and 5-instance worker configurations; compare grading throughput, queue drain, p95, and observed instance counts before changing the production-sized service."
    elif not summary.get("correctness_passed"):
        next_step = "Resolve the failed correctness check and rerun this isolated cohort before using its performance numbers for a capacity decision."
    else:
        next_step = "Run the next planned isolated cohort at a larger student count, then compare the queue-drain and latency curves; these results do not establish capacity beyond the measured cohort."
    return observations, next_step


def _fmt(value: Any) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.3f}".rstrip("0").rstrip(".")
    return str(value)


def _markdown(summary: dict[str, Any], derived: dict[str, Any], checks: dict[str, bool], observations: list[str], next_step: str, plots: list[str], comparisons: list[str]) -> str:
    cohort = summary["cohort"]
    database = summary.get("database_results", {})
    status_counts = database.get("status_counts", {})
    check_lines = [f"- [{'x' if passed else ' '}] `{name}`" for name, passed in checks.items()]
    plot_lines = [f"- [{name}]({name})" for name in plots]
    observation_lines = [f"- {line}" for line in observations]
    return "\n".join([
        f"# Load test report: {cohort['id']}",
        "",
        f"- Run ID: `{summary.get('run_id')}`",
        f"- Completed: `{summary.get('completed_at', 'unknown')}`",
        f"- Target: Cloud Run project `{summary.get('target', {}).get('project_id')}`, region `{summary.get('target', {}).get('region')}`, web `{summary.get('target', {}).get('web_service')}`, worker `{summary.get('target', {}).get('worker_service')}`",
        f"- Cohort: **{cohort['students']} unique students**, ramp {cohort['ramp_seconds']}s + sustain {cohort['sustain_seconds']}s",
        f"- Mock configuration: OCR/grading mock, seed 42, failure mode `{cohort['failure_mode']}` at configured rate `{cohort['failure_rate']}`",
        f"- Worker configuration: {summary.get('cloud_run_worker_instances_configured')} Cloud Run instance(s) configured × {summary.get('configured_worker_concurrency')} job slots/instance; HTTP request concurrency `{summary.get('preflight', {}).get('cloud_run', {}).get('worker', {}).get('cloud_run_request_concurrency', 'unknown')}`; lease `{summary.get('cohort', {}).get('worker_lease_seconds', 120)}s`, OCR timeout `{summary.get('cohort', {}).get('ocr_timeout_ms', 15000)}ms`, grading timeout `{summary.get('cohort', {}).get('grading_timeout_ms', 20000)}ms`.",
        "",
        "## Measured results",
        "",
        f"- Correctness: **{'PASS' if summary.get('correctness_passed') else 'FAIL'}**",
        f"- Locust HTTP requests: {derived.get('request_count', 0)}; failed requests: {derived.get('request_failures', 0)}",
        f"- Aggregate HTTP latency: p50 **{_fmt(derived.get('locust_p50_ms'))} ms**, p95 **{_fmt(derived.get('locust_p95_ms'))} ms**, p99 **{_fmt(derived.get('locust_p99_ms'))} ms**",
        f"- Average Locust HTTP throughput: **{_fmt(derived.get('requests_per_second_average'))} requests/s**; accepted submissions during the ramp: **{_fmt(derived.get('accepted_submissions_per_ramp_second'))}/s**",
        f"- Grading terminal throughput over the observed DB submission span: **{_fmt(derived.get('grading_terminal_jobs_per_second'))} jobs/s**",
        f"- Queue peak: **{_fmt(derived.get('peak_queue_depth'))}** messages; peak oldest-message age: **{_fmt(derived.get('peak_queue_oldest_age_seconds'))}s**; drain after Locust stopped: **{_fmt(summary.get('drain_seconds'))}s** (drained: `{summary.get('queue_drained')}`)",
        f"- Cloud Run worker instances observed by Cloud Monitoring: peak **{_fmt(derived.get('peak_cloud_run_instances_from_monitoring'))}**; fresh worker heartbeats: peak **{_fmt(derived.get('peak_worker_fresh_heartbeats'))}**; peak active jobs **{_fmt(derived.get('peak_worker_active_jobs'))}**; peak completed-job rate **{_fmt(derived.get('peak_worker_completed_jobs_per_second'))}/s**",
        f"- Submission outcomes after drain: `{json.dumps(status_counts, sort_keys=True)}`; retries observed: {database.get('retry_attempt_submissions', 0)}, recovered after retry: {database.get('recovered_after_retry_count', 0)}",
        f"- Timeout/manual override: hard-cutoff outcomes `{summary.get('timeout_run', {}).get('hard_cutoff_failure_count', 0)}`; teacher audit visible `{summary.get('manual_override', {}).get('teacher_view_shows_manual_grade_audit', False)}`; manual-grade result `{summary.get('manual_override', {}).get('passed', 'not run')}`.",
        f"- Supabase Storage: {database.get('image_submission_count', 0)} canvas-image submissions; {summary.get('locust_counters', {}).get('image_readbacks_ok', 0)} authorized private-image readbacks passed",
        "",
        "## Correctness checks",
        "",
        *check_lines,
        "",
        "## Bottleneck observations (measured indicators, not root-cause claims)",
        "",
        *observation_lines,
        "",
        "## Comparison with previous runs in this plan",
        "",
        *comparisons,
        "",
        "## Recommended next step",
        "",
        next_step,
        "",
        "## Plots",
        "",
        *plot_lines,
        "",
        "## Scope and caveats",
        "",
        "This run used only Goblins mock OCR/grading providers and an isolated Cloud Run/Supabase stack. HTTP throughput is the measured application workload; the mock provider latency and the tested worker configuration are part of the result. A single cohort is not a universal service-capacity claim. No production or live-demo data should be included in these artifacts.",
        "",
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()
    summary_path = run_dir / "summary.json"
    if not summary_path.exists():
        parser.error("run directory has no summary.json")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    history = _read_csv(run_dir / "locust_stats_history.csv")
    stats = _stats(run_dir / "locust_stats.csv", run_dir / "locust_stats_history.csv", summary["cohort"])
    metrics = read_metrics(run_dir / "metrics.jsonl")
    derived = _derive(summary, stats, metrics)
    summary["derived_metrics"] = derived
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    summary_path.chmod(0o600)
    previous = _all_summaries(run_dir.parent)
    plots = generate_plots(run_dir, history, metrics, summary, previous)
    observations, next_step = _bottleneck_observations(summary, derived)
    report = _markdown(
        summary, derived, summary.get("correctness_checks", {}), observations, next_step, plots,
        _comparison_lines(summary, previous),
    )
    report_path = run_dir / "report.md"
    report_path.write_text(report, encoding="utf-8")
    report_path.chmod(0o600)
    print(f"Generated {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
