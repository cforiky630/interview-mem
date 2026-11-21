CREATE INDEX IF NOT EXISTS "question_import_idx" ON "questions" USING btree ("import_id") WHERE "questions"."import_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_questions_gin_idx" ON "deck_releases" USING gin ("questions" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_user_time_idx" ON "imports" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "question_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "question_title" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "answer_snapshot" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "question_revision" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "scope" text DEFAULT 'question' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deck_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_user_scope_idx" ON "conversations" USING btree ("user_id","scope","deck_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_conv_time_idx" ON "chat_messages" USING btree ("conversation_id","created_at");
