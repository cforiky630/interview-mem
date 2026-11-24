CREATE TABLE "author_subscriptions" (
	"follower_id" text NOT NULL,
	"author_id" text NOT NULL,
	"auto_subscribe_new" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "author_subscriptions_follower_id_author_id_pk" PRIMARY KEY("follower_id","author_id"),
	CONSTRAINT "author_subscriptions_no_self_follow" CHECK ("author_subscriptions"."follower_id" <> "author_subscriptions"."author_id")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "dismissed_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "author_subscriptions" ADD CONSTRAINT "author_subscriptions_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_subscriptions" ADD CONSTRAINT "author_subscriptions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "author_sub_author_idx" ON "author_subscriptions" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "subscription_deck_idx" ON "subscriptions" USING btree ("deck_id");--> statement-breakpoint
UPDATE "subscriptions" s SET "seen_version" = GREATEST(1, d."published_version") FROM "decks" d WHERE s."deck_id" = d."id" AND (s."seen_version" <= 0 OR s."seen_version" > d."published_version") AND d."published_version" > 0;