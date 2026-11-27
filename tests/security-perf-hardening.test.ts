import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type Redis from "ioredis";
import type { QuestionAnnotation, Workspace } from "../src/lib/types";
import { applyAnnotationHighlights } from "../src/lib/annotations";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOCAL_DATABASE_PATH: ":memory:",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  KEY_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
});
delete process.env.DATABASE_URL;
delete process.env.PGHOST;
delete process.env.REDIS_URL;
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.TURNSTILE_SITE_KEY;

const { getAuth, resetAuthForTests } = await import("../src/server/auth");
const { encryptKey, decryptKey } = await import("../src/server/crypto");
const {
  isPublicAiAddress,
  assertAiHostname,
  clearAiTransportCaches,
  aiFetch,
} = await import("../src/server/ai-transport");
const {
  createBetterAuthSecondaryStorage,
  checkOtpEmailQuota,
  isLoginEmailThrottled,
  recordLoginFailure,
  clearLoginFailure,
} = await import("../src/server/redis");
const { validateProductionEnvironment } = await import(
  "../src/server/config.mjs"
);
const { accessibleQuestion } = await import("../src/server/workspace");
const authConfigRoute = await import("../src/app/api/auth-config/route");
const workspaceRoute = await import("../src/app/api/workspace/route");
const decksRoute = await import("../src/app/api/decks/route");
const questionsRoute = await import("../src/app/api/questions/route");
const reviewsRoute = await import("../src/app/api/reviews/route");
const exportRoute = await import("../src/app/api/export/route");
const restoreRoute = await import("../src/app/api/backup/restore/route");
const authorsRoute = await import("../src/app/api/authors/route");
const conceptsRoute = await import("../src/app/api/concepts/route");

type Account = { id: string; cookie: string };
let ipCounter = 1;

async function register(name: string): Promise<Account> {
  const auth = await getAuth();
  const res = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-forwarded-for": `198.51.100.${++ipCounter}`,
      },
      body: JSON.stringify({
        name,
        email: `${name}-${randomUUID().slice(0, 8)}@hardening.test`,
        password: `Str0ng!Pass-${randomUUID()}`,
      }),
    }),
  );
  const json = (await res.json()) as { user?: { id: string } };
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.ok(json.user?.id);
  return {
    id: json.user.id,
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}

function makeReq(
  account: Account | null,
  urlPath: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return new Request(`http://localhost:3000${urlPath}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: "http://localhost:3000",
      ...(account ? { cookie: account.cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function fetchWorkspace(account: Account): Promise<Workspace> {
  const res = await workspaceRoute.GET(makeReq(account, "/api/workspace"));
  assert.equal(res.status, 200);
  return res.json();
}

// Lightweight DOM stub verifying single-pass highlight slicing without jsdom.
class StubNode {
  parentNode: StubElement | null = null;
  constructor(
    public nodeType: number,
    public ownerDocument: StubDocument,
  ) {}
  get nextSibling(): StubNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 && idx + 1 < this.parentNode.childNodes.length
      ? this.parentNode.childNodes[idx + 1]
      : null;
  }
}

class StubText extends StubNode {
  constructor(
    public nodeValue: string,
    ownerDocument: StubDocument,
  ) {
    super(3, ownerDocument);
  }
  get length() {
    return this.nodeValue.length;
  }
  splitText(offset: number): StubText {
    const rest = new StubText(this.nodeValue.slice(offset), this.ownerDocument);
    this.nodeValue = this.nodeValue.slice(0, offset);
    if (this.parentNode) {
      const idx = this.parentNode.childNodes.indexOf(this);
      rest.parentNode = this.parentNode;
      this.parentNode.childNodes.splice(idx + 1, 0, rest);
    }
    return rest;
  }
}

class StubElement extends StubNode {
  childNodes: StubNode[] = [];
  className = "";
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  tabIndex = -1;
  tagName: string;
  constructor(tagName: string, ownerDocument: StubDocument) {
    super(1, ownerDocument);
    this.tagName = tagName.toUpperCase();
  }
  get firstChild(): StubNode | null {
    return this.childNodes[0] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  appendChild<T extends StubNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends StubNode>(child: T, ref: StubNode | null): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (!ref) {
      this.childNodes.push(child);
      return child;
    }
    const idx = this.childNodes.indexOf(ref);
    if (idx === -1) this.childNodes.push(child);
    else this.childNodes.splice(idx, 0, child);
    return child;
  }
  removeChild<T extends StubNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  normalize() {
    let i = 0;
    while (i < this.childNodes.length) {
      const cur = this.childNodes[i];
      if (cur instanceof StubText) {
        if (!cur.nodeValue) {
          this.removeChild(cur);
          continue;
        }
        const next = this.childNodes[i + 1];
        if (next instanceof StubText) {
          cur.nodeValue += next.nodeValue;
          this.removeChild(next);
          continue;
        }
      }
      i++;
    }
  }
  matches(selectorList: string): boolean {
    const classes = this.className.split(/\s+/).filter(Boolean);
    return selectorList
      .split(",")
      .map((s) => s.trim())
      .some((sel) => {
        if (!sel) return false;
        if (sel.startsWith(".")) return classes.includes(sel.slice(1));
        const dotIdx = sel.indexOf(".");
        if (dotIdx > 0) {
          const tag = sel.slice(0, dotIdx).toUpperCase();
          const cls = sel.slice(dotIdx + 1);
          return this.tagName === tag && classes.includes(cls);
        }
        return this.tagName === sel.toUpperCase();
      });
  }
  get textContent(): string {
    return this.childNodes
      .map((c) =>
        c instanceof StubText
          ? c.nodeValue
          : c instanceof StubElement
            ? c.textContent
            : "",
      )
      .join("");
  }
  collectMarks(): StubElement[] {
    const out: StubElement[] = [];
    for (const child of this.childNodes) {
      if (child instanceof StubElement) {
        if (child.tagName === "MARK") out.push(child);
        out.push(...child.collectMarks());
      }
    }
    return out;
  }
}

class StubDocument {
  createElement(tag: string) {
    return new StubElement(tag, this);
  }
  createTextNode(text: string) {
    return new StubText(text, this);
  }
}

after(() => {
  mock.restoreAll();
});

test("0019 migration applies cleanly on fresh DB and upgrades cleanly from 0018", async () => {
  const drizzleDir = path.resolve("drizzle");
  const expectedIndexes = [
    "session_expires_idx",
    "deck_public_updated_idx",
    "deck_owner_public_idx",
    "question_owner_created_desc_idx",
    "question_owner_deck_pos_idx",
    "question_owner_active_created_idx",
    "review_user_question_idx",
    "study_card_annotations_gin_idx",
    "import_orphan_cleanup_idx",
  ];

  // Fresh migrate()
  const fresh = new PGlite();
  await migrate(drizzle(fresh), { migrationsFolder: drizzleDir });
  const freshCol = await fresh.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'preferences' AND column_name = 'workspace_version'`,
  );
  assert.equal(freshCol.rows.length, 1);
  const freshIdx = await fresh.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  const freshSet = new Set(freshIdx.rows.map((r) => r.indexname));
  for (const name of expectedIndexes) {
    assert.ok(freshSet.has(name), `missing fresh index ${name}`);
  }
  await fresh.close();

  // Upgrade from 0000..0018 -> 0019
  const upgrade = new PGlite();
  const files = (await readdir(drizzleDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  assert.ok(files.includes("0018_concept_folders.sql"));
  assert.ok(files.includes("0019_security_perf_indexes.sql"));

  for (const file of files) {
    if (file === "0019_security_perf_indexes.sql") continue;
    const raw = await readFile(path.join(drizzleDir, file), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await upgrade.exec(stmt);
    }
  }
  const sql0019 = await readFile(
    path.join(drizzleDir, "0019_security_perf_indexes.sql"),
    "utf8",
  );
  for (const stmt of sql0019.split("--> statement-breakpoint")) {
    if (stmt.trim()) await upgrade.exec(stmt);
  }

  const upCol = await upgrade.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'preferences' AND column_name = 'workspace_version'`,
  );
  assert.equal(upCol.rows.length, 1);
  const upIdx = await upgrade.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  const upSet = new Set(upIdx.rows.map((r) => r.indexname));
  for (const name of expectedIndexes) {
    assert.ok(upSet.has(name), `missing upgraded index ${name}`);
  }
  await upgrade.close();
});

test("backup-restore rejects poisoned releases & cross-tenant bindings, pins subscription version, and batches >600 rows", async () => {
  const author = await register("bk-author");
  const victim = await register("bk-victim");
  const subscriber = await register("bk-sub");

  // Author creates a public published deck (v2) AND a private deck
  const pubDeckRes = await decksRoute.POST(
    makeReq(author, "/api/decks", { action: "create", title: "公开题库" }),
  );
  const pubDeckId = ((await pubDeckRes.json()) as { id: string }).id;

  const privDeckRes = await decksRoute.POST(
    makeReq(author, "/api/decks", { action: "create", title: "私密题库" }),
  );
  const privDeckId = ((await privDeckRes.json()) as { id: string }).id;

  const qPubRes = await questionsRoute.POST(
    makeReq(author, "/api/questions", {
      action: "create",
      deckId: pubDeckId,
      title: "公开题目 1",
      answer: "公开答案 1",
    }),
  );
  const qPubId = ((await qPubRes.json()) as { id: string }).id;

  const qPrivRes = await questionsRoute.POST(
    makeReq(author, "/api/questions", {
      action: "create",
      deckId: privDeckId,
      title: "绝密私题",
      answer: "绝密答案",
    }),
  );
  const qPrivId = ((await qPrivRes.json()) as { id: string }).id;

  // Publish v1, then add a review + publish v2
  const pubV1 = await decksRoute.POST(
    makeReq(author, "/api/decks", {
      action: "publish",
      deckId: pubDeckId,
      expectedVersion: 0,
      visibility: "public",
      summary: "v1",
    }),
  );
  assert.equal(pubV1.status, 200);

  const qPub2Res = await questionsRoute.POST(
    makeReq(author, "/api/questions", {
      action: "create",
      deckId: pubDeckId,
      title: "公开题目 2",
      answer: "公开答案 2",
    }),
  );
  assert.equal(qPub2Res.status, 200);

  const pubV2 = await decksRoute.POST(
    makeReq(author, "/api/decks", {
      action: "publish",
      deckId: pubDeckId,
      expectedVersion: 1,
      visibility: "public",
      summary: "v2",
    }),
  );
  assert.equal(pubV2.status, 200);

  await reviewsRoute.POST(
    makeReq(author, "/api/reviews", {
      questionId: qPubId,
      rating: 3,
      clientRequestId: randomUUID(),
    }),
  );

  // 1. Export author's backup and strip releases while claiming visibility="public", publishedVersion=2
  const expAuthorRes = await exportRoute.GET(
    makeReq(author, "/api/export?format=json"),
  );
  assert.equal(expAuthorRes.status, 200);
  const authorBackup = (await expAuthorRes.json()) as Record<string, unknown>;
  const poisonedNoReleases = structuredClone(authorBackup) as {
    decks: Array<{
      id: string;
      visibility: string;
      publishedVersion: number;
    }>;
    releases: unknown[];
  };
  poisonedNoReleases.releases = [];

  const restorePoison = await restoreRoute.POST(
    makeReq(victim, "/api/backup/restore", poisonedNoReleases),
  );
  assert.equal(restorePoison.status, 200);
  const victimWs = await fetchWorkspace(victim);
  const coercedDeck = victimWs.decks.find((d) => d.title === "公开题库");
  assert.ok(coercedDeck);
  assert.equal(coercedDeck.visibility, "private");
  assert.equal(coercedDeck.publishedVersion, 0);

  // 2. Subscriber subscribes to public deck, exports backup, tampers seenVersion=1 + forges private sub/question binding
  const subAction = await decksRoute.POST(
    makeReq(subscriber, "/api/decks", {
      action: "subscribe",
      deckId: pubDeckId,
    }),
  );
  assert.equal(subAction.status, 200);

  const expSubRes = await exportRoute.GET(
    makeReq(subscriber, "/api/export?format=json"),
  );
  const subBackup = (await expSubRes.json()) as {
    subscriptions: Array<{ deckId: string; seenVersion: number; dismissedVersion: number }>;
    questions: Array<{ id: string; deckId: string | null; isSubAccessible?: boolean }>;
  };

  // Downgrade seenVersion from 2 to 1 & inject forged private deck subscription + forged isSubAccessible private questionId
  for (const s of subBackup.subscriptions) {
    if (s.deckId === pubDeckId) s.seenVersion = 1;
  }
  subBackup.subscriptions.push({
    deckId: privDeckId,
    seenVersion: 1,
    dismissedVersion: 0,
  });
  subBackup.questions.push({
    id: qPrivId,
    deckId: privDeckId,
    isSubAccessible: true,
    title: "绝密私题",
    answer: "伪造访问",
    tags: [],
    archived: false,
    favorite: false,
    note: "",
    noteVersion: 0,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dueAt: new Date().toISOString(),
    state: "new",
    lastRating: null,
    lastReviewedAt: null,
    reps: 0,
    lapses: 0,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    annotations: [],
    annotationsVersion: 0,
    isOwner: false,
    studyVersion: 0,
    reviewedRevision: 1,
    fsrs: null,
  } as never);

  const cleanSub = await register("bk-clean-sub");
  const cleanSubRestore = await restoreRoute.POST(
    makeReq(cleanSub, "/api/backup/restore", subBackup),
  );
  assert.equal(cleanSubRestore.status, 200);
  const cleanSubWs = await fetchWorkspace(cleanSub);
  const pinnedSub = cleanSubWs.decks.find((d) => d.id === pubDeckId);
  assert.ok(pinnedSub);
  // New restored subscription is pinned to live publishedVersion (2), never downgraded to 1
  assert.equal(pinnedSub.seenVersion, 2);
  // Forged private deck & private questionId must not appear in subscriber's workspace
  assert.equal(
    cleanSubWs.decks.some((d) => d.id === privDeckId),
    false,
  );
  assert.equal(
    cleanSubWs.questions.some((q) => q.id === qPrivId),
    false,
  );

  // 3. >600 row batched restore test
  const largeOwner = await register("bk-large");
  const largeBackup = structuredClone(authorBackup) as {
    decks: Array<{ id: string }>;
    questions: Array<Record<string, unknown>>;
    studyCards?: Array<Record<string, unknown>>;
    reviewEvents?: Array<Record<string, unknown>>;
    releases: unknown[];
  };
  largeBackup.releases = [];
  const templateQ = largeBackup.questions[0];
  assert.ok(templateQ);
  const extraQuestions: Array<Record<string, unknown>> = [templateQ];
  for (let i = 0; i < 619; i++) {
    extraQuestions.push({
      ...structuredClone(templateQ),
      id: randomUUID(),
      title: `大批量恢复题目 #${i + 1}`,
      position: i + 1,
    });
  }
  largeBackup.questions = extraQuestions;
  const largeRes = await restoreRoute.POST(
    makeReq(largeOwner, "/api/backup/restore", largeBackup),
  );
  const largeJson = (await largeRes.json()) as {
    restored?: { questions: number };
  };
  assert.equal(largeRes.status, 200, JSON.stringify(largeJson));
  assert.equal(largeJson.restored?.questions, 620);
});

test("unpublish blocks pending subscription updates and private authors return 404", async () => {
  const author = await register("up-author");
  const follower = await register("up-follower");
  const privateOnly = await register("priv-only");

  // privateOnly only has a private deck
  await decksRoute.POST(
    makeReq(privateOnly, "/api/decks", { action: "create", title: "纯私有" }),
  );
  const followPrivRes = await authorsRoute.POST(
    makeReq(follower, "/api/authors", {
      action: "follow",
      authorId: privateOnly.id,
    }),
  );
  assert.equal(followPrivRes.status, 404);
  const subAllPrivRes = await authorsRoute.POST(
    makeReq(follower, "/api/authors", {
      action: "subscribeAll",
      authorId: privateOnly.id,
    }),
  );
  assert.equal(subAllPrivRes.status, 404);

  // Author creates & publishes deck v1 -> follower subscribes -> author updates v2 -> author unpublishes
  const dRes = await decksRoute.POST(
    makeReq(author, "/api/decks", { action: "create", title: "撤回发布测试" }),
  );
  const deckId = ((await dRes.json()) as { id: string }).id;
  await questionsRoute.POST(
    makeReq(author, "/api/questions", {
      action: "create",
      deckId,
      title: "初版题",
      answer: "初版答",
    }),
  );
  await decksRoute.POST(
    makeReq(author, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 0,
      visibility: "public",
    }),
  );
  await decksRoute.POST(
    makeReq(follower, "/api/decks", { action: "subscribe", deckId }),
  );
  await questionsRoute.POST(
    makeReq(author, "/api/questions", {
      action: "create",
      deckId,
      title: "二版新题",
      answer: "二版新答",
    }),
  );
  await decksRoute.POST(
    makeReq(author, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 1,
      visibility: "public",
    }),
  );
  const unpub = await decksRoute.POST(
    makeReq(author, "/api/decks", { action: "unpublish", deckId }),
  );
  assert.equal(unpub.status, 200);

  // Follower applyUpdate must reject and applyAllUpdates must update 0 rows
  const applyOne = await decksRoute.POST(
    makeReq(follower, "/api/decks", { action: "applyUpdate", deckId }),
  );
  assert.notEqual(applyOne.status, 200);
  const applyAll = await decksRoute.POST(
    makeReq(follower, "/api/decks", {
      action: "applyAllUpdates",
      deckIds: [deckId],
    }),
  );
  assert.equal(applyAll.status, 200);
  const applyAllJson = (await applyAll.json()) as { updated: number };
  assert.equal(applyAllJson.updated, 0);
});

test("crypto rejects truncated GCM tag and malformed payloads; ai-transport blocks ::/96 and localhost.", async () => {
  const encrypted = encryptKey("sk-live-secret-value", "user-crypto-1");
  assert.equal(decryptKey(encrypted, "user-crypto-1"), "sk-live-secret-value");

  const parts = encrypted.split(".");
  assert.equal(parts.length, 4);
  // Truncate 16-byte tag down to 8 bytes
  assert.throws(() =>
    decryptKey(
      `${parts[0]}.${parts[1]}.${parts[2].slice(0, 11)}.${parts[3]}`,
      "user-crypto-1",
    ),
  );
  // Drop version prefix -> invalid 3-part format
  assert.throws(() => decryptKey(parts.slice(1).join("."), "user-crypto-1"));

  assert.equal(isPublicAiAddress("::127.0.0.1"), false);
  assert.equal(isPublicAiAddress("::10.0.0.1"), false);
  assert.equal(isPublicAiAddress("::192.168.1.5"), false);
  assert.equal(isPublicAiAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAiAddress("93.184.216.34"), true);

  assert.throws(() => assertAiHostname("localhost."));
  assert.throws(() => assertAiHostname("service.local."));

  clearAiTransportCaches();
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const fetcher = mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  try {
    const r1 = await aiFetch(new URL("https://api.openai.com/v1/models"), {
      method: "GET",
    });
    const r2 = await aiFetch(new URL("https://api.openai.com/v1/models"), {
      method: "GET",
    });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(fetcher.mock.callCount(), 2);
  } finally {
    fetcher.mock.restore();
    resolver.mock.restore();
  }
});

test("redis SecondaryStorage contract, OTP quota, login failure throttle, and production HTTPS check", async () => {
  const kv = new Map<string, string>();
  const mockRedis = {
    async get(key: string) {
      return kv.get(key) ?? null;
    },
    async set(key: string, value: string, _mode?: string, _ttl?: number) {
      kv.set(key, value);
      return "OK";
    },
    async del(key: string) {
      return kv.delete(key) ? 1 : 0;
    },
    async getdel(key: string) {
      const val = kv.get(key) ?? null;
      kv.delete(key);
      return val;
    },
    async eval(_script: string, _numKeys: number, key: string) {
      const next = Number(kv.get(key) ?? "0") + 1;
      kv.set(key, String(next));
      return next;
    },
  } as unknown as Redis;

  const storage = createBetterAuthSecondaryStorage(mockRedis);
  await storage.set("session:1", "payload", 60);
  assert.equal(await storage.get("session:1"), "payload");
  assert.equal(await storage.getAndDelete("session:1"), "payload");
  assert.equal(await storage.get("session:1"), null);
  await storage.set("session:2", "val");
  await storage.delete("session:2");
  assert.equal(await storage.get("session:2"), null);
  assert.equal(await storage.increment("ip:1", 60), 1);
  assert.equal(await storage.increment("ip:1", 60), 2);

  // OTP email cooldown (in-memory fallback when REDIS_URL is unset)
  const quotaEmail = `quota-${randomUUID().slice(0, 8)}@example.com`;
  await checkOtpEmailQuota(quotaEmail);
  await assert.rejects(
    () => checkOtpEmailQuota(quotaEmail),
    (err: { status?: number }) => err.status === 429,
  );

  // Per-email login failure throttle (5 fails)
  const throttleEmail = `lock-${randomUUID().slice(0, 8)}@example.com`;
  assert.equal(await isLoginEmailThrottled(throttleEmail), false);
  for (let i = 0; i < 4; i++) {
    await recordLoginFailure(throttleEmail);
    assert.equal(await isLoginEmailThrottled(throttleEmail), false);
  }
  await recordLoginFailure(throttleEmail);
  assert.equal(await isLoginEmailThrottled(throttleEmail), true);
  await clearLoginFailure(throttleEmail);
  assert.equal(await isLoginEmailThrottled(throttleEmail), false);

  // Production HTTPS validation across BETTER_AUTH_TRUSTED_ORIGINS
  const validProdEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://u:p@db:5432/app",
    BETTER_AUTH_SECRET: "a".repeat(64),
    KEY_ENCRYPTION_SECRET: "b".repeat(64),
    BETTER_AUTH_URL: "https://app.example.com",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://sub.example.com,http://localhost:3000",
  };
  assert.doesNotThrow(() => validateProductionEnvironment(validProdEnv));
  assert.throws(
    () =>
      validateProductionEnvironment({
        ...validProdEnv,
        BETTER_AUTH_TRUSTED_ORIGINS: "http://insecure.example.com",
      }),
    /HTTPS/,
  );
});

test("Turnstile captcha enforcement, weak password blacklist, and /api/auth-config", async () => {
  const auth = await getAuth();
  // Weak password rejected even without Turnstile
  const weakRes = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-forwarded-for": `198.51.100.${++ipCounter}`,
      },
      body: JSON.stringify({
        name: "weak",
        email: `weak-${randomUUID().slice(0, 8)}@hardening.test`,
        password: "password",
      }),
    }),
  );
  assert.equal(weakRes.status, 400);

  const prevSiteKey = process.env.TURNSTILE_SITE_KEY;
  const prevSecret = process.env.TURNSTILE_SECRET_KEY;
  const originalFetch = globalThis.fetch;

  const siteverifyMock = mock.method(
    globalThis,
    "fetch",
    async (input: URL | string | Request, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target.includes("challenges.cloudflare.com")) {
        return Response.json({ success: true, hostname: "localhost" });
      }
      return originalFetch(input, init);
    },
  );

  try {
    process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";
    resetAuthForTests();

    const cfgRes = authConfigRoute.GET();
    assert.equal(cfgRes.status, 200);
    const cfg = (await cfgRes.json()) as { turnstileSiteKey: string | null };
    assert.equal(cfg.turnstileSiteKey, "test-turnstile-site-key");

    const captchaAuth = await getAuth();
    // Missing captcha token must be blocked
    const noCap = await captchaAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          "x-forwarded-for": `198.51.100.${++ipCounter}`,
        },
        body: JSON.stringify({
          name: "nocap",
          email: `nocap-${randomUUID().slice(0, 8)}@hardening.test`,
          password: `Str0ng!Pass-${randomUUID()}`,
        }),
      }),
    );
    assert.notEqual(noCap.status, 200);

    // Valid captcha token passes mocked Turnstile verification
    const withCap = await captchaAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          "x-forwarded-for": `198.51.100.${++ipCounter}`,
          "x-captcha-response": "valid-turnstile-token",
        },
        body: JSON.stringify({
          name: "withcap",
          email: `withcap-${randomUUID().slice(0, 8)}@hardening.test`,
          password: `Str0ng!Pass-${randomUUID()}`,
        }),
      }),
    );
    assert.equal(withCap.status, 200);
    assert.ok(siteverifyMock.mock.callCount() >= 1);
  } finally {
    siteverifyMock.mock.restore();
    if (prevSiteKey === undefined) delete process.env.TURNSTILE_SITE_KEY;
    else process.env.TURNSTILE_SITE_KEY = prevSiteKey;
    if (prevSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = prevSecret;
    resetAuthForTests();
  }
});

test("workspace_version ETag invalidation/304, accessibleQuestion release query, concept GIN sync, and single-pass annotations", async () => {
  const owner = await register("perf-owner");
  const reader = await register("perf-reader");

  const ws1 = await workspaceRoute.GET(makeReq(owner, "/api/workspace"));
  assert.equal(ws1.status, 200);
  const etag1 = ws1.headers.get("etag");
  assert.ok(etag1);

  const ws304 = await workspaceRoute.GET(
    makeReq(owner, "/api/workspace", undefined, { "If-None-Match": etag1 }),
  );
  assert.equal(ws304.status, 304);

  const wsData1 = (await ws1.json()) as Workspace;
  const deckId = wsData1.decks[0].id;

  // Mutate via /api/questions create -> returns X-Workspace-ETag matching next /api/workspace ETag
  const qRes = await questionsRoute.POST(
    makeReq(owner, "/api/questions", {
      action: "create",
      deckId,
      title: "核心索引题目",
      answer: "这是第一段核心原理文本，后面还有核心重复片段。",
    }),
  );
  assert.equal(qRes.status, 200);
  const nextEtag = qRes.headers.get("x-workspace-etag");
  assert.ok(nextEtag);
  assert.notEqual(nextEtag, etag1);

  const wsOldTag = await workspaceRoute.GET(
    makeReq(owner, "/api/workspace", undefined, { "If-None-Match": etag1 }),
  );
  assert.equal(wsOldTag.status, 200);

  const wsNewTag304 = await workspaceRoute.GET(
    makeReq(owner, "/api/workspace", undefined, { "If-None-Match": nextEtag }),
  );
  assert.equal(wsNewTag304.status, 304);

  const qId = ((await qRes.json()) as { id: string }).id;

  // Publish + subscribe + verify accessibleQuestion uses jsonb_path_query_first accurately
  await decksRoute.POST(
    makeReq(owner, "/api/decks", {
      action: "publish",
      deckId,
      expectedVersion: 0,
      visibility: "public",
    }),
  );
  await decksRoute.POST(
    makeReq(reader, "/api/decks", { action: "subscribe", deckId }),
  );
  const acc = await accessibleQuestion(reader.id, qId);
  assert.equal(acc.title, "核心索引题目");
  assert.equal(
    acc.answer,
    "这是第一段核心原理文本，后面还有核心重复片段。",
  );

  // Add annotation linked to concept, edit concept, verify GIN @> sync updates annotation
  const annRes = await questionsRoute.POST(
    makeReq(owner, "/api/questions", {
      action: "addAnnotation",
      id: qId,
      quote: "核心原理",
      comment: "旧释义",
      color: "accent",
      saveAsConcept: true,
    }),
  );
  assert.equal(annRes.status, 200);
  const ownerWsAfterAnn = await fetchWorkspace(owner);
  const concept = ownerWsAfterAnn.concepts.find((c) => c.term === "核心原理");
  assert.ok(concept);

  const editConceptRes = await conceptsRoute.POST(
    makeReq(owner, "/api/concepts", {
      action: "edit",
      id: concept.id,
      definition: "更新后的 GIN 同步释义",
      color: "sky",
    }),
  );
  assert.equal(editConceptRes.status, 200);
  const ownerWsSynced = await fetchWorkspace(owner);
  const updatedQ = ownerWsSynced.questions.find((q) => q.id === qId);
  assert.ok(updatedQ);
  const linkedAnn = updatedQ.annotations.find((a) => a.conceptId === concept.id);
  assert.ok(linkedAnn);
  assert.equal(linkedAnn.comment, "更新后的 GIN 同步释义");
  assert.equal(linkedAnn.color, "sky");

  // Single-pass applyAnnotationHighlights with overlapping/repeated substrings on one Text node
  const doc = new StubDocument();
  const root = doc.createElement("div");
  const p = doc.createElement("p");
  p.appendChild(doc.createTextNode("alpha beta and trailing alpha end"));
  root.appendChild(p);
  const originalText = root.textContent;
  const now = new Date().toISOString();
  const highlights: QuestionAnnotation[] = [
    {
      id: "h1",
      quote: "alpha beta",
      comment: "first span",
      color: "amber",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "h2",
      quote: "alpha",
      comment: "must match trailing alpha without overlapping h1",
      color: "sky",
      createdAt: now,
      updatedAt: now,
    },
  ];
  const { matchedIds, cleanup } = applyAnnotationHighlights(
    root as unknown as HTMLElement,
    highlights,
    "h1",
  );
  assert.deepEqual([...matchedIds], ["h1", "h2"]);
  assert.equal(root.textContent, originalText);
  const marks = root.collectMarks();
  assert.equal(marks.length, 2);
  assert.equal(marks[0].textContent, "alpha beta");
  assert.equal(marks[1].textContent, "alpha");
  cleanup();
  assert.equal(root.collectMarks().length, 0);
  assert.equal(root.textContent, originalText);
});

test("deploy nginx-tunnel.conf enforces loopback listener, Cloudflare real-IP headers, and route limits", async () => {
  const conf = await readFile(path.resolve("deploy/nginx-tunnel.conf"), "utf8");
  assert.match(conf, /listen\s+127\.0\.0\.1:8080;/);
  assert.match(conf, /set_real_ip_from\s+127\.0\.0\.1;/);
  assert.match(conf, /set_real_ip_from\s+::1;/);
  assert.match(conf, /real_ip_header\s+CF-Connecting-IP;/);
  assert.match(conf, /proxy_set_header\s+X-Forwarded-Proto\s+https;/);
  assert.match(conf, /client_max_body_size\s+1m;/);
  assert.match(
    conf,
    /location\s*=\s*\/api\/backup\/restore\s*\{[\s\S]*?client_max_body_size\s+21m;/,
  );
  assert.match(
    conf,
    /location\s*=\s*\/api\/chat\s*\{[\s\S]*?proxy_buffering\s+off;/,
  );
});

test("CSS architecture keeps unified page widths and zero-specificity global input defaults to prevent double focus rings", async () => {
  const globalsCss = await readFile(path.resolve("src/app/globals.css"), "utf8");
  assert.match(globalsCss, /--page-max-width:\s*1440px;/);
  assert.match(globalsCss, /\.page\s*\{[^}]*max-width:\s*var\(--page-max-width\);/);
  assert.match(
    globalsCss,
    /\.app-footer\s*\{[^}]*max-width:\s*var\(--page-max-width\);/,
  );
  const libShellMatch = globalsCss.match(/\.library-shell\s*\{[^}]*\}/);
  assert.ok(libShellMatch);
  assert.doesNotMatch(libShellMatch[0], /max-width:/);
  assert.match(
    globalsCss,
    /:where\(\s*input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\):focus,\s*textarea:focus\s*\)/,
  );
  assert.match(globalsCss, /\.ai-launcher-search:focus-within\s*\{/);
});

test("next.config.ts CSP allows unsafe-eval only outside production", async () => {
  const nextConfig = (await import("../next.config")).default;
  const prevEnv = process.env.NODE_ENV;
  try {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    const devHeaders = (await nextConfig.headers!())[0].headers;
    const devCsp = devHeaders.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    assert.ok(devCsp.includes("'unsafe-eval'"), devCsp);
    assert.ok(devCsp.includes("ws: wss:"), devCsp);

    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const prodHeaders = (await nextConfig.headers!())[0].headers;
    const prodCsp = prodHeaders.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    assert.ok(!prodCsp.includes("'unsafe-eval'"), prodCsp);
    assert.ok(!prodCsp.includes("ws:"), prodCsp);
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prevEnv;
  }
});
