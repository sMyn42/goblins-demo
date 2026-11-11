"""Fail-closed configuration for the isolated Goblins Cloud Run load test.

This module deliberately does not load dotenv files or fall back to application
DATABASE_URL, Supabase, or production service configuration.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from typing import Mapping
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
LOAD_DIR = Path(__file__).resolve().parent
COHORTS_PATH = LOAD_DIR / "cohorts.json"
CONFIRMATION = "I_CONFIRMED_SEPARATE_LOADTEST_INFRASTRUCTURE"


class LoadTestConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Cohort:
    id: str
    plan: str
    students: int
    offset: int
    ramp_seconds: int
    sustain_seconds: int
    worker_instances: int
    worker_lease_seconds: int
    ocr_timeout_ms: int
    grading_timeout_ms: int
    failure_mode: str
    failure_rate: float

    @property
    def run_seconds(self) -> int:
        return self.ramp_seconds + self.sustain_seconds


@dataclass(frozen=True)
class Settings:
    environment: str
    project_id: str
    region: str
    web_service: str
    worker_service: str
    base_url: str
    database_url: str
    database_host: str
    database_secret_name: str
    supabase_url: str
    production_supabase_url: str
    storage_bucket: str
    production_storage_bucket: str
    storage_secret_name: str
    monitor_secret_name: str
    worker_monitor_token: str
    worker_concurrency: int
    manifest_path: Path
    artifact_dir: Path
    state_dir: Path
    sample_interval_seconds: int
    max_drain_seconds: int
    image_fraction: float
    cohorts_path: Path


def _required(env: Mapping[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise LoadTestConfigError(f"Required isolated-load-test setting is missing: {key}")
    return value


def _positive_int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise LoadTestConfigError(f"{key} must be a positive integer") from exc
    if value < 1:
        raise LoadTestConfigError(f"{key} must be a positive integer")
    return value


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    values = os.environ if env is None else env
    if _required(values, "LOADTEST_ENVIRONMENT") != "isolated":
        raise LoadTestConfigError("LOADTEST_ENVIRONMENT must be exactly 'isolated'")
    if _required(values, "LOADTEST_CONFIRM_ISOLATED") != CONFIRMATION:
        raise LoadTestConfigError("Explicit confirmation of separate test infrastructure is required")

    database_url = _required(values, "LOADTEST_DATABASE_URL")
    parsed_db = urlsplit(database_url)
    if parsed_db.scheme not in {"postgres", "postgresql"} or not parsed_db.hostname:
        raise LoadTestConfigError("LOADTEST_DATABASE_URL must be a PostgreSQL URL")
    database_host = parsed_db.hostname.lower().rstrip(".")
    expected_db_host = _required(values, "LOADTEST_EXPECTED_DATABASE_HOST").lower().rstrip(".")
    production_db_host = _required(values, "LOADTEST_PRODUCTION_DATABASE_HOST").lower().rstrip(".")
    if database_host != expected_db_host:
        raise LoadTestConfigError("LOADTEST_DATABASE_URL host does not match LOADTEST_EXPECTED_DATABASE_HOST")
    if database_host == production_db_host:
        raise LoadTestConfigError("The load-test database host must differ from the production database host")
    if database_host in {"localhost", "127.0.0.1", "::1"} or database_host.endswith(".local"):
        raise LoadTestConfigError("The load test requires the isolated hosted database, not a local database")

    supabase_url = _https_origin(_required(values, "LOADTEST_SUPABASE_URL"), "LOADTEST_SUPABASE_URL")
    production_supabase_url = _https_origin(_required(values, "LOADTEST_PRODUCTION_SUPABASE_URL"), "LOADTEST_PRODUCTION_SUPABASE_URL")
    if supabase_url == production_supabase_url:
        raise LoadTestConfigError("The load-test Supabase project must differ from production")
    storage_bucket = _required(values, "LOADTEST_STORAGE_BUCKET")
    production_bucket = _required(values, "LOADTEST_PRODUCTION_STORAGE_BUCKET")
    if storage_bucket == production_bucket or not re.search(r"load.?test|test", storage_bucket, re.IGNORECASE):
        raise LoadTestConfigError("Use a separate storage bucket whose name clearly identifies it as test-only")
    if not re.fullmatch(r"[a-z0-9-]+", storage_bucket):
        raise LoadTestConfigError("LOADTEST_STORAGE_BUCKET contains invalid characters")

    gcp_project = _required(values, "LOADTEST_GCP_PROJECT")
    production_gcp_project = _required(values, "LOADTEST_PRODUCTION_GCP_PROJECT")
    if gcp_project == production_gcp_project:
        raise LoadTestConfigError("The load-test GCP project must differ from the production GCP project")

    base_url = _https_origin(_required(values, "LOADTEST_BASE_URL"), "LOADTEST_BASE_URL")
    web_service = _required(values, "LOADTEST_WEB_SERVICE")
    worker_service = _required(values, "LOADTEST_WORKER_SERVICE")
    for key, service in (("LOADTEST_WEB_SERVICE", web_service), ("LOADTEST_WORKER_SERVICE", worker_service)):
        if not re.fullmatch(r"[a-z][a-z0-9-]{3,62}", service) or "loadtest" not in service.lower():
            raise LoadTestConfigError(f"{key} must be a dedicated service name containing 'loadtest'")

    token = _required(values, "LOADTEST_WORKER_MONITOR_TOKEN")
    if len(token) < 32:
        raise LoadTestConfigError("LOADTEST_WORKER_MONITOR_TOKEN must contain at least 32 characters")

    state_dir = Path(values.get("LOADTEST_STATE_DIR", str(LOAD_DIR / ".state"))).expanduser().resolve()
    artifact_dir = Path(values.get("LOADTEST_ARTIFACT_DIR", str(LOAD_DIR / "artifacts"))).expanduser().resolve()
    run_id = _required(values, "LOADTEST_RUN_ID")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", run_id):
        raise LoadTestConfigError("LOADTEST_RUN_ID must be a short alphanumeric identifier")
    manifest_path = Path(values.get("LOADTEST_MANIFEST_PATH", str(state_dir / f"{run_id}.json"))).expanduser().resolve()
    cohorts_path = Path(values.get("LOADTEST_COHORTS_PATH", str(COHORTS_PATH))).expanduser().resolve()
    worker_default = _read_default_worker_concurrency(cohorts_path)
    worker_concurrency = _positive_int(values, "LOADTEST_WORKER_CONCURRENCY", worker_default)
    if worker_concurrency != worker_default:
        raise LoadTestConfigError("LOADTEST_WORKER_CONCURRENCY must match the cohort definition")

    image_fraction_raw = values.get("LOADTEST_IMAGE_FRACTION", "")
    try:
        image_fraction = float(image_fraction_raw) if image_fraction_raw else _read_default_image_fraction(cohorts_path)
    except ValueError as exc:
        raise LoadTestConfigError("LOADTEST_IMAGE_FRACTION must be between 0 and 1") from exc
    if image_fraction != 1.0:
        raise LoadTestConfigError("Every load-test student must submit through the canvas-image path; image_fraction must be 1.0")

    return Settings(
        environment="isolated",
        project_id=gcp_project,
        region=_required(values, "LOADTEST_GCP_REGION"),
        web_service=web_service,
        worker_service=worker_service,
        base_url=base_url,
        database_url=database_url,
        database_host=database_host,
        database_secret_name=_required(values, "LOADTEST_DATABASE_SECRET_NAME"),
        supabase_url=supabase_url,
        production_supabase_url=production_supabase_url,
        storage_bucket=storage_bucket,
        production_storage_bucket=production_bucket,
        storage_secret_name=_required(values, "LOADTEST_STORAGE_SECRET_NAME"),
        monitor_secret_name=_required(values, "LOADTEST_MONITOR_SECRET_NAME"),
        worker_monitor_token=token,
        worker_concurrency=worker_concurrency,
        manifest_path=manifest_path,
        artifact_dir=artifact_dir,
        state_dir=state_dir,
        sample_interval_seconds=_positive_int(values, "LOADTEST_SAMPLE_INTERVAL_SECONDS", 5),
        max_drain_seconds=_positive_int(values, "LOADTEST_MAX_DRAIN_SECONDS", 1800),
        image_fraction=image_fraction,
        cohorts_path=cohorts_path,
    )


def _https_origin(raw: str, setting: str) -> str:
    try:
        parsed = urlsplit(raw)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError
        return f"https://{parsed.netloc}".rstrip("/")
    except ValueError as exc:
        raise LoadTestConfigError(f"{setting} must be an HTTPS origin without credentials or a path") from exc


def _read_default_worker_concurrency(path: Path) -> int:
    try:
        return int(json.loads(path.read_text(encoding="utf-8"))["worker_concurrency"])
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise LoadTestConfigError(f"Cannot read worker_concurrency from {path}") from exc


def _read_default_image_fraction(path: Path) -> float:
    try:
        return float(json.loads(path.read_text(encoding="utf-8"))["image_fraction"])
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise LoadTestConfigError(f"Cannot read image_fraction from {path}") from exc


def load_cohort_data(path: Path = COHORTS_PATH) -> tuple[dict[str, Cohort], dict[str, list[str]], int, int]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        account_count = int(raw["student_accounts"])
        worker_concurrency = int(raw["worker_concurrency"])
        cohorts = {
            item["id"]: Cohort(
                id=item["id"], plan=item["plan"], students=int(item["students"]), offset=int(item["offset"]),
                ramp_seconds=int(item["ramp_seconds"]), sustain_seconds=int(item["sustain_seconds"]),
                worker_instances=int(item["worker_instances"]),
                worker_lease_seconds=int(item.get("worker_lease_seconds", 120)),
                ocr_timeout_ms=int(item.get("ocr_timeout_ms", 15000)),
                grading_timeout_ms=int(item.get("grading_timeout_ms", 20000)),
                failure_mode=item["failure_mode"],
                failure_rate=float(item["failure_rate"]),
            )
            for item in raw["cohorts"]
        }
        plans = {key: list(value) for key, value in raw["plans"].items()}
        max_drain = int(raw["max_drain_seconds"])
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise LoadTestConfigError(f"Invalid load-test cohort file: {path}") from exc
    if account_count < 1 or worker_concurrency < 1 or max_drain < 1 or not cohorts:
        raise LoadTestConfigError("Cohort file must define positive account, concurrency, and drain limits")
    for cohort in cohorts.values():
        if (not cohort.id or cohort.students < 1 or cohort.offset < 0 or cohort.ramp_seconds < 1
                or cohort.sustain_seconds < 1 or cohort.worker_instances < 1
                or not 15 <= cohort.worker_lease_seconds <= 900
                or not 10 <= cohort.ocr_timeout_ms <= 600000
                or not 10 <= cohort.grading_timeout_ms <= 600000
                or cohort.failure_mode not in {"none", "transient", "permanent", "malformed", "timeout"}
                or not 0 <= cohort.failure_rate <= 1 or cohort.offset + cohort.students > account_count):
            raise LoadTestConfigError(f"Invalid cohort definition: {cohort.id}")
        if cohort.failure_mode == "timeout" and min(cohort.ocr_timeout_ms, cohort.grading_timeout_ms) <= cohort.worker_lease_seconds * 1000 - 5000:
            raise LoadTestConfigError(f"Timeout cohort {cohort.id} must put provider timeouts beyond the worker hard cutoff")
    for plan, ids in plans.items():
        if not ids or any(cohort_id not in cohorts or cohorts[cohort_id].plan != plan for cohort_id in ids):
            raise LoadTestConfigError(f"Invalid cohort plan: {plan}")
    return cohorts, plans, account_count, max_drain
