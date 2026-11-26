ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "parent_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "folder_id" text;--> statement-breakpoint
DROP INDEX IF EXISTS "question_hash_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_owner_hash_idx" ON "questions" USING btree ("owner_id","content_hash") WHERE "questions"."deleted_at" is null;--> statement-breakpoint
DO $$
DECLARE
  rec record;
  cat_rec record;
  grp_rec record;
  dup_rec record;
  group_folder_id text;
  cat_folder_id text;
  base_title text;
  candidate_title text;
  suffix int;
  seed text;
  h text;
BEGIN
  -- 1. Sanitize every active deck title to satisfy Finder/Explorer folder rules (trim, no / or \ or control chars, <= 80 chars).
  UPDATE "decks"
  SET "title" = COALESCE(
    NULLIF(
      NULLIF(
        NULLIF(
          left(
            btrim(regexp_replace(replace(replace("title", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')),
            80
          ),
          ''
        ),
        '.'
      ),
      '..'
    ),
    '未命名文件夹'
  )
  WHERE "deleted_at" IS NULL
    AND "title" IS DISTINCT FROM COALESCE(
      NULLIF(
        NULLIF(
          NULLIF(
            left(
              btrim(regexp_replace(replace(replace("title", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')),
              80
            ),
            ''
          ),
          '.'
        ),
        '..'
      ),
      '未命名文件夹'
    );

  -- 2. Synthesize top-level folders from distinct non-empty group_name across active decks and subscriptions.
  FOR rec IN
    SELECT user_id, lower_name, min(display_name) AS display_name
    FROM (
      SELECT
        "owner_id" AS user_id,
        lower(
          COALESCE(
            NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
            '未命名文件夹'
          )
        ) AS lower_name,
        COALESCE(
          NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
          '未命名文件夹'
        ) AS display_name
      FROM "decks"
      WHERE "deleted_at" IS NULL AND btrim("group_name") <> ''
      UNION ALL
      SELECT
        "user_id" AS user_id,
        lower(
          COALESCE(
            NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
            '未命名文件夹'
          )
        ) AS lower_name,
        COALESCE(
          NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
          '未命名文件夹'
        ) AS display_name
      FROM "subscriptions"
      WHERE btrim("group_name") <> ''
    ) src
    GROUP BY user_id, lower_name
  LOOP
    seed := 'shiyi-folder-group:' || rec.user_id || ':' || rec.lower_name;
    h := md5(seed);
    group_folder_id := substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12);

    INSERT INTO "decks" ("id", "owner_id", "parent_id", "title", "description", "group_name", "color", "visibility", "published_version")
    VALUES (group_folder_id, rec.user_id, NULL, left(rec.display_name, 80), '', '', 'sage', 'private', 0)
    ON CONFLICT ("id") DO NOTHING;

    -- Attach active decks with this group_name under the synthesized folder.
    UPDATE "decks"
    SET "parent_id" = group_folder_id
    WHERE "owner_id" = rec.user_id
      AND "deleted_at" IS NULL
      AND "id" <> group_folder_id
      AND "parent_id" IS NULL
      AND btrim("group_name") <> ''
      AND lower(
        COALESCE(
          NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
          '未命名文件夹'
        )
      ) = rec.lower_name;

    -- Attach subscriber's subscriptions with this group_name into the synthesized folder.
    UPDATE "subscriptions"
    SET "folder_id" = group_folder_id
    WHERE "user_id" = rec.user_id
      AND "folder_id" IS NULL
      AND btrim("group_name") <> ''
      AND lower(
        COALESCE(
          NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace("group_name", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
          '未命名文件夹'
        )
      ) = rec.lower_name;
  END LOOP;

  -- 3. Synthesize category subfolders under active decks for non-empty deck_groups.category.
  FOR cat_rec IN
    SELECT
      dg."owner_id" AS owner_id,
      dg."deck_id" AS deck_id,
      lower(
        COALESCE(
          NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace(dg."category", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
          '未命名文件夹'
        )
      ) AS lower_cat,
      min(
        COALESCE(
          NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace(dg."category", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
          '未命名文件夹'
        )
      ) AS display_cat,
      min(d."color") AS deck_color,
      min(dg."created_at") AS first_created,
      max(dg."updated_at") AS last_updated
    FROM "deck_groups" dg
    INNER JOIN "decks" d ON d."id" = dg."deck_id"
    WHERE d."deleted_at" IS NULL AND btrim(dg."category") <> ''
    GROUP BY
      dg."owner_id",
      dg."deck_id",
      lower(
        COALESCE(
          NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace(dg."category", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
          '未命名文件夹'
        )
      )
  LOOP
    seed := 'shiyi-folder-cat:' || cat_rec.deck_id || ':' || cat_rec.lower_cat;
    h := md5(seed);
    cat_folder_id := substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12);

    INSERT INTO "decks" ("id", "owner_id", "parent_id", "title", "description", "group_name", "color", "visibility", "published_version", "created_at", "updated_at")
    VALUES (
      cat_folder_id,
      cat_rec.owner_id,
      cat_rec.deck_id,
      left(cat_rec.display_cat, 80),
      '',
      '',
      cat_rec.deck_color,
      'private',
      0,
      cat_rec.first_created,
      cat_rec.last_updated
    )
    ON CONFLICT ("id") DO NOTHING;
  END LOOP;

  -- 4. Convert deck_groups of active decks into subfolders keeping their exact stable IDs.
  FOR grp_rec IN
    SELECT
      dg."id",
      dg."owner_id",
      dg."deck_id",
      dg."title",
      dg."category",
      dg."description",
      dg."created_at",
      dg."updated_at",
      d."color" AS deck_color
    FROM "deck_groups" dg
    INNER JOIN "decks" d ON d."id" = dg."deck_id"
    WHERE d."deleted_at" IS NULL
  LOOP
    IF btrim(grp_rec."category") <> '' THEN
      seed := 'shiyi-folder-cat:' || grp_rec."deck_id" || ':' || lower(
        COALESCE(
          NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace(grp_rec."category", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
          '未命名文件夹'
        )
      );
      h := md5(seed);
      cat_folder_id := substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12);
    ELSE
      cat_folder_id := grp_rec."deck_id";
    END IF;

    INSERT INTO "decks" ("id", "owner_id", "parent_id", "title", "description", "group_name", "color", "visibility", "published_version", "created_at", "updated_at")
    VALUES (
      grp_rec."id",
      grp_rec."owner_id",
      cat_folder_id,
      COALESCE(
        NULLIF(NULLIF(NULLIF(left(btrim(regexp_replace(replace(replace(grp_rec."title", '/', '／'), '\', '／'), '[[:cntrl:]]', '', 'g')), 80), ''), '.'), '..'),
        '未命名文件夹'
      ),
      grp_rec."description",
      '',
      grp_rec."deck_color",
      'private',
      0,
      grp_rec."created_at",
      grp_rec."updated_at"
    )
    ON CONFLICT ("id") DO NOTHING;
  END LOOP;

  -- 5. Move questions assigned to migrated deck_groups into the corresponding subfolder (preserving trashed location too).
  UPDATE "questions" q
  SET "deck_id" = q."group_id"
  WHERE q."group_id" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "decks" d
      WHERE d."id" = q."group_id" AND d."deleted_at" IS NULL
    );

  -- 6. Resolve any case-insensitive sibling title collisions among active folders before enforcing uniqueness.
  LOOP
    EXIT WHEN NOT EXISTS (
      SELECT 1
      FROM "decks"
      WHERE "deleted_at" IS NULL
      GROUP BY "owner_id", COALESCE("parent_id", ''), lower(btrim("title"))
      HAVING count(*) > 1
    );

    FOR dup_rec IN
      SELECT id, owner_id, parent_id, title
      FROM (
        SELECT
          d."id",
          d."owner_id",
          d."parent_id",
          d."title",
          row_number() OVER (
            PARTITION BY d."owner_id", COALESCE(d."parent_id", ''), lower(btrim(d."title"))
            ORDER BY (d."published_version" > 0) DESC, d."created_at" ASC, d."id" ASC
          ) AS rn
        FROM "decks" d
        WHERE d."deleted_at" IS NULL
      ) ranked
      WHERE rn > 1
    LOOP
      base_title := btrim(dup_rec.title);
      suffix := 2;
      LOOP
        candidate_title := left(base_title, GREATEST(1, 80 - length(' (' || suffix || ')'))) || ' (' || suffix || ')';
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM "decks" other
          WHERE other."deleted_at" IS NULL
            AND other."owner_id" = dup_rec.owner_id
            AND COALESCE(other."parent_id", '') = COALESCE(dup_rec.parent_id, '')
            AND lower(btrim(other."title")) = lower(btrim(candidate_title))
        );
        suffix := suffix + 1;
      END LOOP;

      UPDATE "decks"
      SET "title" = candidate_title
      WHERE "id" = dup_rec.id;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decks_parent_id_decks_id_fk') THEN
    ALTER TABLE "decks" ADD CONSTRAINT "decks_parent_id_decks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."decks"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decks_no_self_parent') THEN
    ALTER TABLE "decks" ADD CONSTRAINT "decks_no_self_parent" CHECK ("decks"."parent_id" is null or "decks"."parent_id" <> "decks"."id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_folder_id_decks_id_fk') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_folder_id_decks_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."decks"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deck_owner_parent_idx" ON "decks" USING btree ("owner_id","parent_id") WHERE "decks"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deck_sibling_title_uniq" ON "decks" USING btree ("owner_id",(coalesce("parent_id", '')),(lower(btrim("title")))) WHERE "decks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_user_folder_idx" ON "subscriptions" USING btree ("user_id","folder_id");
