ALTER TABLE "students" ADD CONSTRAINT "students_user_class_unique" UNIQUE("user_id","class_id");--> statement-breakpoint
CREATE TYPE "public"."grading_status" AS ENUM('submitted', 'processing', 'auto_grading', 'waiting_for_teacher', 'finalized', 'retryable_failure', 'permanent_failure');--> statement-breakpoint
CREATE TABLE "assignment_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"show_draft_grades" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_versions_class_id_unique" UNIQUE("class_id"),
	CONSTRAINT "assignment_version_class_unique" UNIQUE("id","class_id")
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"rubric_version_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_pair" CHECK (("grades"."approved_by" IS NULL) = ("grades"."approved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "grading_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"extracted_answer" jsonb,
	"state" varchar(32) NOT NULL,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "question_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_version_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"max_points" integer NOT NULL,
	"expected_answers" jsonb NOT NULL,
	"teacher_solution" text NOT NULL,
	CONSTRAINT "question_versions_assignment_version_id_unique" UNIQUE("assignment_version_id"),
	CONSTRAINT "question_assignment_unique" UNIQUE("id","assignment_version_id"),
	CONSTRAINT "question_points_positive" CHECK ("question_versions"."max_points" > 0)
);
--> statement-breakpoint
CREATE TABLE "rubric_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_version_id" uuid NOT NULL,
	"criteria" jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rubric_versions_question_version_id_unique" UNIQUE("question_version_id")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"assignment_version_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"source" jsonb NOT NULL,
	"status" "grading_status" DEFAULT 'submitted' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"active_run_id" uuid,
	"latest_run_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_one_attempt" UNIQUE("student_id","question_version_id"),
	CONSTRAINT "submission_idempotency" UNIQUE("student_id","idempotency_key"),
	CONSTRAINT "submission_attempts_nonnegative" CHECK ("submissions"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "assignment_versions" ADD CONSTRAINT "assignment_versions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_run_id_grading_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grading_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_rubric_version_id_rubric_versions_id_fk" FOREIGN KEY ("rubric_version_id") REFERENCES "public"."rubric_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_approved_by_teacher_profiles_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."teacher_profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_runs" ADD CONSTRAINT "grading_runs_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_assignment_version_id_assignment_versions_id_fk" FOREIGN KEY ("assignment_version_id") REFERENCES "public"."assignment_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_versions" ADD CONSTRAINT "rubric_versions_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_versions" ADD CONSTRAINT "rubric_versions_approved_by_teacher_profiles_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."teacher_profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_student_id_class_id_students_user_id_class_id_fk" FOREIGN KEY ("student_id","class_id") REFERENCES "public"."students"("user_id","class_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_version_id_class_id_assignment_versions_id_class_id_fk" FOREIGN KEY ("assignment_version_id","class_id") REFERENCES "public"."assignment_versions"("id","class_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_question_version_id_assignment_version_id_question_versions_id_assignment_version_id_fk" FOREIGN KEY ("question_version_id","assignment_version_id") REFERENCES "public"."question_versions"("id","assignment_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grading_runs_submission_idx" ON "grading_runs" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "submissions_class_status_idx" ON "submissions" USING btree ("class_id","status");--> statement-breakpoint
-- Published grading contracts never change beneath accepted submissions.
CREATE FUNCTION public.goblins_immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published versions are immutable'; END;
$$;--> statement-breakpoint
CREATE TRIGGER immutable_assignment BEFORE UPDATE OR DELETE ON public.assignment_versions FOR EACH ROW EXECUTE FUNCTION public.goblins_immutable_version();--> statement-breakpoint
CREATE TRIGGER immutable_question BEFORE UPDATE OR DELETE ON public.question_versions FOR EACH ROW EXECUTE FUNCTION public.goblins_immutable_version();--> statement-breakpoint
CREATE TRIGGER immutable_rubric BEFORE UPDATE OR DELETE ON public.rubric_versions FOR EACH ROW EXECUTE FUNCTION public.goblins_immutable_version();--> statement-breakpoint
CREATE FUNCTION public.goblins_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'submitted' AND NEW.status = 'processing') OR
    (OLD.status = 'processing' AND NEW.status IN ('auto_grading','retryable_failure','permanent_failure')) OR
    (OLD.status = 'auto_grading' AND NEW.status IN ('processing','waiting_for_teacher','retryable_failure','permanent_failure')) OR
    (OLD.status = 'retryable_failure' AND NEW.status = 'processing') OR
    (OLD.status = 'permanent_failure' AND NEW.status = 'retryable_failure') OR
    (OLD.status = 'waiting_for_teacher' AND NEW.status = 'finalized')
  ) THEN RAISE EXCEPTION 'Invalid grading status transition'; END IF;
  IF NEW.status = 'finalized' AND NOT EXISTS (
    SELECT 1 FROM public.grades g JOIN public.classes c ON c.id = NEW.class_id
    WHERE g.submission_id = NEW.id AND g.approved_at IS NOT NULL AND g.approved_by = c.teacher_id
  ) THEN RAISE EXCEPTION 'Final grade requires class teacher approval'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER grading_status_guard BEFORE UPDATE ON public.submissions FOR EACH ROW EXECUTE FUNCTION public.goblins_status_guard();--> statement-breakpoint
-- Block browser API roles; application/worker access is server-side SQL only.
DO $$
DECLARE tab text; role_name text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['users','teacher_profiles','classes','students','sessions','rate_limits','product_events','assignment_versions','question_versions','rubric_versions','submissions','grading_runs','grades'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', tab);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', tab, role_name);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
