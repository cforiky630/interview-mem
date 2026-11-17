DROP INDEX "question_hash_idx";--> statement-breakpoint
ALTER TABLE "imports" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "owner_id" text;--> statement-breakpoint
UPDATE "questions" q SET "owner_id" = d."owner_id" FROM "decks" d WHERE q."deck_id" = d."id";--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
UPDATE "questions" q SET "deck_id" = NULL FROM "decks" d WHERE q."deck_id" = d."id" AND d."deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_owner_idx" ON "questions" USING btree ("owner_id","deleted_at");--> statement-breakpoint
CREATE INDEX "question_trash_expiry_idx" ON "questions" USING btree ("deleted_at") WHERE "questions"."deleted_at" is not null and "questions"."purged_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "question_hash_idx" ON "questions" USING btree ("deck_id","content_hash") WHERE "questions"."deleted_at" is null;
