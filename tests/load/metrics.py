"""Time-series sampling for the real isolated Cloud Run app, workers, DB queue, and grades."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import threading
import time
from typing import Any

import psycopg
import requests

try:
    from google.cloud import monitoring_v3
except ImportError:  # A clear error is raised by the preflight instead of hiding the gap.
    monitoring_v3 = None

from config import Cohort, Settings


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def queue_snapshot(database_url: str) -> dict[str, Any]:
    with psycopg.connect(database_url, connect_timeout=5, autocommit=True) as connection:
        row = connection.execute(
            "SELECT count(*)::bigint, "
            "COALESCE(extract(epoch FROM (clock_timestamp() - min(enqueued_at))), 0)::double precision "
            "FROM pgmq.q_grading_jobs"
        ).fetchone()
    return {"queue_depth": int(row[0]), "queue_oldest_age_seconds": round(float(row[1]), 3)}


def assignment_snapshot(database_url: str, assignment_id: str) -> dict[str, Any]:
    with psycopg.connect(database_url, connect_timeout=5, autocommit=True) as connection:
        row = connection.execute(
            "SELECT count(*)::bigint, "
            "count(*) FILTER (WHERE status = 'waiting_for_teacher')::bigint, "
            "count(*) FILTER (WHERE status = 'permanent_failure')::bigint, "
            "count(*) FILTER (WHERE status IN ('submitted','processing','auto_grading','retryable_failure'))::bigint "
            "FROM submissions WHERE assignment_version_id = %s::uuid",
            (assignment_id,),
        ).fetchone()
    return {
        "assignment_submissions": int(row[0]),
        "assignment_waiting_for_teacher": int(row[1]),
        "assignment_permanent_failure": int(row[2]),
        "assignment_nonterminal": int(row[3]),
    }


def database_guard(database_url: str) -> None:
    try:
        with psycopg.connect(database_url, connect_timeout=5, autocommit=True) as connection:
            row = connection.execute(
                "SELECT environment FROM public.loadtest_environment_guard WHERE id = true"
            ).fetchone()
            if row is None or row[0] != "isolated-load-test":
                raise RuntimeError
            connection.execute("SELECT count(*) FROM pgmq.q_grading_jobs").fetchone()
    except Exception as exc:
        raise RuntimeError("Isolated DB guard or pgmq grading queue check failed; refusing to run") from exc


def _monitor_value(point: Any) -> float | None:
    value = point.value
    try:
        active_field = value.WhichOneof("value")
    except (AttributeError, ValueError):
        active_field = None
    if active_field in {"int64_value", "double_value"}:
        try:
            return float(getattr(value, active_field))
        except (AttributeError, TypeError, ValueError):
            return None
    if active_field == "distribution_value":
        try:
            return float(value.distribution_value.count)
        except (AttributeError, TypeError, ValueError):
            return None
    return None


class MetricsSampler:
    def __init__(self, settings: Settings, cohort: Cohort, assignment_id: str, output: Path):
        self.settings = settings
        self.cohort = cohort
        self.assignment_id = assignment_id
        self.output = output
        self.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._phase_lock = threading.Lock()
        self._phase = "warmup"
        self._errors: list[str] = []
        self._monitor_client = None
        self._previous_completed: int | None = None
        self._previous_completed_at: float | None = None
        self._last_cloud_metric_poll = 0.0
        self._latest_cloud_metrics: dict[str, Any] = {
            "cloud_run_instance_count": None,
            "cloud_run_active_instances": None,
            "cloud_run_idle_instances": None,
            "cloud_run_cpu_utilization": None,
        }
        if monitoring_v3 is not None:
            try:
                self._monitor_client = monitoring_v3.MetricServiceClient()
            except Exception as exc:
                self._errors.append(f"cloud-monitoring-client:{type(exc).__name__}")
        else:
            self._errors.append("cloud-monitoring-package-missing")

    def set_phase(self, value: str) -> None:
        with self._phase_lock:
            self._phase = value

    def start(self) -> None:
        self.output.touch(mode=0o600, exist_ok=True)
        self.output.chmod(0o600)
        self._thread = threading.Thread(target=self._sample_loop, name="loadtest-metrics", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=max(10, self.settings.sample_interval_seconds * 2))

    def errors(self) -> list[str]:
        return list(self._errors)

    def _sample_loop(self) -> None:
        connection = None
        try:
            connection = psycopg.connect(self.settings.database_url, connect_timeout=5, autocommit=True)
            while not self._stop.is_set():
                started = time.monotonic()
                self._sample(connection)
                remaining = self.settings.sample_interval_seconds - (time.monotonic() - started)
                self._stop.wait(max(0.1, remaining))
        except Exception as exc:
            self._errors.append(f"sampler-stopped:{type(exc).__name__}")
        finally:
            if connection:
                connection.close()

    def _sample(self, connection: psycopg.Connection) -> None:
        now = utc_now()
        with self._phase_lock:
            phase = self._phase
        sample: dict[str, Any] = {"timestamp": now.isoformat(), "phase": phase}
        try:
            queue = connection.execute(
                "SELECT count(*)::bigint, "
                "COALESCE(extract(epoch FROM (clock_timestamp() - min(enqueued_at))), 0)::double precision "
                "FROM pgmq.q_grading_jobs"
            ).fetchone()
            sample["queue_depth"] = int(queue[0])
            sample["queue_oldest_age_seconds"] = round(float(queue[1]), 3)
        except Exception as exc:
            sample["queue_depth"] = None
            sample["queue_error"] = type(exc).__name__
            self._errors.append(f"queue:{type(exc).__name__}")

        try:
            row = connection.execute(
                "SELECT count(*)::bigint, "
                "count(*) FILTER (WHERE status = 'waiting_for_teacher')::bigint, "
                "count(*) FILTER (WHERE status = 'permanent_failure')::bigint, "
                "count(*) FILTER (WHERE status IN ('submitted','processing','auto_grading','retryable_failure'))::bigint "
                "FROM submissions WHERE assignment_version_id = %s::uuid",
                (self.assignment_id,),
            ).fetchone()
            sample.update({
                "assignment_submissions": int(row[0]),
                "assignment_waiting_for_teacher": int(row[1]),
                "assignment_permanent_failure": int(row[2]),
                "assignment_nonterminal": int(row[3]),
            })
        except Exception as exc:
            sample["assignment_query_error"] = type(exc).__name__
            self._errors.append(f"assignment:{type(exc).__name__}")

        sample.update(self._worker_metrics())
        if self._monitor_client and time.monotonic() - self._last_cloud_metric_poll >= 30:
            self._last_cloud_metric_poll = time.monotonic()
            self._latest_cloud_metrics = self._cloud_metrics()
        sample.update(self._latest_cloud_metrics)

        completed = sample.get("worker_completed_total")
        monotonic_now = time.monotonic()
        if isinstance(completed, int):
            if self._previous_completed is not None and self._previous_completed_at is not None:
                elapsed = monotonic_now - self._previous_completed_at
                sample["worker_completed_jobs_per_second"] = round(max(0, completed - self._previous_completed) / elapsed, 4) if elapsed > 0 else 0.0
            else:
                sample["worker_completed_jobs_per_second"] = None
            self._previous_completed = completed
            self._previous_completed_at = monotonic_now
        else:
            sample["worker_completed_jobs_per_second"] = None

        try:
            with self.output.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(sample, separators=(",", ":")) + "\n")
        except Exception as exc:
            self._errors.append(f"write:{type(exc).__name__}")

    def _worker_metrics(self) -> dict[str, Any]:
        try:
            response = requests.get(
                f"{self.settings.base_url}/api/worker-status",
                headers={"Authorization": f"Bearer {self.settings.worker_monitor_token}"},
                timeout=5,
            )
            if response.status_code != 200:
                raise RuntimeError(f"worker-status-http-{response.status_code}")
            payload = response.json()
            workers = payload.get("workers", [])
            fresh = [worker for worker in workers if worker.get("fresh")]
            ready = [worker for worker in fresh if worker.get("ready")]
            snapshots = [worker.get("snapshot", {}) for worker in fresh]
            return {
                "worker_fresh_heartbeats": len(fresh),
                "worker_ready_heartbeats": len(ready),
                "worker_probe_loops_running": sum(int(bool(snapshot.get("probeLoopRunning"))) for snapshot in snapshots),
                "worker_active_jobs": sum(int(snapshot.get("activeJobs", 0)) for snapshot in snapshots),
                "worker_waiting_ocr": sum(int(snapshot.get("waitingOCR", 0)) for snapshot in snapshots),
                "worker_waiting_grading": sum(int(snapshot.get("waitingGrading", 0)) for snapshot in snapshots),
                "worker_persisting": sum(int(snapshot.get("persisting", 0)) for snapshot in snapshots),
                "worker_completed_total": sum(int(snapshot.get("completedJobs", 0)) for snapshot in snapshots),
                "worker_failed_attempts_total": sum(int(snapshot.get("failedAttempts", 0)) for snapshot in snapshots),
                "worker_provider_timeouts_total": sum(int(snapshot.get("providerTimeouts", 0)) for snapshot in snapshots),
                "worker_oldest_provider_wait_ms": max((snapshot.get("oldestProviderWaitMs") or 0 for snapshot in snapshots), default=0),
            }
        except Exception as exc:
            self._errors.append(f"worker-status:{type(exc).__name__}")
            return {
                "worker_fresh_heartbeats": None,
                "worker_ready_heartbeats": None,
                "worker_probe_loops_running": None,
                "worker_active_jobs": None,
                "worker_waiting_ocr": None,
                "worker_waiting_grading": None,
                "worker_persisting": None,
                "worker_completed_total": None,
                "worker_failed_attempts_total": None,
                "worker_provider_timeouts_total": None,
                "worker_oldest_provider_wait_ms": None,
            }

    def _cloud_metrics(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "cloud_run_instance_count": None,
            "cloud_run_active_instances": None,
            "cloud_run_idle_instances": None,
            "cloud_run_cpu_utilization": None,
        }
        try:
            end = utc_now()
            interval = monitoring_v3.TimeInterval(start_time=end - timedelta(minutes=3), end_time=end)
            base_filter = (
                'resource.type = "cloud_run_revision" '
                f'AND resource.labels.service_name = "{self.settings.worker_service}" '
                f'AND resource.labels.location = "{self.settings.region}"'
            )
            series = self._monitor_client.list_time_series(
                name=f"projects/{self.settings.project_id}",
                filter=f'metric.type = "run.googleapis.com/container/instance_count" AND {base_filter}',
                interval=interval,
                view=monitoring_v3.ListTimeSeriesRequest.TimeSeriesView.FULL,
                timeout=8,
            )
            counts: dict[str, float] = {}
            for item in series:
                if not item.points:
                    continue
                point = max(item.points, key=lambda current: current.interval.end_time.timestamp())
                value = _monitor_value(point)
                if value is None:
                    continue
                state = item.metric.labels.get("state", "all")
                counts[state] = counts.get(state, 0.0) + value
            if counts:
                result["cloud_run_instance_count"] = int(round(sum(counts.values())))
                result["cloud_run_active_instances"] = int(round(counts.get("active", 0.0)))
                result["cloud_run_idle_instances"] = int(round(counts.get("idle", 0.0)))

            cpu_series = self._monitor_client.list_time_series(
                name=f"projects/{self.settings.project_id}",
                filter=f'metric.type = "run.googleapis.com/container/cpu/utilizations" AND {base_filter}',
                interval=interval,
                view=monitoring_v3.ListTimeSeriesRequest.TimeSeriesView.FULL,
                timeout=8,
            )
            cpu_values = []
            for item in cpu_series:
                if not item.points:
                    continue
                point = max(item.points, key=lambda current: current.interval.end_time.timestamp())
                value = _monitor_value(point)
                if value is not None:
                    cpu_values.append(value)
            if cpu_values:
                result["cloud_run_cpu_utilization"] = round(sum(cpu_values) / len(cpu_values), 4)
        except Exception as exc:
            self._errors.append(f"cloud-monitoring:{type(exc).__name__}")
        return result
