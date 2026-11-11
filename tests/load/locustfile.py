"""Authenticated student submission, progress polling, and teacher dashboard load."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import uuid

from gevent.queue import Empty, Queue
from locust import HttpUser, between, events, task

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import LoadTestConfigError, load_cohort_data, load_settings  # noqa: E402
from canvas_image import render_canvas_png  # noqa: E402


try:
    SETTINGS = load_settings()
    COHORTS, _, _, _ = load_cohort_data(SETTINGS.cohorts_path)
    COHORT_ID = os.environ["LOADTEST_COHORT"]
    COHORT = COHORTS[COHORT_ID]
    MANIFEST = json.loads(SETTINGS.manifest_path.read_text(encoding="utf-8"))
    ASSIGNMENT = MANIFEST["assignments"][COHORT_ID]
    STUDENTS = MANIFEST["students"][COHORT.offset:COHORT.offset + COHORT.students]
    if MANIFEST.get("version") != 1 or len(STUDENTS) != COHORT.students:
        raise LoadTestConfigError("The private manifest does not contain the selected unique student cohort")
    if len({student["id"] for student in STUDENTS}) != COHORT.students:
        raise LoadTestConfigError("The selected cohort must contain unique student accounts")
except Exception as exc:
    raise RuntimeError("Locust load-test configuration or private manifest is invalid; no credentials were logged") from exc

STUDENT_TOKENS: Queue = Queue()
for _student in STUDENTS:
    STUDENT_TOKENS.put(_student)

COUNTERS = {
    "student_users_started": 0,
    "student_assignment_views_ok": 0,
    "submission_attempts": 0,
    "submission_accepted": 0,
    "submission_rejected": 0,
    "student_poll_checks": 0,
    "student_privacy_checks_failed": 0,
    "image_uploads_accepted": 0,
    "image_readbacks_ok": 0,
    "teacher_dashboard_reads": 0,
    "teacher_api_reads": 0,
    "teacher_view_errors": 0,
    "students_without_a_token": 0,
}


def _increment(key: str, amount: int = 1) -> None:
    COUNTERS[key] += amount


def _cookie_name() -> str:
    # The Cloud Run app uses NODE_ENV=production and the __Host- cookie variant.
    return "__Host-goblins_session"


def _attach_session(user: HttpUser, token: str) -> None:
    from urllib.parse import urlsplit

    host = urlsplit(user.host or SETTINGS.base_url)
    user.client.cookies.set(_cookie_name(), token, domain=host.hostname, path="/", secure=host.scheme == "https")


def _origin() -> str:
    return SETTINGS.base_url


PNG_BYTES = render_canvas_png()


def _submission_list(data: object) -> list[dict]:
    if not isinstance(data, dict) or not isinstance(data.get("submissions"), list):
        return []
    return [item for item in data["submissions"] if isinstance(item, dict)]


def _student_privacy_ok(data: object, student_id: str) -> bool:
    items = _submission_list(data)
    for item in items:
        # Student API views are scoped to the authenticated principal and redact
        # teacher-only grades and audit history until explicit teacher approval.
        if item.get("studentId") != student_id:
            return False
        if item.get("originalGrade") is not None or item.get("draftGrade") is not None:
            return False
        if item.get("overrideHistory") not in (None, []):
            return False
    return True


def _assignment_is_visible(data: object) -> bool:
    return bool(
        isinstance(data, dict)
        and any(
            isinstance(assignment, dict)
            and assignment.get("id") == ASSIGNMENT["assignmentVersionId"]
            and any(
                isinstance(problem, dict) and problem.get("id") == ASSIGNMENT["questionId"]
                for problem in assignment.get("problems", [])
            )
            for assignment in data.get("assignments", [])
        )
    )


class StudentUser(HttpUser):
    wait_time = between(2, 5)
    abstract = False

    def on_start(self) -> None:
        self.student = None
        self.submission_id = None
        self.is_image = False
        self.image_readback_done = False
        try:
            self.student = STUDENT_TOKENS.get_nowait()
        except Empty:
            _increment("students_without_a_token")
            return
        _increment("student_users_started")
        _attach_session(self, self.student["token"])

        with self.client.get("/api/practice", name="GET /api/practice [student initial view]", catch_response=True) as response:
            if response.status_code != 200:
                response.failure(f"student assignment view returned HTTP {response.status_code}")
                return
            try:
                view = response.json()
            except ValueError:
                response.failure("student assignment view was not JSON")
                return
            if not _assignment_is_visible(view):
                response.failure("selected assignment/question was not visible to its enrolled student")
                return
            if not _student_privacy_ok(view, self.student["id"]):
                _increment("student_privacy_checks_failed")
                response.failure("student view exposed another student or teacher-only grade data")
                return
            response.success()
        _increment("student_assignment_views_ok")
        self._submit_once()

    def _submit_once(self) -> None:
        if not self.student:
            return
        index = int(self.student["index"])
        self.is_image = ((index * 0.61803398875) % 1.0) < SETTINGS.image_fraction
        form = {
            "questionId": ASSIGNMENT["questionId"],
            "idempotencyKey": str(uuid.uuid4()),
        }
        headers = {"Origin": _origin()}
        _increment("submission_attempts")
        if self.is_image:
            with self.client.post(
                "/api/submissions",
                data=form,
                files={"image": ("load-test.png", PNG_BYTES, "image/png")},
                headers=headers,
                name="POST /api/submissions [PNG + private Storage]",
                catch_response=True,
            ) as response:
                self._record_submission_response(response, is_image=True)
        else:
            with self.client.post(
                "/api/submissions",
                json={**form, "text": "x + 3 = 7\nx = 7 - 3\nx = 4"},
                headers=headers,
                name="POST /api/submissions [typed]",
                catch_response=True,
            ) as response:
                self._record_submission_response(response, is_image=False)

    def _record_submission_response(self, response, is_image: bool) -> None:
        if response.status_code != 200:
            _increment("submission_rejected")
            response.failure(f"submission returned HTTP {response.status_code}")
            return
        try:
            payload = response.json()
            submission_id = payload.get("id")
            if not isinstance(submission_id, str):
                raise ValueError
        except (ValueError, AttributeError):
            _increment("submission_rejected")
            response.failure("submission response did not contain an ID")
            return
        self.submission_id = submission_id
        _increment("submission_accepted")
        if is_image:
            _increment("image_uploads_accepted")
        response.success()

    @task
    def poll_progress_and_check_privacy(self) -> None:
        if not self.student:
            return
        with self.client.get("/api/practice", name="GET /api/practice [student progress poll]", catch_response=True) as response:
            if response.status_code != 200:
                response.failure(f"student progress poll returned HTTP {response.status_code}")
                return
            try:
                view = response.json()
            except ValueError:
                response.failure("student progress view was not JSON")
                return
            if not _student_privacy_ok(view, self.student["id"]):
                _increment("student_privacy_checks_failed")
                response.failure("student progress view exposed another student or teacher-only grade data")
                return
            if self.submission_id:
                matching = [item for item in _submission_list(view) if item.get("id") == self.submission_id]
                if not matching:
                    response.failure("student progress view did not contain the student's own submission")
                    return
            response.success()
            _increment("student_poll_checks")

        if self.is_image and self.submission_id and not self.image_readback_done:
            with self.client.get(
                f"/api/submissions/{self.submission_id}/image",
                name="GET /api/submissions/:id/image [private Storage readback]",
                catch_response=True,
            ) as response:
                if response.status_code == 200 and response.headers.get("content-type", "").startswith("image/png") and response.content == PNG_BYTES:
                    self.image_readback_done = True
                    _increment("image_readbacks_ok")
                    response.success()
                else:
                    response.failure(f"private image readback returned HTTP {response.status_code} or unexpected PNG data")


class TeacherUser(HttpUser):
    fixed_count = 1
    wait_time = between(5, 12)
    abstract = False

    def on_start(self) -> None:
        _attach_session(self, MANIFEST["teacher"]["token"])

    @task(1)
    def dashboard_read(self) -> None:
        with self.client.get("/dashboard", name="GET /dashboard [teacher]", catch_response=True, allow_redirects=False) as response:
            if response.status_code != 200:
                response.failure(f"teacher dashboard returned HTTP {response.status_code}")
            else:
                _increment("teacher_dashboard_reads")
                response.success()

    @task(3)
    def teacher_progress_read(self) -> None:
        with self.client.get("/api/practice", name="GET /api/practice [teacher roster and progress]", catch_response=True) as response:
            if response.status_code != 200:
                _increment("teacher_view_errors")
                response.failure(f"teacher progress view returned HTTP {response.status_code}")
                return
            try:
                view = response.json()
            except ValueError:
                _increment("teacher_view_errors")
                response.failure("teacher progress view was not JSON")
                return
            if not _assignment_is_visible(view) or view.get("role") != "teacher":
                _increment("teacher_view_errors")
                response.failure("teacher view did not contain the expected assignment and role")
                return
            _increment("teacher_api_reads")
            response.success()


@events.test_stop.add_listener
def write_counters(environment, **_kwargs) -> None:
    output = os.environ.get("LOADTEST_COUNTERS_PATH")
    if not output:
        return
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(COUNTERS, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)
