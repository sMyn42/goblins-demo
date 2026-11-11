"""Unit tests for the load-test isolation boundary and supplied cohort plan."""
from __future__ import annotations

import unittest

from config import CONFIRMATION, LoadTestConfigError, load_cohort_data, load_settings


class LoadTestConfigTests(unittest.TestCase):
    def valid_env(self) -> dict[str, str]:
        return {
            "LOADTEST_ENVIRONMENT": "isolated",
            "LOADTEST_CONFIRM_ISOLATED": CONFIRMATION,
            "LOADTEST_DATABASE_URL": "postgresql://loadtest:secret@db.loadtest-project.supabase.co:5432/postgres",
            "LOADTEST_EXPECTED_DATABASE_HOST": "db.loadtest-project.supabase.co",
            "LOADTEST_PRODUCTION_DATABASE_HOST": "db.production-project.supabase.co",
            "LOADTEST_SUPABASE_URL": "https://loadtest-project.supabase.co",
            "LOADTEST_PRODUCTION_SUPABASE_URL": "https://production-project.supabase.co",
            "LOADTEST_STORAGE_BUCKET": "goblins-loadtest-work",
            "LOADTEST_PRODUCTION_STORAGE_BUCKET": "student-work",
            "LOADTEST_BASE_URL": "https://goblins-loadtest-web-abc.run.app",
            "LOADTEST_WEB_SERVICE": "goblins-loadtest-web",
            "LOADTEST_WORKER_SERVICE": "goblins-loadtest-worker",
            "LOADTEST_WORKER_MONITOR_TOKEN": "x" * 40,
            "LOADTEST_GCP_PROJECT": "goblins-loadtest",
            "LOADTEST_GCP_REGION": "us-central1",
            "LOADTEST_DATABASE_SECRET_NAME": "goblins-loadtest-database",
            "LOADTEST_STORAGE_SECRET_NAME": "goblins-loadtest-storage-key",
            "LOADTEST_MONITOR_SECRET_NAME": "goblins-loadtest-monitor-token",
            "LOADTEST_RUN_ID": "config-test-01",
        }

    def test_accepts_explicitly_isolated_stack(self) -> None:
        settings = load_settings(self.valid_env())
        self.assertEqual(settings.environment, "isolated")
        self.assertEqual(settings.database_host, "db.loadtest-project.supabase.co")
        self.assertEqual(settings.worker_concurrency, 2)
        self.assertEqual(settings.storage_bucket, "goblins-loadtest-work")
        self.assertEqual(settings.image_fraction, 1.0)

    def test_requires_confirmation_and_never_defaults_to_production_database(self) -> None:
        env = self.valid_env()
        env.pop("LOADTEST_DATABASE_URL")
        with self.assertRaises(LoadTestConfigError):
            load_settings(env)
        env = self.valid_env()
        env["LOADTEST_CONFIRM_ISOLATED"] = "yes"
        with self.assertRaises(LoadTestConfigError):
            load_settings(env)

    def test_rejects_production_database_storage_and_service_names(self) -> None:
        for key, value in (
            ("LOADTEST_EXPECTED_DATABASE_HOST", "db.production-project.supabase.co"),
            ("LOADTEST_PRODUCTION_SUPABASE_URL", "https://loadtest-project.supabase.co"),
            ("LOADTEST_STORAGE_BUCKET", "student-work"),
            ("LOADTEST_WEB_SERVICE", "goblins-web"),
        ):
            with self.subTest(key=key):
                env = self.valid_env()
                env[key] = value
                with self.assertRaises(LoadTestConfigError):
                    load_settings(env)

    def test_supplied_scale_cohorts_have_unique_students_within_each_stage(self) -> None:
        cohorts, plans, account_count, _ = load_cohort_data()
        self.assertEqual([cohorts[name].students for name in plans["scale"]], [50, 250, 1250])
        ranges = []
        for name in plans["scale"]:
            cohort = cohorts[name]
            ranges.append(set(range(cohort.offset, cohort.offset + cohort.students)))
        self.assertEqual(len(ranges[0] & ranges[1]), 0)
        self.assertEqual(len(ranges[0] & ranges[2]), 0)
        self.assertEqual(len(ranges[1] & ranges[2]), 0)
        self.assertEqual(account_count, 1550)
        self.assertEqual(cohorts["capacity_250_2_workers"].worker_instances, 2)
        self.assertEqual(cohorts["capacity_250_5_workers"].worker_instances, 5)
        self.assertEqual(cohorts["failure_transient_10pct_250"].failure_rate, 0.1)
        timeout = cohorts["failure_hard_cutoff_manual_20"]
        self.assertEqual(timeout.failure_mode, "timeout")
        self.assertEqual(timeout.failure_rate, 0.5)
        self.assertEqual(plans["timeout_manual"], ["failure_hard_cutoff_manual_20"])
        self.assertEqual(timeout.worker_lease_seconds, 30)
        self.assertEqual(timeout.ocr_timeout_ms, 60000)
        self.assertEqual(timeout.grading_timeout_ms, 60000)
        self.assertEqual(load_settings(self.valid_env()).image_fraction, 1.0)
        self.assertIn("approval_smoke_1", plans["approval"])


if __name__ == "__main__":
    unittest.main()
