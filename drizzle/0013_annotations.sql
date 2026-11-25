ALTER TABLE "study_cards" ADD COLUMN "annotations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "study_cards" ADD COLUMN "annotations_version" integer DEFAULT 0 NOT NULL;