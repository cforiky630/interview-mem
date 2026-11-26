DROP INDEX IF EXISTS "question_group_idx";--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN IF EXISTS "group_id";--> statement-breakpoint
DROP TABLE IF EXISTS "deck_groups";--> statement-breakpoint
ALTER TABLE "decks" DROP COLUMN IF EXISTS "group_name";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "group_name";
