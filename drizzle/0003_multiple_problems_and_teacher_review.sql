CREATE TABLE "assignment_settings" (
	"assignment_version_id" uuid PRIMARY KEY NOT NULL,
	"show_draft_grades" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teacher_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"teacher_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"reason" text NOT NULL,
	"previous_result" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "override_submission_revision_unique" UNIQUE("submission_id","revision")
);
--> statement-breakpoint
ALTER TABLE "question_versions" DROP CONSTRAINT "question_versions_assignment_version_id_unique";--> statement-breakpoint
ALTER TABLE "grades" ADD COLUMN "reviewed_result" jsonb;--> statement-breakpoint
ALTER TABLE "grades" ADD COLUMN "review_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "grading_instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assignment_settings" ADD CONSTRAINT "assignment_settings_assignment_version_id_assignment_versions_id_fk" FOREIGN KEY ("assignment_version_id") REFERENCES "public"."assignment_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_overrides" ADD CONSTRAINT "teacher_overrides_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_overrides" ADD CONSTRAINT "teacher_overrides_teacher_id_teacher_profiles_user_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teacher_profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_assignment_position_unique" UNIQUE("assignment_version_id","position");--> statement-breakpoint
INSERT INTO public.assignment_settings (assignment_version_id, show_draft_grades)
SELECT id, show_draft_grades FROM public.assignment_versions ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE FUNCTION public.goblins_grade_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL THEN RAISE EXCEPTION 'Released grades are immutable'; END IF;
  IF NEW.result IS DISTINCT FROM OLD.result OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.rubric_version_id IS DISTINCT FROM OLD.rubric_version_id OR NEW.submission_id IS DISTINCT FROM OLD.submission_id THEN
    RAISE EXCEPTION 'Original AI result and version references are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER original_and_released_grade_guard BEFORE UPDATE ON public.grades FOR EACH ROW EXECUTE FUNCTION public.goblins_grade_guard();--> statement-breakpoint
CREATE FUNCTION public.goblins_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Teacher override history is append-only'; END;
$$;--> statement-breakpoint
CREATE TRIGGER override_audit_guard BEFORE UPDATE OR DELETE ON public.teacher_overrides FOR EACH ROW EXECUTE FUNCTION public.goblins_audit_guard();--> statement-breakpoint
DO $$
DECLARE tab text; role_name text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['assignment_settings','teacher_overrides'] LOOP
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
