import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import type { QuestionAnnotation, Workspace } from "../src/lib/types";
import {
  ANNOTATION_COLORS,
  applyAnnotationHighlights,
  normalizeAnnotationQuote,
  readAnnotationSidebarPref,
  readReviewCompareLayoutPref,
} from "../src/lib/annotations";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOCAL_DATABASE_PATH: ":memory:",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  KEY_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
});
delete process.env.DATABASE_URL;
delete process.env.PGHOST;

const { getAuth } = await import("../src/server/auth");
const healthRoute = await import("../src/app/api/health/route");
const workspaceRoute = await import("../src/app/api/workspace/route");
const decksRoute = await import("../src/app/api/decks/route");
const questionsRoute = await import("../src/app/api/questions/route");
const exportRoute = await import("../src/app/api/export/route");

type Account = { id: string; cookie: string; deckId: string };
let alice: Account;
let bob: Account;
let charlie: Account;

function req(
  account: Account | null,
  urlPath: string,
  body?: unknown,
  origin = "http://localhost:3000",
) {
  return new Request(`http://localhost:3000${urlPath}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(account
        ? { cookie: account.cookie, "x-workspace-user": account.id }
        : {}),
      ...(origin ? { origin } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function state(account: Account): Promise<Workspace> {
  const res = await workspaceRoute.GET(req(account, "/api/workspace"));
  assert.equal(res.status, 200);
  return res.json();
}

async function register(name: string): Promise<Account> {
  const r = await (
    await getAuth()
  ).handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name,
        email: `${name}@annotations.test`,
        password: randomUUID(),
      }),
    }),
  );
  assert.equal(r.status, 200);
  const result = await r.json();
  const account: Account = {
    id: result.user.id,
    cookie: r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    deckId: "",
  };
  account.deckId = (await state(account)).decks[0].id;
  return account;
}

// Lightweight pure-JS DOM stub for testing applyAnnotationHighlights in Node.
class MockNode {
  parentNode: MockElement | null = null;
  ownerDocument: MockDocument;
  constructor(
    public nodeType: number,
    ownerDocument: MockDocument,
  ) {
    this.ownerDocument = ownerDocument;
  }
  get nextSibling(): MockNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 && idx + 1 < this.parentNode.childNodes.length
      ? this.parentNode.childNodes[idx + 1]
      : null;
  }
}

class MockText extends MockNode {
  constructor(
    public nodeValue: string,
    ownerDocument: MockDocument,
  ) {
    super(3, ownerDocument);
  }
  get length() {
    return this.nodeValue.length;
  }
  splitText(offset: number): MockText {
    const rest = new MockText(this.nodeValue.slice(offset), this.ownerDocument);
    this.nodeValue = this.nodeValue.slice(0, offset);
    if (this.parentNode) {
      const idx = this.parentNode.childNodes.indexOf(this);
      rest.parentNode = this.parentNode;
      this.parentNode.childNodes.splice(idx + 1, 0, rest);
    }
    return rest;
  }
}

class MockElement extends MockNode {
  childNodes: MockNode[] = [];
  className = "";
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  tabIndex = -1;
  tagName: string;
  constructor(tagName: string, ownerDocument: MockDocument) {
    super(1, ownerDocument);
    this.tagName = tagName.toUpperCase();
  }
  get firstChild(): MockNode | null {
    return this.childNodes[0] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  appendChild<T extends MockNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends MockNode>(child: T, ref: MockNode | null): T {
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
  removeChild<T extends MockNode>(child: T): T {
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
      if (cur instanceof MockText) {
        if (!cur.nodeValue) {
          this.removeChild(cur);
          continue;
        }
        const next = this.childNodes[i + 1];
        if (next instanceof MockText) {
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
        c instanceof MockText
          ? c.nodeValue
          : c instanceof MockElement
            ? c.textContent
            : "",
      )
      .join("");
  }
  collectMarks(): MockElement[] {
    const out: MockElement[] = [];
    for (const child of this.childNodes) {
      if (child instanceof MockElement) {
        if (child.tagName === "MARK") out.push(child);
        out.push(...child.collectMarks());
      }
    }
    return out;
  }
}

class MockDocument {
  createElement(tag: string) {
    return new MockElement(tag, this);
  }
  createTextNode(text: string) {
    return new MockText(text, this);
  }
}

before(async () => {
  // Verify GET /api/health passes on 0-row DB covering sc.annotations & sc.annotations_version.
  const h = await healthRoute.GET();
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { status: "ok" });

  alice = await register("ann-alice");
  bob = await register("ann-bob");
  charlie = await register("ann-charlie");
});

test("0013_annotations migration succeeds cleanly on fresh DB and 0012 -> 0013 upgrade", async () => {
  // Fresh migration run from 0000..0013
  const fresh = new PGlite();
  const freshDb = drizzle(fresh, { schema });
  await migrate(freshDb, { migrationsFolder: path.resolve("drizzle") });
  const freshCols = await fresh.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'study_cards' AND column_name IN ('annotations', 'annotations_version') ORDER BY column_name`,
  );
  assert.deepEqual(
    freshCols.rows.map((r) => r.column_name),
    ["annotations", "annotations_version"],
  );
  await fresh.close();

  // Upgrade from 0000..0012 with existing study_cards data
  const upgraded = new PGlite();
  const journal = JSON.parse(
    await readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  for (const entry of journal.entries) {
    if (entry.idx > 12) break;
    const raw = await readFile(
      path.resolve("drizzle", `${entry.tag}.sql`),
      "utf8",
    );
    for (const stmt of raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await upgraded.exec(stmt);
    }
  }
  await upgraded.exec(`
    INSERT INTO users (id, name, email) VALUES ('u1', 'A', 'a@ann.t');
    INSERT INTO decks (id, owner_id, title) VALUES ('d1', 'u1', 'Deck1');
    INSERT INTO questions (id, owner_id, deck_id, title, answer, content_hash)
      VALUES ('q1', 'u1', 'd1', 'Q1', 'A1', 'hash1');
    INSERT INTO study_cards (user_id, question_id, favorite, note, note_version)
      VALUES ('u1', 'q1', true, '已有笔记', 2);
  `);

  const mig13 = await readFile(
    path.resolve("drizzle/0013_annotations.sql"),
    "utf8",
  );
  for (const stmt of mig13
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await upgraded.exec(stmt);
  }

  const card = (
    await upgraded.query(
      `SELECT favorite, note, note_version, annotations, annotations_version FROM study_cards WHERE user_id = 'u1' AND question_id = 'q1'`,
    )
  ).rows[0] as {
    favorite: boolean;
    note: string;
    note_version: number;
    annotations: unknown;
    annotations_version: number;
  };
  assert.equal(card.favorite, true);
  assert.equal(card.note, "已有笔记");
  assert.equal(card.note_version, 2);
  assert.deepEqual(card.annotations, []);
  assert.equal(card.annotations_version, 0);
  await upgraded.close();
});

test("pure annotations highlight matcher handles inline elements, skipped code/katex, unmatched quotes, and idempotent reversible cleanup", () => {
  assert.equal(ANNOTATION_COLORS.length, 4);
  assert.equal(normalizeAnnotationQuote("  核心\n\t  原理  "), "核心 原理");
  // SSR-safe preference defaults
  assert.equal(readAnnotationSidebarPref("u1"), false);
  assert.equal(readReviewCompareLayoutPref(), "split");

  const doc = new MockDocument();
  const root = doc.createElement("div");

  // <p>这是<strong>核心原理</strong>和细节</p>
  const p1 = doc.createElement("p");
  p1.appendChild(doc.createTextNode("这是"));
  const strong = doc.createElement("strong");
  strong.appendChild(doc.createTextNode("核心原理"));
  p1.appendChild(strong);
  p1.appendChild(doc.createTextNode("和细节"));
  root.appendChild(p1);

  // <p>使用 <code>useMemo</code> 缓存结果</p>
  const p2 = doc.createElement("p");
  p2.appendChild(doc.createTextNode("使用 "));
  const code = doc.createElement("code");
  code.appendChild(doc.createTextNode("useMemo"));
  p2.appendChild(code);
  p2.appendChild(doc.createTextNode(" 缓存结果"));
  root.appendChild(p2);

  // <span class="katex">O(n)</span>
  const katex = doc.createElement("span");
  katex.className = "katex";
  katex.appendChild(doc.createTextNode("O(n)"));
  root.appendChild(katex);

  const originalText = root.textContent;
  const now = "2026-04-01T00:00:00.000Z";
  const anns: QuestionAnnotation[] = [
    {
      id: "a1",
      quote: "核心原理和细节",
      comment: "跨 inline 元素命中",
      color: "amber",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "a2",
      quote: "useMemo",
      comment: "code 中内容不应被包裹",
      color: "sky",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "a3",
      quote: "使用 缓存结果",
      comment: "不应跨越 code 伪命中",
      color: "rose",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "a4",
      quote: "O(n)",
      comment: "katex 不应被包裹",
      color: "accent",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "a5",
      quote: "",
      comment: "整题通用批注",
      color: "accent",
      createdAt: now,
      updatedAt: now,
    },
  ];

  const { matchedIds, cleanup } = applyAnnotationHighlights(
    root as unknown as HTMLElement,
    anns,
    "a1",
  );
  assert.deepEqual([...matchedIds], ["a1"]);

  const marks = root.collectMarks();
  assert.equal(marks.length, 2); // split across <strong> and trailing text node
  assert.equal(marks.map((m) => m.textContent).join(""), "核心原理和细节");
  for (const m of marks) {
    assert.equal(m.dataset.annotationId, "a1");
    assert.ok(m.className.includes("prose-annotation-mark"));
    assert.ok(m.className.includes("color-amber"));
    assert.ok(m.className.includes("is-active"));
    assert.equal(m.getAttribute("role"), "button");
    assert.equal(m.getAttribute("aria-label"), "查看批注");
    assert.equal(m.tabIndex, 0);
  }
  assert.equal(root.textContent, originalText);

  // Reversible & idempotent cleanup
  cleanup();
  assert.equal(root.collectMarks().length, 0);
  assert.equal(root.textContent, originalText);
  assert.equal(strong.childNodes.length, 1);
  cleanup(); // safe to call twice
  assert.equal(root.collectMarks().length, 0);
  assert.equal(root.textContent, originalText);
});

test("annotations CRUD on owned & subscribed questions, tenant/IDOR isolation, max-50 cap, validation, and export inclusion", async () => {
  // 1. Alice creates a public deck with a question and a private deck with a question.
  const { id: qPublicId } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: alice.deckId,
        title: "React Fiber 架构核心原理",
        answer: "Fiber 将渲染拆分为可中断的小任务单元，配合双缓存树实现并发更新。",
        tags: ["React"],
      }),
    )
  ).json();

  const { deck: privateDeck } = await (
    await decksRoute.POST(
      req(alice, "/api/decks", {
        action: "create",
        title: "私密面经草稿",
        color: "sand",
      }),
    )
  ).json();
  const { id: qPrivateId } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: privateDeck.id,
        title: "私密题目",
        answer: "仅作者可见",
        tags: [],
      }),
    )
  ).json();

  // Publish Alice's default deck and have Bob subscribe.
  assert.equal(
    (
      await decksRoute.POST(
        req(alice, "/api/decks", {
          action: "publish",
          deckId: alice.deckId,
          visibility: "public",
          expectedVersion: 0,
          summary: "v1",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await decksRoute.POST(
        req(bob, "/api/decks", { action: "subscribe", deckId: alice.deckId }),
      )
    ).status,
    200,
  );

  // 2. Owned question CRUD (Alice).
  const addRes1 = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "addAnnotation",
      id: qPublicId,
      quote: "可中断的小任务单元",
      comment: "对比 React 15 同步递归栈",
      color: "amber",
    }),
  );
  assert.equal(addRes1.status, 200);
  const add1 = (await addRes1.json()) as {
    annotation: QuestionAnnotation;
    annotations: QuestionAnnotation[];
    version: number;
  };
  assert.equal(add1.version, 1);
  assert.equal(add1.annotations.length, 1);
  assert.equal(add1.annotation.quote, "可中断的小任务单元");
  assert.equal(add1.annotation.color, "amber");

  const addRes2 = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "addAnnotation",
      id: qPublicId,
      quote: "",
      comment: "面试时画一下 current 与 workInProgress 指针切换",
    }),
  );
  assert.equal(addRes2.status, 200);
  const add2 = await addRes2.json();
  assert.equal(add2.version, 2);
  assert.equal(add2.annotation.color, "accent");
  assert.equal(add2.annotations.length, 2);

  // Edit existing annotation
  const editRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "editAnnotation",
      id: qPublicId,
      annotationId: add1.annotation.id,
      comment: "对比 React 15 栈调和：不可中断导致主线程掉帧",
      color: "sky",
    }),
  );
  assert.equal(editRes.status, 200);
  const edited = await editRes.json();
  assert.equal(edited.version, 3);
  assert.equal(edited.annotation.color, "sky");
  assert.equal(edited.annotation.quote, "可中断的小任务单元");
  assert.equal(
    edited.annotation.comment,
    "对比 React 15 栈调和：不可中断导致主线程掉帧",
  );

  // Edit / delete nonexistent annotationId -> 404
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "editAnnotation",
          id: qPublicId,
          annotationId: randomUUID(),
          comment: "nope",
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "deleteAnnotation",
          id: qPublicId,
          annotationId: randomUUID(),
        }),
      )
    ).status,
    404,
  );

  // Delete 2nd annotation
  const delRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "deleteAnnotation",
      id: qPublicId,
      annotationId: add2.annotation.id,
    }),
  );
  assert.equal(delRes.status, 200);
  const delBody = await delRes.json();
  assert.equal(delBody.version, 4);
  assert.equal(delBody.annotations.length, 1);

  // Verify hydration in Alice's workspace
  const aliceWs = await state(alice);
  const aliceQ = aliceWs.questions.find((q) => q.id === qPublicId)!;
  assert.equal(aliceQ.annotationsVersion, 4);
  assert.equal(aliceQ.annotations.length, 1);
  assert.equal(aliceQ.annotations[0].id, add1.annotation.id);

  // 3. Subscribed question CRUD (Bob) + strict tenant isolation.
  const bobAddRes = await questionsRoute.POST(
    req(bob, "/api/questions", {
      action: "addAnnotation",
      id: qPublicId,
      quote: "双缓存树",
      comment: "Bob 自己的理解：类似图形双缓冲",
      color: "rose",
    }),
  );
  assert.equal(bobAddRes.status, 200);
  const bobAdd = await bobAddRes.json();
  assert.equal(bobAdd.version, 1);
  assert.equal(bobAdd.annotations.length, 1);

  // Bob's workspace sees ONLY Bob's annotation; Alice's sees ONLY Alice's.
  const bobWs = await state(bob);
  const bobQ = bobWs.questions.find((q) => q.id === qPublicId)!;
  assert.equal(bobQ.isOwner, false);
  assert.equal(bobQ.annotations.length, 1);
  assert.equal(bobQ.annotations[0].comment, "Bob 自己的理解：类似图形双缓冲");

  const aliceWsAfterBob = await state(alice);
  assert.equal(
    aliceWsAfterBob.questions.find((q) => q.id === qPublicId)!.annotations
      .length,
    1,
  );
  assert.equal(
    aliceWsAfterBob.questions.find((q) => q.id === qPublicId)!.annotations[0]
      .id,
    add1.annotation.id,
  );

  // Bob cannot edit/delete Alice's annotationId on the shared question (404).
  assert.equal(
    (
      await questionsRoute.POST(
        req(bob, "/api/questions", {
          action: "deleteAnnotation",
          id: qPublicId,
          annotationId: add1.annotation.id,
        }),
      )
    ).status,
    404,
  );

  // 4. IDOR / Unauthorized isolation (Charlie is NOT subscribed and NOT owner -> 404).
  assert.equal(
    (
      await questionsRoute.POST(
        req(charlie, "/api/questions", {
          action: "addAnnotation",
          id: qPublicId,
          quote: "Fiber",
          comment: "未订阅不能批注",
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await questionsRoute.POST(
        req(bob, "/api/questions", {
          action: "addAnnotation",
          id: qPrivateId,
          quote: "",
          comment: "私密题不能越权批注",
        }),
      )
    ).status,
    404,
  );

  // 5. Validation errors (400).
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "addAnnotation",
          id: qPublicId,
          quote: "",
          comment: "   ",
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "addAnnotation",
          id: qPublicId,
          quote: "x".repeat(601),
          comment: "超长摘录",
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "addAnnotation",
          id: qPublicId,
          quote: "",
          comment: "x".repeat(2001),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "addAnnotation",
          id: qPublicId,
          quote: "",
          comment: "非法颜色",
          color: "neon",
        }),
      )
    ).status,
    400,
  );

  // 6. Export inclusion (both workspace questions[] and personalStudyState[]).
  const aliceExport = await (
    await exportRoute.GET(req(alice, "/api/export"))
  ).json();
  const aliceExpQ = aliceExport.questions.find(
    (q: { id: string }) => q.id === qPublicId,
  );
  assert.equal(aliceExpQ.annotations.length, 1);
  assert.equal(aliceExpQ.annotationsVersion, 4);
  const aliceExpCard = aliceExport.personalStudyState.find(
    (c: { questionId: string }) => c.questionId === qPublicId,
  );
  assert.equal(aliceExpCard.annotations.length, 1);
  assert.equal(aliceExpCard.annotations[0].id, add1.annotation.id);

  const bobExport = await (
    await exportRoute.GET(req(bob, "/api/export"))
  ).json();
  const bobExpQ = bobExport.questions.find(
    (q: { id: string }) => q.id === qPublicId,
  );
  assert.equal(bobExpQ.annotations.length, 1);
  assert.equal(bobExpQ.annotations[0].id, bobAdd.annotation.id);

  // 7. Max-50 cap on private question + deleted question returns 404.
  let lastId = "";
  for (let i = 1; i <= 50; i++) {
    const r = await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "addAnnotation",
        id: qPrivateId,
        quote: "",
        comment: `第 ${i} 条批注`,
      }),
    );
    assert.equal(r.status, 200);
    lastId = (await r.json()).annotation.id;
  }
  const overCap = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "addAnnotation",
      id: qPrivateId,
      quote: "",
      comment: "第 51 条批注",
    }),
  );
  assert.equal(overCap.status, 400);

  // Delete one -> adding succeeds again.
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "deleteAnnotation",
          id: qPrivateId,
          annotationId: lastId,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "addAnnotation",
          id: qPrivateId,
          quote: "",
          comment: "补回第 50 条",
        }),
      )
    ).status,
    200,
  );

  // Soft-deleting qPrivateId blocks further annotation writes (404).
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", { action: "delete", id: qPrivateId }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await questionsRoute.POST(
        req(alice, "/api/questions", {
          action: "addAnnotation",
          id: qPrivateId,
          quote: "",
          comment: "已删除题目不可批注",
        }),
      )
    ).status,
    404,
  );
});

after(async () => {
  const dbState = globalThis as unknown as {
    interviewDatabase?: Promise<{ close: () => Promise<void> }>;
  };
  await (await dbState.interviewDatabase)?.close();
});
