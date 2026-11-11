ALTER TABLE "teacher_overrides" ALTER COLUMN "previous_result" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teacher_overrides" ADD COLUMN "kind" varchar(32) DEFAULT 'correction' NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.goblins_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'submitted' AND NEW.status = 'processing') OR
    (OLD.status = 'processing' AND NEW.status IN ('auto_grading','retryable_failure','permanent_failure')) OR
    (OLD.status = 'auto_grading' AND NEW.status IN ('processing','waiting_for_teacher','retryable_failure','permanent_failure')) OR
    (OLD.status = 'retryable_failure' AND NEW.status IN ('processing','waiting_for_teacher')) OR
    (OLD.status = 'permanent_failure' AND NEW.status IN ('retryable_failure','waiting_for_teacher')) OR
    (OLD.status = 'waiting_for_teacher' AND NEW.status = 'finalized')
  ) THEN RAISE EXCEPTION 'Invalid grading status transition'; END IF;
  IF OLD.status IN ('retryable_failure','permanent_failure') AND NEW.status = 'waiting_for_teacher'
    AND (NEW.source IS DISTINCT FROM OLD.source OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.latest_run_id IS DISTINCT FROM OLD.latest_run_id) THEN
    RAISE EXCEPTION 'Manual grading must preserve the original work and failure record';
  END IF;
  IF NEW.status = 'finalized' AND NOT EXISTS (
    SELECT 1 FROM public.grades g JOIN public.classes c ON c.id = NEW.class_id
    WHERE g.submission_id = NEW.id AND g.approved_at IS NOT NULL AND g.approved_by = c.teacher_id
  ) THEN RAISE EXCEPTION 'Final grade requires class teacher approval'; END IF;
  RETURN NEW;
END;
$$;