ALTER TABLE "preferences" ADD COLUMN IF NOT EXISTS "workspace_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deck_public_updated_idx" ON "decks" USING btree ("updated_at" DESC) WHERE "decks"."visibility" = 'public' and "decks"."published_version" > 0 and "decks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deck_owner_public_idx" ON "decks" USING btree ("owner_id") WHERE "decks"."visibility" = 'public' and "decks"."published_version" > 0 and "decks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_owner_created_desc_idx" ON "questions" USING btree ("owner_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_owner_deck_pos_idx" ON "questions" USING btree ("owner_id","deck_id","position" DESC) WHERE "questions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_owner_active_created_idx" ON "questions" USING btree ("owner_id","created_at","id") WHERE "questions"."deleted_at" is null and "questions"."purged_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_user_question_idx" ON "review_events" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "study_card_annotations_gin_idx" ON "study_cards" USING gin ("annotations" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_orphan_cleanup_idx" ON "imports" USING btree ("created_at") WHERE "imports"."status" in ('draft', 'failed', 'parsing');
