ALTER TABLE "ai_credentials" ALTER COLUMN "provider" SET DEFAULT 'openai-compatible';--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD COLUMN "base_url" text DEFAULT 'https://api.deepseek.com' NOT NULL;
--> statement-breakpoint
UPDATE "ai_credentials" SET "provider" = 'openai-compatible' WHERE "provider" = 'deepseek';
