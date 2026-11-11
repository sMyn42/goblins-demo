ALTER TABLE "assignment_versions" DROP CONSTRAINT "assignment_versions_class_id_unique";--> statement-breakpoint
ALTER TABLE "assignment_versions" ADD COLUMN "publication_key" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "assignment_versions" ADD COLUMN "publication_fingerprint" varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "assignments_class_published_idx" ON "assignment_versions" USING btree ("class_id","published_at");--> statement-breakpoint
ALTER TABLE "assignment_versions" ADD CONSTRAINT "assignment_publication_key_unique" UNIQUE("class_id","publication_key");