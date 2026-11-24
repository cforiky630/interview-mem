CREATE TABLE "deck_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"deck_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "question_hash_idx";--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "group_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deck_releases" ADD COLUMN "groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "group_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "deck_groups" ADD CONSTRAINT "deck_groups_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deck_groups" ADD CONSTRAINT "deck_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deck_group_deck_pos_idx" ON "deck_groups" USING btree ("deck_id","position","created_at");--> statement-breakpoint
CREATE INDEX "deck_group_owner_idx" ON "deck_groups" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_group_id_deck_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."deck_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_group_idx" ON "questions" USING btree ("deck_id","group_id","position","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "question_hash_idx" ON "questions" USING btree ("deck_id",(coalesce("group_id", '')),"content_hash") WHERE "questions"."deleted_at" is null and "questions"."deck_id" is not null;