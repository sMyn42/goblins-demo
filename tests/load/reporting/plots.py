"""Generate plots exclusively from Locust CSV and this test run's JSONL telemetry."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt


def read_metrics(path: Path) -> list[dict[str, Any]]:
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _num(row: dict[str, Any], key: str) -> float | None:
    try:
        value = row.get(key)
        return float(value) if value not in (None, "", "N/A") else None
    except (TypeError, ValueError):
        return None


def _time(row: dict[str, Any]):
    from datetime import datetime

    value = row.get("timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def _save(fig, path: Path) -> None:
    fig.tight_layout()
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)


def plot_throughput_vs_users(history: list[dict[str, str]], path: Path) -> None:
    pairs = [(_num(row, "User Count"), _num(row, "Requests/s"), _num(row, "Failures/s")) for row in history]
    rows = sorted((users, requests, failures) for users, requests, failures in pairs if users is not None and requests is not None)
    fig, ax = plt.subplots(figsize=(9, 5))
    if rows:
        ax.plot([row[0] for row in rows], [row[1] for row in rows], marker=".", label="Requests/s")
        if any(row[2] is not None for row in rows):
            ax.plot([row[0] for row in rows], [row[2] or 0 for row in rows], marker=".", label="Failures/s")
        ax.legend()
    else:
        ax.text(0.5, 0.5, "No Locust history data", ha="center", va="center", transform=ax.transAxes)
    ax.set(title="HTTP throughput vs concurrent Locust users", xlabel="Locust users (students + 1 teacher)", ylabel="Requests per second")
    ax.grid(True, alpha=0.25)
    _save(fig, path)


def plot_latency(history: list[dict[str, str]], path: Path) -> None:
    rows = []
    for row in history:
        users, p50, p95, p99 = (_num(row, key) for key in ("User Count", "50%", "95%", "99%"))
        if users is not None and any(value is not None for value in (p50, p95, p99)):
            rows.append((users, p50, p95, p99))
    fig, ax = plt.subplots(figsize=(9, 5))
    for index, label in ((1, "p50"), (2, "p95"), (3, "p99")):
        if any(row[index] is not None for row in rows):
            ax.plot([row[0] for row in rows], [row[index] for row in rows], marker=".", label=label)
    if not rows:
        ax.text(0.5, 0.5, "No Locust latency history", ha="center", va="center", transform=ax.transAxes)
    else:
        ax.legend()
    ax.set(title="HTTP latency vs concurrent Locust users", xlabel="Locust users (students + 1 teacher)", ylabel="Response time (ms)")
    ax.grid(True, alpha=0.25)
    _save(fig, path)


def plot_queue(metrics: list[dict[str, Any]], path: Path) -> None:
    rows = [(stamp, _num(row, "queue_depth"), _num(row, "queue_oldest_age_seconds"), row.get("phase", "")) for row in metrics if (stamp := _time(row))]
    fig, ax = plt.subplots(figsize=(10, 5))
    depth_rows = [row for row in rows if row[1] is not None]
    if depth_rows:
        ax.step([row[0] for row in depth_rows], [row[1] for row in depth_rows], where="post", label="Queue depth")
        ax.set_ylabel("Visible pgmq messages")
        age_rows = [row for row in rows if row[2] is not None]
        if age_rows:
            age_ax = ax.twinx()
            age_ax.plot([row[0] for row in age_rows], [row[2] for row in age_rows], color="tab:orange", alpha=0.8, label="Oldest message age")
            age_ax.set_ylabel("Oldest message age (seconds)")
            lines, labels = ax.get_legend_handles_labels()
            other_lines, other_labels = age_ax.get_legend_handles_labels()
            ax.legend(lines + other_lines, labels + other_labels, loc="upper left")
        else:
            ax.legend()
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S"))
    else:
        ax.text(0.5, 0.5, "No queue telemetry", ha="center", va="center", transform=ax.transAxes)
    ax.set(title="pgmq grading queue depth and oldest job age", xlabel="UTC sample time")
    ax.grid(True, alpha=0.25)
    _save(fig, path)


def plot_workers(metrics: list[dict[str, Any]], path: Path) -> None:
    rows = [(stamp, row) for row in metrics if (stamp := _time(row))]
    fig, ax = plt.subplots(figsize=(10, 5))
    fields = (
        ("worker_active_jobs", "Active jobs"),
        ("cloud_run_instance_count", "Cloud Run instances (Monitoring)"),
        ("worker_fresh_heartbeats", "Fresh worker heartbeats"),
    )
    drew = False
    for key, label in fields:
        present = [(stamp, _num(row, key)) for stamp, row in rows if _num(row, key) is not None]
        if present:
            ax.step([item[0] for item in present], [item[1] for item in present], where="post", label=label)
            drew = True
    throughput = [(stamp, _num(row, "worker_completed_jobs_per_second")) for stamp, row in rows if _num(row, "worker_completed_jobs_per_second") is not None]
    if throughput:
        rate_ax = ax.twinx()
        rate_ax.plot([item[0] for item in throughput], [item[1] for item in throughput], color="tab:green", label="Completed jobs/s")
        rate_ax.set_ylabel("Completed jobs per second")
        first_lines, first_labels = ax.get_legend_handles_labels()
        second_lines, second_labels = rate_ax.get_legend_handles_labels()
        ax.legend(first_lines + second_lines, first_labels + second_labels, loc="upper left")
        drew = True
    elif drew:
        ax.legend(loc="upper left")
    if not drew:
        ax.text(0.5, 0.5, "No worker telemetry", ha="center", va="center", transform=ax.transAxes)
    ax.set(title="Worker activity, observed instances, and grading throughput", xlabel="UTC sample time", ylabel="Jobs / instances")
    ax.grid(True, alpha=0.25)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S"))
    _save(fig, path)


def plot_outcomes(summary: dict[str, Any], path: Path) -> None:
    counts = summary.get("database_results", {}).get("status_counts", {})
    labels = list(counts)
    values = [counts[label] for label in labels]
    fig, ax = plt.subplots(figsize=(8, 4.5))
    if labels:
        ax.bar(labels, values, color=["#4c78a8" if label == "waiting_for_teacher" else "#e45756" if "failure" in label else "#72b7b2" for label in labels])
        ax.tick_params(axis="x", rotation=20)
    else:
        ax.text(0.5, 0.5, "No submissions recorded", ha="center", va="center", transform=ax.transAxes)
    ax.set(title="Submission outcomes after queue drain", xlabel="Persisted status", ylabel="Submissions")
    ax.grid(axis="y", alpha=0.25)
    _save(fig, path)


def plot_drain(metrics: list[dict[str, Any]], path: Path) -> None:
    rows = [(stamp, _num(row, "queue_depth")) for row in metrics if row.get("phase") == "queue_drain" and (stamp := _time(row)) and _num(row, "queue_depth") is not None]
    fig, ax = plt.subplots(figsize=(8, 4.5))
    if rows:
        start = rows[0][0]
        x = [(stamp - start).total_seconds() for stamp, _ in rows]
        ax.step(x, [depth for _, depth in rows], where="post", marker=".")
        ax.set_xlabel("Seconds after Locust stopped")
    else:
        ax.text(0.5, 0.5, "No post-load drain samples", ha="center", va="center", transform=ax.transAxes)
        ax.set_xlabel("Seconds after Locust stopped")
    ax.set(title="Queue drain after stopping load generation", ylabel="Visible pgmq messages")
    ax.grid(True, alpha=0.25)
    _save(fig, path)


def plot_capacity(summaries: list[dict[str, Any]], current: dict[str, Any], path: Path) -> None:
    comparable = [item for item in summaries if item.get("cohort", {}).get("failure_mode") == "none" and item.get("correctness_passed")]
    if current.get("correctness_passed") and current.get("cohort", {}).get("failure_mode") == "none":
        comparable = [item for item in comparable if item.get("run_id") != current.get("run_id")] + [current]
    fig, ax = plt.subplots(figsize=(8, 5))
    points = []
    for item in comparable:
        derived = item.get("derived_metrics", {})
        students = item.get("cohort", {}).get("students")
        throughput = derived.get("accepted_submissions_per_ramp_second")
        p95 = derived.get("locust_p95_ms")
        if students and throughput is not None and p95 is not None:
            points.append((int(students), float(throughput), float(p95), item.get("cohort", {}).get("id", "run")))
    if points:
        scatter = ax.scatter([p[0] for p in points], [p[1] for p in points], c=[p[2] for p in points], cmap="viridis", s=70)
        for students, throughput, _p95, label in points:
            ax.annotate(label, (students, throughput), xytext=(4, 4), textcoords="offset points", fontsize=7)
        fig.colorbar(scatter, ax=ax, label="Locust aggregate p95 (ms)")
    else:
        ax.text(0.5, 0.5, "No completed comparable load runs yet", ha="center", va="center", transform=ax.transAxes)
    ax.set(title="Observed submission throughput vs cohort size", xlabel="Unique students in cohort", ylabel="Accepted submissions / ramp second")
    ax.grid(True, alpha=0.25)
    _save(fig, path)


def generate_plots(run_dir: Path, history: list[dict[str, str]], metrics: list[dict[str, Any]], summary: dict[str, Any], all_summaries: list[dict[str, Any]]) -> list[str]:
    plots = {
        "throughput_vs_users.png": lambda path: plot_throughput_vs_users(history, path),
        "latency_percentiles.png": lambda path: plot_latency(history, path),
        "queue_depth_and_age.png": lambda path: plot_queue(metrics, path),
        "worker_activity_and_instances.png": lambda path: plot_workers(metrics, path),
        "submission_outcomes.png": lambda path: plot_outcomes(summary, path),
        "queue_drain.png": lambda path: plot_drain(metrics, path),
        "capacity_curve.png": lambda path: plot_capacity(all_summaries, summary, path),
    }
    for filename, render in plots.items():
        render(run_dir / filename)
    return list(plots)
