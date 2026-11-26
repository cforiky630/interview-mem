CREATE TABLE IF NOT EXISTS "concept_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"parent_id" text,
	"title" text NOT NULL,
	"color" text DEFAULT 'sage' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "folder_id" text;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'concept_folders_user_id_users_id_fk') THEN
		ALTER TABLE "concept_folders" ADD CONSTRAINT "concept_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'concept_folders_parent_id_concept_folders_id_fk') THEN
		ALTER TABLE "concept_folders" ADD CONSTRAINT "concept_folders_parent_id_concept_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."concept_folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'concept_folders_no_self_parent') THEN
		ALTER TABLE "concept_folders" ADD CONSTRAINT "concept_folders_no_self_parent" CHECK ("concept_folders"."parent_id" is null or "concept_folders"."parent_id" <> "concept_folders"."id");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'concepts_folder_id_concept_folders_id_fk') THEN
		ALTER TABLE "concepts" ADD CONSTRAINT "concepts_folder_id_concept_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."concept_folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_folder_user_parent_idx" ON "concept_folders" USING btree ("user_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "concept_folder_sibling_title_uniq" ON "concept_folders" USING btree ("user_id",(coalesce("parent_id", '')),(lower(btrim("title"))));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_user_folder_idx" ON "concepts" USING btree ("user_id","folder_id");--> statement-breakpoint
DO $$
DECLARE
	rec record;
	target_folder_id text;
	seed text;
	h text;
BEGIN
	FOR rec IN
		SELECT
			"user_id",
			lower(
				COALESCE(
					NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
					'未命名文件夹'
				)
			) AS lower_name,
			min(
				COALESCE(
					NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
					'未命名文件夹'
				)
			) AS display_name,
			min("created_at") AS first_created,
			max("updated_at") AS last_updated
		FROM "concepts"
		WHERE "folder_id" IS NULL AND btrim("group_name") <> ''
		GROUP BY
			"user_id",
			lower(
				COALESCE(
					NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
					'未命名文件夹'
				)
			)
	LOOP
		SELECT "id" INTO target_folder_id
		FROM "concept_folders"
		WHERE "user_id" = rec."user_id"
			AND "parent_id" IS NULL
			AND lower(btrim("title")) = rec.lower_name
		LIMIT 1;

		IF target_folder_id IS NULL THEN
			seed := 'shiyi-concept-folder:' || rec."user_id" || ':' || rec.lower_name;
			h := md5(seed);
			target_folder_id := substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12);

			INSERT INTO "concept_folders" ("id", "user_id", "parent_id", "title", "color", "created_at", "updated_at")
			VALUES (
				target_folder_id,
				rec."user_id",
				NULL,
				left(rec.display_name, 80),
				'sage',
				rec.first_created,
				rec.last_updated
			)
			ON CONFLICT ("id") DO NOTHING;
		END IF;

		UPDATE "concepts"
		SET "folder_id" = target_folder_id
		WHERE "user_id" = rec."user_id"
			AND "folder_id" IS NULL
			AND btrim("group_name") <> ''
			AND lower(
				COALESCE(
					NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
					'未命名文件夹'
				)
			) = rec.lower_name;
	END LOOP;
END $$;
