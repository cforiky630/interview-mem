ALTER TABLE "preferences" ALTER COLUMN "daily_goal" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "method" text DEFAULT 'rules' NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "source_name" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "source_hash" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "preview" jsonb;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "commit_hash" text;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "daily_new_limit" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "import_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
UPDATE "preferences" SET "daily_goal" = 5 WHERE "daily_goal" = 20;
