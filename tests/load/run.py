"""Run one isolated Locust cohort (or the sequential 50/250/1,250 scale plan)."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any
import uuid

import psycopg
import requests

from config import Cohort, LoadTestConfigError, Settings, load_cohort_data, load_settings
from metrics import MetricsSampler, assignment_snapshot, database_guard, queue_snapshot

LOAD_DIR = Path(__file__).resolve().parent
REPORT_SCRIPT = LOAD_DIR / "reporting" / "generate_report.py"


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    temp.chmod(0o600)
    temp.replace(path)


def gcloud_json(settings: Settings, service_name: str) -> dict[str, Any]:
    command = [
        "gcloud", "run", "services", "describe", service_name,
        "--project", settings.project_id, "--region", settings.region, "--format=json",
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=45)
        return json.loads(result.stdout)
    except FileNotFoundError as exc:
        raise RuntimeError("gcloud CLI is required for isolated-service verification") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Could not describe isolated Cloud Run service {service_name}; verify project and region") from exc
    except (json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"Could not read isolated Cloud Run service {service_name}") from exc


def _template(service: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    spec = service.get("spec", {})
    template = spec.get("template", {}) if isinstance(spec, dict) else {}
    template_spec = template.get("spec", template) if isinstance(template, dict) else {}
    containers = template_spec.get("containers", []) if isinstance(template_spec, dict) else []
    if not containers:
        raise RuntimeError("Cloud Run service has no readable container template")
    return spec, template, containers


def _env(service: dict[str, Any]) -> tuple[dict[str, str], dict[str, str | None]]:
    _, _, containers = _template(service)
    values: dict[str, str] = {}
    secrets: dict[str, str | None] = {}
    for entry in containers[0].get("env", []):
        name = entry.get("name")
        if not name:
            continue
        if isinstance(entry.get("value"), str):
            values[name] = entry["value"]
        secret_ref = (entry.get("valueFrom") or {}).get("secretKeyRef") or (entry.get("valueSource") or {}).get("secretKeyRef") or {}
        secret_name = secret_ref.get("name") or secret_ref.get("secret")
        if isinstance(secret_name, str):
            secrets[name] = secret_name.rsplit("/", 1)[-1]
    return values, secrets


def _annotation_scales(service: dict[str, Any], template: dict[str, Any]) -> tuple[int | None, int | None]:
    annotations = {}
    for item in (
        (service.get("metadata") or {}).get("annotations", {}),
        (template.get("metadata") or {}).get("annotations", {}),
    ):
        annotations.update(item or {})
    scaling = template.get("scaling", {}) or {}
    spec = service.get("spec", {}) or {}
    service_scaling = service.get("scaling", {}) or spec.get("scaling", {}) or {}
    minimum = scaling.get("minInstanceCount", service_scaling.get("minInstanceCount"))
    maximum = scaling.get("maxInstanceCount", service_scaling.get("maxInstanceCount"))
    for key in ("autoscaling.knative.dev/minScale", "run.googleapis.com/minScale"):
        if minimum is None and key in annotations:
            minimum = annotations[key]
    for key in ("autoscaling.knative.dev/maxScale", "run.googleapis.com/maxScale"):
        if maximum is None and key in annotations:
            maximum = annotations[key]
    try:
        minimum = int(minimum) if minimum is not None else None
    except (TypeError, ValueError):
        minimum = None
    try:
        maximum = int(maximum) if maximum is not None else None
    except (TypeError, ValueError):
        maximum = None
    return minimum, maximum


def _check_secret(secrets: dict[str, str | None], env_name: str, expected: str, service_label: str) -> None:
    if secrets.get(env_name) != expected:
        raise RuntimeError(f"{service_label} {env_name} must reference the dedicated load-test Secret Manager secret {expected}")


def _check_service(settings: Settings, cohort: Cohort, service: dict[str, Any], role: str) -> dict[str, Any]:
    expected_name = settings.web_service if role == "web" else settings.worker_service
    status_url = (service.get("status") or {}).get("url")
    if role == "web" and status_url != settings.base_url:
        raise RuntimeError("LOADTEST_BASE_URL must exactly match the dedicated load-test web service URL")
    values, secrets = _env(service)
    for key, expected in (("APP_MODE", "load-test"), ("OCR_PROVIDER", "mock"), ("GRADING_PROVIDER", "mock"), ("MOCK_SEED", "42")):
        if values.get(key) != expected:
            raise RuntimeError(f"{expected_name} must explicitly set {key}={expected}")
    if values.get("OPENROUTER_API_KEY") or "OPENROUTER_API_KEY" in secrets:
        raise RuntimeError(f"{expected_name} must not have an OpenRouter API key configured")
    if values.get("STORAGE_PROVIDER") != "supabase" or values.get("SUPABASE_URL", "").rstrip("/") != settings.supabase_url:
        raise RuntimeError(f"{expected_name} must use the dedicated isolated Supabase Storage project")
    if values.get("SUPABASE_STORAGE_BUCKET") != settings.storage_bucket:
        raise RuntimeError(f"{expected_name} must use the dedicated test-only Storage bucket")
    _check_secret(secrets, "DATABASE_URL", settings.database_secret_name, expected_name)
    _check_secret(secrets, "SUPABASE_SERVICE_ROLE_KEY", settings.storage_secret_name, expected_name)
    if role == "web":
        _check_secret(secrets, "WORKER_MONITOR_TOKEN", settings.monitor_secret_name, expected_name)
        if values.get("APP_ORIGIN", "").rstrip("/") != settings.base_url:
            raise RuntimeError("The web service APP_ORIGIN must match LOADTEST_BASE_URL for same-origin submission requests")
    else:
        if values.get("MOCK_FAILURE_MODE") != cohort.failure_mode:
            raise RuntimeError(f"Worker MOCK_FAILURE_MODE must be {cohort.failure_mode} for cohort {cohort.id}")
        try:
            actual_rate = float(values["MOCK_FAILURE_RATE"])
        except (KeyError, ValueError):
            raise RuntimeError("Worker MOCK_FAILURE_RATE must be explicitly set for this experiment") from None
        if abs(actual_rate - cohort.failure_rate) > 1e-9:
            raise RuntimeError(f"Worker MOCK_FAILURE_RATE does not match cohort {cohort.id}")
        try:
            worker_concurrency = int(values["WORKER_CONCURRENCY"])
        except (KeyError, ValueError):
            raise RuntimeError("Worker WORKER_CONCURRENCY must be explicitly configured") from None
        if worker_concurrency != settings.worker_concurrency:
            raise RuntimeError("Worker WORKER_CONCURRENCY differs from LOADTEST_WORKER_CONCURRENCY")
        try:
            max_attempts = int(values.get("WORKER_MAX_ATTEMPTS", "3"))
        except ValueError:
            raise RuntimeError("WORKER_MAX_ATTEMPTS must be an integer") from None
        if max_attempts < 2:
            raise RuntimeError("WORKER_MAX_ATTEMPTS must permit retry verification")
        worker_timing = {
            "WORKER_LEASE_SECONDS": cohort.worker_lease_seconds,
            "OCR_TIMEOUT_MS": cohort.ocr_timeout_ms,
            "GRADING_TIMEOUT_MS": cohort.grading_timeout_ms,
        }
        try:
            actual_timing = {key: int(values.get(key, str(default))) for key, default in worker_timing.items()}
        except ValueError:
            raise RuntimeError("Worker lease and provider timeouts must be integers") from None
        if actual_timing != worker_timing:
            raise RuntimeError(f"Worker lease/provider timeouts do not match cohort {cohort.id}")
        try:
            mock_latency_ms = int(values.get("MOCK_LATENCY_MS", "500"))
            fixed_latencies = {
                key: int(values.get(key, "-1"))
                for key in ("MOCK_FIXED_OCR_LATENCY_MS", "MOCK_FIXED_GRADING_LATENCY_MS")
            }
        except ValueError:
            raise RuntimeError("Mock latency configuration must be integer milliseconds") from None
        if mock_latency_ms != 500 or any(value != -1 for value in fixed_latencies.values()):
            raise RuntimeError("Load-test worker must use seeded 500ms-base log-normal latency without fixed-latency overrides")
        if cohort.failure_mode == "timeout":
            hard_cutoff_ms = cohort.worker_lease_seconds * 1000 - 5000
            try:
                heartbeat_interval_ms = int(values.get("WORKER_HEARTBEAT_INTERVAL_MS", "15000"))
            except ValueError:
                raise RuntimeError("WORKER_HEARTBEAT_INTERVAL_MS must be an integer") from None
            if heartbeat_interval_ms >= hard_cutoff_ms:
                raise RuntimeError("Worker keepalive interval must occur during the timeout cohort hard-cutoff window")

    spec, template, containers = _template(service)
    minimum, maximum = _annotation_scales(service, template)
    if minimum is None or maximum is None:
        raise RuntimeError(f"{expected_name} must explicitly configure both minimum and maximum instance counts")
    if role == "worker" and (minimum != cohort.worker_instances or maximum != cohort.worker_instances):
        raise RuntimeError(
            f"Worker Cloud Run min/max must both be {cohort.worker_instances} for cohort {cohort.id}; "
            f"observed configured min={minimum}, max={maximum}"
        )
    container_concurrency = (
        template.get("maxInstanceRequestConcurrency")
        or (template.get("spec") or {}).get("containerConcurrency")
        or (spec.get("template") or {}).get("spec", {}).get("containerConcurrency")
    )
    return {
        "service": expected_name,
        "url": status_url if role == "web" else None,
        "revision": (service.get("status") or {}).get("latestReadyRevisionName"),
        "image": containers[0].get("image"),
        "configured_min_instances": minimum,
        "configured_max_instances": maximum,
        "cloud_run_request_concurrency": container_concurrency,
        "worker_concurrency": settings.worker_concurrency if role == "worker" else None,
        "mock_failure_mode": values.get("MOCK_FAILURE_MODE"),
        "mock_failure_rate": values.get("MOCK_FAILURE_RATE"),
        "mock_seed": values.get("MOCK_SEED"),
        "mock_latency_ms": values.get("MOCK_LATENCY_MS"),
        "worker_max_attempts": values.get("WORKER_MAX_ATTEMPTS", "3"),
        "worker_lease_seconds": values.get("WORKER_LEASE_SECONDS", "120"),
        "ocr_timeout_ms": values.get("OCR_TIMEOUT_MS", "15000"),
        "grading_timeout_ms": values.get("GRADING_TIMEOUT_MS", "20000"),
        "worker_heartbeat_interval_ms": values.get("WORKER_HEARTBEAT_INTERVAL_MS", "15000"),
    }


def verify_cloud_services(settings: Settings, cohort: Cohort) -> dict[str, Any]:
    web = gcloud_json(settings, settings.web_service)
    worker = gcloud_json(settings, settings.worker_service)
    web_info = _check_service(settings, cohort, web, "web")
    worker_info = _check_service(settings, cohort, worker, "worker")
    web_image = web_info.get("image")
    worker_image = worker_info.get("image")
    if web_image != worker_image:
        raise RuntimeError("The web and worker services must run the same application image")
    return {"web": web_info, "worker": worker_info}


def _headers(settings: Settings) -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.worker_monitor_token}"}


def wait_ready(settings: Settings, cohort: Cohort, timeout_seconds: int = 300) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_error = "not checked"
    while time.monotonic() < deadline:
        try:
            ready = requests.get(f"{settings.base_url}/api/ready", timeout=10)
            if ready.status_code != 200:
                last_error = f"web readiness HTTP {ready.status_code}"
                time.sleep(5)
                continue
            status = requests.get(f"{settings.base_url}/api/worker-status", headers=_headers(settings), timeout=10)
            if status.status_code != 200:
                last_error = f"worker telemetry HTTP {status.status_code}"
                time.sleep(5)
                continue
            payload = status.json()
            if int(payload.get("readyWorkers", 0)) >= cohort.worker_instances:
                return {"web_ready": True, "ready_worker_heartbeats": int(payload["readyWorkers"]), "fresh_worker_heartbeats": int(payload.get("freshWorkers", 0))}
            last_error = f"waiting for {cohort.worker_instances} ready worker heartbeat(s); observed {payload.get('readyWorkers', 0)}"
        except Exception as exc:
            last_error = type(exc).__name__
        time.sleep(5)
    raise RuntimeError(f"Isolated web/worker readiness timed out: {last_error}")


def _load_manifest(settings: Settings, cohort: Cohort) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    try:
        manifest = json.loads(settings.manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Private load-test manifest is missing or invalid; do not print its contents") from exc
    if manifest.get("version") != 1 or cohort.id not in manifest.get("assignments", {}):
        raise RuntimeError("Private manifest does not contain the requested load-test assignment")
    selected = manifest.get("students", [])[cohort.offset:cohort.offset + cohort.students]
    if len(selected) != cohort.students or len({item.get("id") for item in selected}) != cohort.students:
        raise RuntimeError("Private manifest does not contain the cohort's expected unique student sessions")
    return manifest, selected, manifest["assignments"][cohort.id]


def _preflight(settings: Settings, cohort: Cohort, require_manifest: bool = True) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str], dict[str, Any]]:
    cloud = verify_cloud_services(settings, cohort)
    database_guard(settings.database_url)
    ready = wait_ready(settings, cohort)
    manifest, students, assignment = _load_manifest(settings, cohort) if require_manifest else ({}, [], {})
    queue = queue_snapshot(settings.database_url)
    if queue["queue_depth"] != 0:
        raise RuntimeError("The isolated grading queue must be empty before each cohort")
    if require_manifest:
        with psycopg.connect(settings.database_url, connect_timeout=5, autocommit=True) as connection:
            existing = connection.execute(
                "SELECT count(*) FROM submissions WHERE question_version_id = %s::uuid",
                (assignment["questionId"],),
            ).fetchone()[0]
        if existing:
            raise RuntimeError("This assignment already has submissions; do not rerun a consumed one-attempt cohort")
        teacher = requests.get(f"{settings.base_url}/api/practice", headers=_headers(settings), cookies={"__Host-goblins_session": manifest["teacher"]["token"]}, timeout=20)
        if teacher.status_code != 200 or not any(item.get("id") == assignment["assignmentVersionId"] for item in teacher.json().get("assignments", [])):
            raise RuntimeError("The application does not expose the expected assignment to its teacher session")
    return manifest, students, assignment, {"cloud_run": cloud, "readiness": ready, "queue_before": queue}


def _db_stage_results(settings: Settings, cohort: Cohort, assignment: dict[str, str], expected_students: list[dict[str, Any]]) -> dict[str, Any]:
    with psycopg.connect(settings.database_url, connect_timeout=10, autocommit=True) as connection:
        rows = connection.execute(
            "SELECT s.id::text, s.student_id::text, s.status::text, s.attempts, s.failure_code, s.source->>'type', "
            "s.created_at, s.updated_at, g.submission_id::text, g.approved_by::text, g.approved_at, "
            "s.source, s.latest_run_id::text, r.state, r.failure_code "
            "FROM submissions s LEFT JOIN grades g ON g.submission_id = s.id "
            "LEFT JOIN grading_runs r ON r.id = s.latest_run_id "
            "WHERE s.assignment_version_id = %s::uuid AND s.question_version_id = %s::uuid",
            (assignment["assignmentVersionId"], assignment["questionId"]),
        ).fetchall()
        duplicates = connection.execute(
            "SELECT count(*) FROM (SELECT g.submission_id FROM grades g JOIN submissions s ON s.id = g.submission_id "
            "WHERE s.assignment_version_id = %s::uuid GROUP BY g.submission_id HAVING count(*) > 1) duplicate_grades",
            (assignment["assignmentVersionId"],),
        ).fetchone()[0]
        invalid_finalized = connection.execute(
            "SELECT count(*) FROM submissions s JOIN classes c ON c.id = s.class_id "
            "LEFT JOIN grades g ON g.submission_id = s.id WHERE s.assignment_version_id = %s::uuid "
            "AND s.status = 'finalized' AND (g.approved_at IS NULL OR g.approved_by IS DISTINCT FROM c.teacher_id)",
            (assignment["assignmentVersionId"],),
        ).fetchone()[0]
        approved_finalized = connection.execute(
            "SELECT count(*) FROM submissions s JOIN classes c ON c.id = s.class_id "
            "JOIN grades g ON g.submission_id = s.id WHERE s.assignment_version_id = %s::uuid "
            "AND s.status = 'finalized' AND g.approved_at IS NOT NULL AND g.approved_by = c.teacher_id",
            (assignment["assignmentVersionId"],),
        ).fetchone()[0]
        image_count = connection.execute(
            "SELECT count(*) FROM submissions WHERE assignment_version_id = %s::uuid AND source->>'type' = 'image'",
            (assignment["assignmentVersionId"],),
        ).fetchone()[0]
    records = [
        {
            "id": row[0], "student_id": row[1], "status": row[2], "attempts": int(row[3]),
            "failure_code": row[4], "source_type": row[5], "created_at": row[6], "updated_at": row[7],
            "has_grade": row[8] is not None, "approved_by": row[9], "approved_at": row[10],
            "source": row[11], "latest_run_id": row[12], "latest_run_state": row[13], "latest_run_failure_code": row[14],
        }
        for row in rows
    ]
    status_counts: dict[str, int] = {}
    for record in records:
        status_counts[record["status"]] = status_counts.get(record["status"], 0) + 1
    expected_ids = {student["id"] for student in expected_students}
    observed_ids = {record["student_id"] for record in records}
    grade_count = sum(record["has_grade"] for record in records)
    terminal = {"waiting_for_teacher", "permanent_failure", "finalized"}
    nonterminal_count = sum(record["status"] not in terminal for record in records)
    max_submission_span = 0.0
    if records:
        first = min(record["created_at"] for record in records)
        last = max(record["updated_at"] for record in records)
        max_submission_span = max(0.0, (last - first).total_seconds())
    result = {
        "expected_students": cohort.students,
        "submission_count": len(records),
        "unique_submitting_students": len(observed_ids),
        "missing_student_count": len(expected_ids - observed_ids),
        "unexpected_student_count": len(observed_ids - expected_ids),
        "status_counts": status_counts,
        "grade_count": grade_count,
        "duplicate_grade_rows": int(duplicates),
        "invalid_finalized_without_teacher_approval": int(invalid_finalized),
        "approved_finalized_count": int(approved_finalized),
        "finalized_count": status_counts.get("finalized", 0),
        "nonterminal_submission_count": nonterminal_count,
        "retry_attempt_submissions": sum(record["attempts"] > 1 for record in records),
        "recovered_after_retry_count": sum(record["status"] == "waiting_for_teacher" and record["attempts"] > 1 and record["latest_run_state"] == "completed" for record in records),
        "image_submission_count": int(image_count),
        "permanent_failure_count": status_counts.get("permanent_failure", 0),
        "graded_waiting_for_teacher_count": status_counts.get("waiting_for_teacher", 0),
        "grading_span_seconds": round(max_submission_span, 3),
        "_records": records,
    }
    return result


def _keepalive_during_provider_wait(path: Path) -> bool:
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    sample = json.loads(line)
                except json.JSONDecodeError:
                    continue
                waiting = int(sample.get("worker_waiting_ocr") or 0) + int(sample.get("worker_waiting_grading") or 0)
                if (
                    int(sample.get("worker_active_jobs") or 0) > 0
                    and waiting > 0
                    and int(sample.get("worker_fresh_heartbeats") or 0) > 0
                    and int(sample.get("worker_ready_heartbeats") or 0) > 0
                    and int(sample.get("worker_probe_loops_running") or 0) > 0
                ):
                    return True
    except OSError:
        return False
    return False


def _manual_grade_timeout_failures(settings: Settings, manifest: dict[str, Any], students: list[dict[str, Any]], assignment: dict[str, str], failed_result: dict[str, Any]) -> dict[str, Any]:
    failed = [
        record for record in failed_result["_records"]
        if record["status"] == "permanent_failure" and record["failure_code"] == "grading_hard_cutoff"
    ]
    if not failed:
        return {"passed": False, "hard_cutoff_failure_count": 0}
    with psycopg.connect(settings.database_url, connect_timeout=10, autocommit=True) as connection:
        criteria = connection.execute(
            "SELECT r.criteria FROM submissions s JOIN rubric_versions r ON r.question_version_id = s.question_version_id "
            "WHERE s.id = %s::uuid", (failed[0]["id"],),
        ).fetchone()
    if not criteria or not isinstance(criteria[0], list) or not criteria[0]:
        raise RuntimeError("Timeout/manual-grade cohort rubric criteria were unavailable")
    input_data = {
        "scores": [{"criterionId": criterion["id"], "score": 0} for criterion in criteria[0]],
        "feedback": "The automated grader reached its hard cutoff; this synthetic submission was manually reviewed.",
        "reason": "Load-test hard-cutoff manual recovery validation.",
    }
    teacher_cookies = {"__Host-goblins_session": manifest["teacher"]["token"]}
    accepted = 0
    for record in failed:
        response = requests.post(
            f"{settings.base_url}/api/submissions/{record['id']}/manual-grade",
            json=input_data, headers={"Origin": settings.base_url}, cookies=teacher_cookies, timeout=30,
        )
        if response.status_code == 200 and response.json().get("revision") == 1:
            accepted += 1

    with psycopg.connect(settings.database_url, connect_timeout=10, autocommit=True) as connection:
        rows = connection.execute(
            "SELECT s.id::text, s.status::text, s.failure_code, s.source, s.latest_run_id::text, "
            "r.state, r.failure_code, g.approved_by::text, g.approved_at, g.review_revision, "
            "o.kind, o.teacher_id::text, o.reason, o.previous_result, o.result "
            "FROM submissions s LEFT JOIN grading_runs r ON r.id = s.latest_run_id "
            "LEFT JOIN grades g ON g.submission_id = s.id "
            "LEFT JOIN teacher_overrides o ON o.submission_id = s.id AND o.revision = 1 "
            "WHERE s.id = ANY(%s::uuid[])", ([record["id"] for record in failed],),
        ).fetchall()
    saved_by_id = {row[0]: row for row in rows}
    preserved = 0
    for record in failed:
        row = saved_by_id.get(record["id"])
        if row and (
            row[1] == "waiting_for_teacher"
            and row[2] == record["failure_code"]
            and row[3] == record["source"]
            and row[4] == record["latest_run_id"]
            and row[5] == "failed"
            and row[6] == record["failure_code"]
            and row[7] is None and row[8] is None and row[9] == 1
            and row[10] == "manual_grade"
            and row[11] == manifest["teacher"]["id"]
            and row[12] == input_data["reason"]
            and row[13] is None and row[14] is not None
        ):
            preserved += 1

    teacher_response = requests.get(
        f"{settings.base_url}/api/practice", cookies=teacher_cookies, timeout=30,
    )
    teacher_rows = teacher_response.json().get("submissions", []) if teacher_response.status_code == 200 else []
    teacher_by_id = {
        item.get("id"): item for item in teacher_rows
        if isinstance(item, dict) and item.get("id") in {record["id"] for record in failed}
    }
    teacher_history_visible = len(teacher_by_id) == len(failed) and all(
        (item := teacher_by_id.get(record["id"])) is not None
        and item.get("status") == "waiting_for_teacher"
        and item.get("failureCode") == "grading_hard_cutoff"
        and item.get("source") == record["source"]
        and item.get("reviewRevision") == 1
        and item.get("originalGrade") is None
        and (item.get("draftGrade") or {}).get("provider") == "teacher"
        and any(
            entry.get("type") == "manual_grade"
            and entry.get("teacherName") == "Isolated Load Test Teacher"
            and entry.get("reason") == input_data["reason"]
            and entry.get("previousResult") is None
            for entry in item.get("overrideHistory", [])
            if isinstance(entry, dict)
        )
        for record in failed
    )

    student_by_id = {student["id"]: student for student in students}
    def student_grade_hidden(record: dict[str, Any]) -> bool:
        student = student_by_id.get(record["student_id"])
        if not student:
            return False
        response = requests.get(
            f"{settings.base_url}/api/practice",
            cookies={"__Host-goblins_session": student["token"]}, timeout=20,
        )
        if response.status_code != 200:
            return False
        matches = [item for item in response.json().get("submissions", []) if item.get("id") == record["id"]]
        return len(matches) == 1 and matches[0].get("status") == "waiting_for_teacher" and all(
            matches[0].get(field) is None for field in ("originalGrade", "draftGrade", "finalGrade")
        ) and matches[0].get("overrideHistory") == []

    with ThreadPoolExecutor(max_workers=min(20, len(failed))) as executor:
        hidden = sum(executor.map(student_grade_hidden, failed))
    approval_accepted = False
    final_visible = False
    if preserved == len(failed) and accepted == len(failed) and hidden == len(failed):
        sample = failed[0]
        approval_response = requests.post(
            f"{settings.base_url}/api/submissions/{sample['id']}/approve",
            json={"revision": 1}, headers={"Origin": settings.base_url}, cookies=teacher_cookies, timeout=20,
        )
        approval_accepted = approval_response.status_code == 200 and approval_response.json().get("approved") is True
        with psycopg.connect(settings.database_url, connect_timeout=10, autocommit=True) as connection:
            approved = connection.execute(
                "SELECT s.status::text, g.approved_by::text, g.approved_at IS NOT NULL "
                "FROM submissions s JOIN grades g ON g.submission_id = s.id WHERE s.id = %s::uuid",
                (sample["id"],),
            ).fetchone()
        student = student_by_id[sample["student_id"]]
        student_response = requests.get(
            f"{settings.base_url}/api/practice",
            cookies={"__Host-goblins_session": student["token"]}, timeout=20,
        )
        after = [item for item in student_response.json().get("submissions", []) if item.get("id") == sample["id"]] if student_response.status_code == 200 else []
        final_visible = bool(
            approved and approved[0] == "finalized" and approved[1] == manifest["teacher"]["id"] and approved[2]
            and len(after) == 1 and after[0].get("status") == "finalized" and after[0].get("finalGrade") is not None
        )
    return {
        "passed": accepted == len(failed) and preserved == len(failed) and teacher_history_visible and hidden == len(failed) and approval_accepted and final_visible,
        "hard_cutoff_failure_count": len(failed),
        "manual_grade_requests_accepted": accepted,
        "failure_records_preserved": preserved,
        "teacher_view_shows_manual_grade_audit": teacher_history_visible,
        "unapproved_manual_grades_hidden_from_students": hidden,
        "teacher_approval_request_accepted": approval_accepted,
        "approved_manual_grade_visible_after_refresh": final_visible,
    }


def _verify_views(settings: Settings, manifest: dict[str, Any], students: list[dict[str, Any]], assignment: dict[str, str], db_result: dict[str, Any]) -> dict[str, Any]:
    assignment_id = assignment["assignmentVersionId"]
    question_id = assignment["questionId"]
    db_by_student = {row["student_id"]: row for row in db_result["_records"]}
    teacher_cookies = {"__Host-goblins_session": manifest["teacher"]["token"]}
    teacher_response = requests.get(f"{settings.base_url}/api/practice", cookies=teacher_cookies, timeout=30)
    if teacher_response.status_code != 200:
        raise RuntimeError(f"Teacher post-drain view returned HTTP {teacher_response.status_code}")
    teacher_view = teacher_response.json()
    teacher_submissions = [
        item for item in teacher_view.get("submissions", [])
        if item.get("assignmentVersionId") == assignment_id and item.get("questionVersionId") == question_id
    ]
    teacher_by_student = {item.get("studentId"): item for item in teacher_submissions}
    teacher_agreement = len(teacher_by_student) == len(db_by_student) and all(
        student_id in teacher_by_student
        and teacher_by_student[student_id].get("id") == row["id"]
        and teacher_by_student[student_id].get("status") == row["status"]
        for student_id, row in db_by_student.items()
    )

    def check_student(student: dict[str, Any]) -> tuple[bool, bool]:
        try:
            response = requests.get(
                f"{settings.base_url}/api/practice",
                cookies={"__Host-goblins_session": student["token"]},
                timeout=20,
            )
            if response.status_code != 200:
                return False, False
            view = response.json()
            own_items = view.get("submissions", [])
            if not isinstance(own_items, list):
                return False, False
            privacy_ok = all(
                item.get("studentId") == student["id"]
                and item.get("originalGrade") is None
                and item.get("draftGrade") is None
                and item.get("overrideHistory") in (None, [])
                and (item.get("status") == "finalized" or item.get("finalGrade") is None)
                for item in own_items if isinstance(item, dict)
            ) and all(isinstance(item, dict) for item in own_items)
            current = [item for item in own_items if item.get("assignmentVersionId") == assignment_id and item.get("questionVersionId") == question_id]
            expected = db_by_student.get(student["id"])
            agree = (not current and expected is None) or (
                len(current) == 1 and expected is not None
                and current[0].get("id") == expected["id"] and current[0].get("status") == expected["status"]
            )
            return privacy_ok, agree
        except Exception:
            return False, False

    image_records = [record for record in db_result["_records"] if record["source_type"] == "image"]
    image_access = {"student_owner_can_read": None, "different_student_denied": None, "teacher_can_read": None}
    if image_records:
        sample = image_records[0]
        owner = next((student for student in students if student["id"] == sample["student_id"]), None)
        other = next((student for student in manifest["students"] if student["id"] != sample["student_id"]), None)
        if owner and other:
            owner_response = requests.get(
                f"{settings.base_url}/api/submissions/{sample['id']}/image",
                cookies={"__Host-goblins_session": owner["token"]}, timeout=20,
            )
            foreign_response = requests.get(
                f"{settings.base_url}/api/submissions/{sample['id']}/image",
                cookies={"__Host-goblins_session": other["token"]}, timeout=20,
            )
            teacher_image_response = requests.get(
                f"{settings.base_url}/api/submissions/{sample['id']}/image",
                cookies=teacher_cookies, timeout=20,
            )
            image_access = {
                "student_owner_can_read": owner_response.status_code == 200 and owner_response.headers.get("content-type", "").startswith("image/png"),
                "different_student_denied": foreign_response.status_code == 403,
                "teacher_can_read": teacher_image_response.status_code == 200 and teacher_image_response.headers.get("content-type", "").startswith("image/png"),
            }

    privacy_ok_count = 0
    student_agreement_count = 0
    with ThreadPoolExecutor(max_workers=50) as executor:
        futures = [executor.submit(check_student, student) for student in students]
        for future in as_completed(futures):
            privacy_ok, agrees = future.result()
            privacy_ok_count += int(privacy_ok)
            student_agreement_count += int(agrees)
    return {
        "teacher_view_agrees_with_database": teacher_agreement,
        "teacher_view_submission_count": len(teacher_submissions),
        "student_view_checks": len(students),
        "student_privacy_checks_passed": privacy_ok_count,
        "student_views_agree_with_teacher_and_database": student_agreement_count,
        "image_access": image_access,
    }


def _release_approval_smoke(settings: Settings, manifest: dict[str, Any], students: list[dict[str, Any]], db_result: dict[str, Any]) -> dict[str, Any]:
    records = db_result["_records"]
    if len(records) != 1 or records[0]["status"] != "waiting_for_teacher" or not records[0]["has_grade"]:
        return {"passed": False, "reason": "approval test did not start with one unapproved completed grade"}
    record = records[0]
    student = students[0]
    before = requests.get(
        f"{settings.base_url}/api/practice",
        cookies={"__Host-goblins_session": student["token"]},
        timeout=20,
    )
    if before.status_code != 200:
        return {"passed": False, "reason": f"student pre-approval refresh returned HTTP {before.status_code}"}
    before_rows = [item for item in before.json().get("submissions", []) if item.get("id") == record["id"]]
    if len(before_rows) != 1 or before_rows[0].get("finalGrade") is not None:
        return {"passed": False, "reason": "student could see a final grade before teacher approval"}
    with psycopg.connect(settings.database_url, connect_timeout=10, autocommit=True) as connection:
        revision = connection.execute(
            "SELECT review_revision FROM grades WHERE submission_id = %s::uuid", (record["id"],)
        ).fetchone()[0]
    response = requests.post(
        f"{settings.base_url}/api/submissions/{record['id']}/approve",
        json={"revision": int(revision)},
        headers={"Origin": settings.base_url},
        cookies={"__Host-goblins_session": manifest["teacher"]["token"]},
        timeout=20,
    )
    if response.status_code != 200 or response.json().get("approved") is not True:
        return {"passed": False, "reason": f"teacher approval request returned HTTP {response.status_code}"}
    with psycopg.connect(settings.database_url, connect_timeout=10, autocommit=True) as connection:
        approved = connection.execute(
            "SELECT s.status::text, g.approved_by::text, g.approved_at IS NOT NULL "
            "FROM submissions s JOIN grades g ON g.submission_id = s.id WHERE s.id = %s::uuid",
            (record["id"],),
        ).fetchone()
    after = requests.get(
        f"{settings.base_url}/api/practice",
        cookies={"__Host-goblins_session": student["token"]},
        timeout=20,
    )
    after_rows = [item for item in after.json().get("submissions", []) if item.get("id") == record["id"]] if after.status_code == 200 else []
    approved_by_teacher = bool(approved and approved[0] == "finalized" and approved[1] == manifest["teacher"]["id"] and approved[2])
    visible_after_refresh = len(after_rows) == 1 and after_rows[0].get("status") == "finalized" and after_rows[0].get("finalGrade") is not None
    return {
        "passed": approved_by_teacher and visible_after_refresh,
        "teacher_approval_request_accepted": response.status_code == 200,
        "approval_recorded_for_class_teacher": approved_by_teacher,
        "student_grade_hidden_before_approval": True,
        "student_grade_visible_after_refresh": visible_after_refresh,
    }


def _cloud_run_instance_samples(path: Path) -> list[int]:
    samples = []
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    value = json.loads(line).get("cloud_run_instance_count")
                except json.JSONDecodeError:
                    continue
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    samples.append(int(value))
    except OSError:
        pass
    return samples


def _correctness_checks(cohort: Cohort, counters: dict[str, Any], db_result: dict[str, Any], views: dict[str, Any], drained: bool, storage_reads: int, approval_result: dict[str, Any] | None, cloud_instance_samples: list[int], timeout_run_result: dict[str, Any] | None, manual_override_result: dict[str, Any] | None) -> dict[str, bool]:
    status_counts = db_result["status_counts"]
    checks = {
        "queue_drained": drained,
        "all_expected_submissions_recorded_once": (
            db_result["submission_count"] == cohort.students
            and db_result["unique_submitting_students"] == cohort.students
            and db_result["missing_student_count"] == 0
            and db_result["unexpected_student_count"] == 0
        ),
        "all_submissions_terminal": db_result["nonterminal_submission_count"] == 0,
        "grade_rows_unique": db_result["duplicate_grade_rows"] == 0,
        "every_successfully_graded_submission_has_one_grade": db_result["grade_count"] == db_result["graded_waiting_for_teacher_count"] + status_counts.get("finalized", 0),
        "no_grade_finalized_without_explicit_teacher_approval": db_result["invalid_finalized_without_teacher_approval"] == 0,
        "no_grade_released_in_this_unapproved_load_run": cohort.plan in {"approval", "timeout_manual"} or db_result["finalized_count"] == 0,
        "all_student_assignment_views_loaded": counters.get("student_assignment_views_ok", 0) == cohort.students,
        "all_students_attempted_once": counters.get("submission_attempts", 0) == cohort.students,
        "all_submission_requests_accepted": counters.get("submission_accepted", 0) == cohort.students,
        "student_privacy_checks_passed_during_load": counters.get("student_privacy_checks_failed", 0) == 0,
        "private_storage_image_readbacks_passed": storage_reads == db_result["image_submission_count"] and counters.get("image_uploads_accepted", 0) == db_result["image_submission_count"],
        "teacher_and_student_views_match_database_after_refresh": (
            views["teacher_view_agrees_with_database"]
            and views["student_privacy_checks_passed"] == cohort.students
            and views["student_views_agree_with_teacher_and_database"] == cohort.students
        ),
        "cross_student_private_image_access_is_denied": views["image_access"]["different_student_denied"] is True,
        "owner_and_teacher_can_read_private_canvas_image": views["image_access"]["student_owner_can_read"] is True and views["image_access"]["teacher_can_read"] is True,
    }
    if cohort.plan == "approval":
        checks["explicit_teacher_approval_releases_final_grade"] = bool(approval_result and approval_result.get("passed") and db_result["approved_finalized_count"] == 1)
    else:
        checks["actual_cloud_run_worker_instance_count_observed"] = any(count > 0 for count in cloud_instance_samples)
    if cohort.plan == "timeout_manual":
        checks["hard_cutoff_failed_hung_provider_jobs_before_provider_timeout"] = bool(
            timeout_run_result and timeout_run_result.get("hard_cutoff_failure_count", 0) > 0
            and timeout_run_result.get("all_failure_codes_are_hard_cutoff")
            and timeout_run_result.get("successful_automatic_grades", 0) > 0
        )
        checks["worker_keepalive_remained_ready_during_provider_hang"] = bool(timeout_run_result and timeout_run_result.get("keepalive_during_provider_wait"))
        checks["manual_override_preserved_failure_and_required_teacher_approval"] = bool(
            manual_override_result and manual_override_result.get("passed")
            and db_result["permanent_failure_count"] == 0
            and db_result["approved_finalized_count"] == 1
        )
    if cohort.failure_mode == "none":
        checks["no_injected_failure_run_completed_without_terminal_failures"] = db_result["permanent_failure_count"] == 0
    elif cohort.failure_mode == "transient":
        checks["transient_failures_recovered_by_retry"] = db_result["recovered_after_retry_count"] > 0 and db_result["permanent_failure_count"] == 0
    elif cohort.failure_mode == "permanent":
        checks["permanent_failure_injection_observed"] = db_result["permanent_failure_count"] > 0
    elif cohort.failure_mode == "timeout":
        checks["timeout_failure_mode_completed_manual_recovery"] = bool(manual_override_result and manual_override_result.get("passed"))
    return checks


def _artifact_run_id(cohort: Cohort) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    suffix = uuid.uuid4().hex[:8]
    return f"{timestamp}_{cohort.id}_{suffix}"


def run_cohort(settings: Settings, cohort: Cohort) -> tuple[Path, bool]:
    manifest, students, assignment, preflight = _preflight(settings, cohort)
    run_dir = settings.artifact_dir / _artifact_run_id(cohort)
    run_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    counters_path = run_dir / "locust_counters.json"
    sampling_path = run_dir / "metrics.jsonl"
    locust_prefix = run_dir / "locust"
    safe_config = {
        "run_id": run_dir.name,
        "cohort": cohort.__dict__,
        "target": {"web_service": settings.web_service, "worker_service": settings.worker_service, "project_id": settings.project_id, "region": settings.region, "base_url": settings.base_url},
        "database_host": settings.database_host,
        "storage_bucket": settings.storage_bucket,
        "worker_concurrency": settings.worker_concurrency,
        "image_fraction": settings.image_fraction,
        "preflight": preflight,
        "started_at": utc_iso(),
    }
    write_json(run_dir / "run_config.json", safe_config)
    sampler = MetricsSampler(settings, cohort, assignment["assignmentVersionId"], sampling_path)
    sampler.start()
    sampler.set_phase("ramp_and_sustain")
    spawn_rate = cohort.students / cohort.ramp_seconds
    command = [
        sys.executable, "-m", "locust", "--headless", "-f", str(LOAD_DIR / "locustfile.py"),
        "--host", settings.base_url, "--users", str(cohort.students + 1),
        "--spawn-rate", f"{spawn_rate:.6f}", "--run-time", f"{cohort.run_seconds}s",
        "--stop-timeout", "30", "--csv", str(locust_prefix), "--csv-full-history", "--loglevel", "WARNING",
    ]
    environment = os.environ.copy()
    environment["LOADTEST_COHORT"] = cohort.id
    environment["LOADTEST_MANIFEST_PATH"] = str(settings.manifest_path)
    environment["LOADTEST_COUNTERS_PATH"] = str(counters_path)
    started = time.monotonic()
    try:
        with (run_dir / "locust.log").open("w", encoding="utf-8") as log:
            locust_result = subprocess.run(command, cwd=LOAD_DIR.parents[1], env=environment, stdout=log, stderr=subprocess.STDOUT, check=False)
    except Exception as exc:
        locust_result = None
        write_json(run_dir / "execution_error.json", {"error_type": type(exc).__name__})
    locust_elapsed = time.monotonic() - started

    sampler.set_phase("queue_drain")
    drain_started = time.monotonic()
    drained = False
    last_queue = None
    last_assignment = None
    while time.monotonic() - drain_started < settings.max_drain_seconds:
        try:
            last_queue = queue_snapshot(settings.database_url)
            last_assignment = assignment_snapshot(settings.database_url, assignment["assignmentVersionId"])
            if last_queue["queue_depth"] == 0 and last_assignment["assignment_nonterminal"] == 0:
                drained = True
                break
        except Exception:
            pass
        time.sleep(5)
    drain_seconds = time.monotonic() - drain_started
    sampler.set_phase("verification")

    counters: dict[str, Any] = {}
    approval_result = None
    db_result: dict[str, Any] = {}
    views: dict[str, Any] = {}
    checks: dict[str, bool] = {}
    timeout_run_result = None
    manual_override_result = None
    verification_error = None
    try:
        try:
            counters = json.loads(counters_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            counters = {}
        db_result = _db_stage_results(settings, cohort, assignment, students)
        if cohort.plan == "timeout_manual":
            permanent = [record for record in db_result["_records"] if record["status"] == "permanent_failure"]
            hard_cutoff = [record for record in permanent if record["failure_code"] == "grading_hard_cutoff"]
            timeout_run_result = {
                "hard_cutoff_failure_count": len(hard_cutoff),
                "all_failure_codes_are_hard_cutoff": bool(permanent) and len(hard_cutoff) == len(permanent) and all(
                    record["latest_run_state"] == "failed" and record["latest_run_failure_code"] == "grading_hard_cutoff"
                    for record in hard_cutoff
                ),
                "successful_automatic_grades": db_result["graded_waiting_for_teacher_count"],
                "keepalive_during_provider_wait": _keepalive_during_provider_wait(sampling_path),
            }
            manual_override_result = _manual_grade_timeout_failures(settings, manifest, students, assignment, db_result)
            db_result = _db_stage_results(settings, cohort, assignment, students)
        if cohort.plan == "approval":
            before_views = _verify_views(settings, manifest, students, assignment, db_result)
            approval_result = _release_approval_smoke(settings, manifest, students, db_result)
            before_checks_passed = (
                before_views["teacher_view_agrees_with_database"]
                and before_views["student_privacy_checks_passed"] == cohort.students
                and before_views["student_views_agree_with_teacher_and_database"] == cohort.students
            )
            approval_result["all_students_verified_before_approval"] = before_checks_passed
            approval_result["passed"] = bool(approval_result.get("passed") and before_checks_passed)
            db_result = _db_stage_results(settings, cohort, assignment, students)
        views = _verify_views(settings, manifest, students, assignment, db_result)
        storage_reads = int(counters.get("image_readbacks_ok", 0))
        cloud_instance_samples = _cloud_run_instance_samples(sampling_path)
        checks = _correctness_checks(cohort, counters, db_result, views, drained, storage_reads, approval_result, cloud_instance_samples, timeout_run_result, manual_override_result)
    except Exception as exc:
        verification_error = type(exc).__name__
    finally:
        try:
            final_queue = queue_snapshot(settings.database_url)
        except Exception as exc:
            final_queue = None
            final_queue_error = type(exc).__name__
        else:
            final_queue_error = None
        sampler.stop()
    checks["final_queue_snapshot_available"] = final_queue is not None

    clean_db_result = {key: value for key, value in db_result.items() if key != "_records"}
    summary = {
        "run_id": run_dir.name,
        "cohort": cohort.__dict__,
        "target": safe_config["target"],
        "database_host": settings.database_host,
        "storage_bucket": settings.storage_bucket,
        "configured_worker_concurrency": settings.worker_concurrency,
        "cloud_run_worker_instances_configured": cohort.worker_instances,
        "preflight": preflight,
        "locust_exit_code": locust_result.returncode if locust_result else None,
        "locust_elapsed_seconds": round(locust_elapsed, 3),
        "drain_seconds": round(drain_seconds, 3),
        "queue_drained": drained,
        "queue_after_run": final_queue,
        "final_queue_snapshot_error": final_queue_error,
        "post_load_verification_error": verification_error,
        "cloud_run_worker_instance_count_samples": _cloud_run_instance_samples(sampling_path),
        "cloud_run_worker_instances_observed_peak": max(_cloud_run_instance_samples(sampling_path), default=None),
        "locust_counters": counters,
        "database_results": clean_db_result,
        "views": views,
        "approval_smoke": approval_result,
        "timeout_run": timeout_run_result,
        "manual_override": manual_override_result,
        "correctness_checks": checks,
        "correctness_passed": verification_error is None and all(checks.values()) and locust_result is not None and locust_result.returncode == 0,
        "metrics_sampling_errors": sampler.errors(),
        "completed_at": utc_iso(),
    }
    write_json(run_dir / "summary.json", summary)
    report = subprocess.run(
        [sys.executable, str(REPORT_SCRIPT), "--run-dir", str(run_dir)],
        cwd=LOAD_DIR.parents[1], capture_output=True, text=True, check=False,
    )
    if report.returncode != 0:
        write_json(run_dir / "report_error.json", {"exit_code": report.returncode, "stderr": report.stderr[-2000:]})
    print(f"Run: {run_dir}")
    print(f"Correctness: {'PASS' if summary['correctness_passed'] else 'FAIL'}; queue drained: {drained}; submissions: {db_result.get('submission_count', 0)}/{cohort.students}")
    if report.returncode != 0:
        print("Report generation failed; inspect the non-sensitive report_error.json and install tests/load/requirements.txt.")
    return run_dir, bool(summary["correctness_passed"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--cohort", help="Run one named cohort from cohorts.json")
    group.add_argument("--plan", choices=("approval", "scale"), help="Run the named cohorts sequentially; config is verified before every run")
    parser.add_argument("--preflight-only", action="store_true", help="Verify isolation, Cloud Run configuration, and readiness without generating load")
    args = parser.parse_args()
    try:
        settings = load_settings()
        cohorts, plans, _, _ = load_cohort_data(settings.cohorts_path)
        cohort_ids = [args.cohort] if args.cohort else plans[args.plan]
        if any(cohort_id not in cohorts for cohort_id in cohort_ids):
            raise LoadTestConfigError("Unknown cohort in the selected plan")
        if args.preflight_only:
            for cohort_id in cohort_ids:
                cohort = cohorts[cohort_id]
                _, _, _, info = _preflight(settings, cohort, require_manifest=False)
                print(f"Preflight PASS for {cohort_id}: {json.dumps(info, sort_keys=True)}")
            return 0
        results = []
        for cohort_id in cohort_ids:
            run_dir, passed = run_cohort(settings, cohorts[cohort_id])
            results.append({"run": str(run_dir), "passed": passed})
            if not passed:
                print("Stopping the plan at the first failed cohort; fix isolation/configuration or investigate before continuing.")
                break
        print(json.dumps({"results": results}, indent=2))
        return 0 if results and all(item["passed"] for item in results) else 1
    except (LoadTestConfigError, RuntimeError) as exc:
        print(f"Load test refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
