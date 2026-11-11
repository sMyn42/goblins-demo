CREATE TABLE "worker_heartbeats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale_after_ms" integer NOT NULL,
	"ready" boolean NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "worker_heartbeat_seen_idx" ON "worker_heartbeats" USING btree ("last_seen_at");--> statement-breakpoint
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.worker_heartbeats FROM PUBLIC;--> statement-breakpoint
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.worker_heartbeats FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
