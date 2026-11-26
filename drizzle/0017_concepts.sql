CREATE TABLE IF NOT EXISTS "concepts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"term" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"normalized_key" text NOT NULL,
	"definition" text NOT NULL,
	"group_name" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'accent' NOT NULL,
	"source_question_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'concepts_user_id_users_id_fk') THEN
		ALTER TABLE "concepts" ADD CONSTRAINT "concepts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'concepts_source_question_id_questions_id_fk') THEN
		ALTER TABLE "concepts" ADD CONSTRAINT "concepts_source_question_id_questions_id_fk" FOREIGN KEY ("source_question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_user_group_idx" ON "concepts" USING btree ("user_id","group_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "concept_user_norm_key_uniq" ON "concepts" USING btree ("user_id","normalized_key");
