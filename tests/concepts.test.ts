import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import type {
  ConceptFolderView,
  ConceptView,
  QuestionAnnotation,
  Workspace,
} from "../src/lib/types";
import {
  CONCEPT_ROOT_LABEL,
  CONCEPT_UNGROUPED_LABEL,
  MAX_CONCEPTS,
  applyConceptLinks,
  buildConceptFolderIndex,
  buildConceptMatcherPattern,
  findConceptMatchesInText,
  findMatchingConcept,
  groupConceptsByName,
  normalizeConceptAliases,
  normalizeConceptKey,
  parseConceptAliasesInput,
  readConceptLinksPref,
  recomputeConceptFolderState,
  writeConceptLinksPref,
} from "../src/lib/concepts";
import {
  addQuestionAnnotation,
  createConcept,
  createConceptFolder,
  deleteConcept,
  deleteConceptFolder,
  dissolveConceptFolder,
  editConcept,
  editConceptFolder,
  editQuestionAnnotation,
  groupIntoNewConceptFolder,
  importConceptsFromAnnotations,
  moveConceptFolder,
  moveConceptsToFolder,
  moveConceptsToGroup,
  renameConceptGroup,
  type WorkspaceMutate,
} from "../src/lib/client";
import { applyLocalWorkspacePatch } from "../src/components/use-workspace-sync";

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
const workspaceRoute = await import("../src/app/api/workspace/route");
const decksRoute = await import("../src/app/api/decks/route");
const questionsRoute = await import("../src/app/api/questions/route");
const conceptsRoute = await import("../src/app/api/concepts/route");
const exportRoute = await import("../src/app/api/export/route");
const restoreRoute = await import("../src/app/api/backup/restore/route");

type Account = { id: string; cookie: string; deckId: string };
let alice: Account;
let bob: Account;
let charlie: Account;
let ipCounter = 10;

function req(
  account: Account | null,
  urlPath: string,
  body?: unknown,
  options?: { origin?: string; headers?: Record<string, string> },
) {
  const origin = options?.origin ?? "http://localhost:3000";
  return new Request(`http://localhost:3000${urlPath}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(account
        ? { cookie: account.cookie, "x-workspace-user": account.id }
        : {}),
      ...(origin ? { origin } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options?.headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function getWs(account: Account): Promise<Workspace> {
  const res = await workspaceRoute.GET(req(account, "/api/workspace"));
  assert.equal(res.status, 200);
  return res.json();
}

async function getEtag(account: Account): Promise<string> {
  const res = await workspaceRoute.GET(req(account, "/api/workspace"));
  assert.equal(res.status, 200);
  const etag = res.headers.get("etag");
  assert.ok(etag);
  return etag;
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
        "x-forwarded-for": `198.51.117.${++ipCounter}`,
      },
      body: JSON.stringify({
        name,
        email: `${name}@concepts.test`,
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
  account.deckId = (await getWs(account)).decks[0].id;
  return account;
}

// Lightweight pure-JS DOM stub for testing applyConceptLinks in Node.
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
  collectConceptLinks(): MockElement[] {
    const out: MockElement[] = [];
    for (const child of this.childNodes) {
      if (child instanceof MockElement) {
        if (child.className.split(/\s+/).includes("prose-concept-link")) {
          out.push(child);
        }
        out.push(...child.collectConceptLinks());
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

function makeConcept(partial: Partial<ConceptView> & { id: string; term: string }): ConceptView {
  const now = "2026-04-01T00:00:00.000Z";
  return {
    aliases: [],
    normalizedKey: normalizeConceptKey(partial.term),
    definition: `${partial.term} 释义`,
    folderId: null,
    folderPath: CONCEPT_ROOT_LABEL,
    groupName: "",
    color: "accent",
    sourceQuestionId: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

before(async () => {
  alice = await register("concept-alice");
  bob = await register("concept-bob");
  charlie = await register("concept-charlie");
});

test("0017_concepts migration runs cleanly on fresh DB and upgrades 0016 -> 0017 with indexes & FK semantics", async () => {
  // 1. Fresh DB via Drizzle migrate
  const fresh = new PGlite();
  const freshDb = drizzle(fresh, { schema });
  await migrate(freshDb, { migrationsFolder: path.resolve("drizzle") });

  const cols = await fresh.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'concepts' ORDER BY column_name`,
  );
  assert.deepEqual(
    cols.rows.map((r) => r.column_name),
    [
      "aliases",
      "color",
      "created_at",
      "definition",
      "folder_id",
      "group_name",
      "id",
      "normalized_key",
      "source_question_id",
      "term",
      "updated_at",
      "user_id",
    ],
  );

  const idxs = await fresh.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'concepts' ORDER BY indexname`,
  );
  assert.ok(idxs.rows.some((r) => r.indexname === "concept_user_group_idx"));
  assert.ok(idxs.rows.some((r) => r.indexname === "concept_user_norm_key_uniq"));

  // Enforce unique (user_id, normalized_key), allow different users to share normalized_key,
  // and verify ON DELETE SET NULL on source_question_id & ON DELETE CASCADE on user_id.
  await fresh.exec(`
    INSERT INTO users (id, name, email) VALUES ('u1', 'A', 'a@c.t'), ('u2', 'B', 'b@c.t');
    INSERT INTO decks (id, owner_id, title) VALUES ('d1', 'u1', 'Deck');
    INSERT INTO questions (id, owner_id, deck_id, title, answer, content_hash)
      VALUES ('q1', 'u1', 'd1', 'Q1', 'A1', 'h1');
    INSERT INTO concepts (id, user_id, term, normalized_key, definition, source_question_id)
      VALUES ('c1', 'u1', 'Cross-Encoder', 'cross encoder', 'def1', 'q1');
    INSERT INTO concepts (id, user_id, term, normalized_key, definition)
      VALUES ('c2', 'u2', 'Cross-Encoder', 'cross encoder', 'def2');
  `);
  await assert.rejects(
    () =>
      fresh.exec(
        `INSERT INTO concepts (id, user_id, term, normalized_key, definition) VALUES ('c3', 'u1', 'cross encoder', 'cross encoder', 'dup')`,
      ),
    /unique|duplicate/i,
  );
  await fresh.exec(`DELETE FROM questions WHERE id = 'q1'`);
  const afterQDel = await fresh.query<{ source_question_id: string | null }>(
    `SELECT source_question_id FROM concepts WHERE id = 'c1'`,
  );
  assert.equal(afterQDel.rows[0].source_question_id, null);

  await fresh.exec(`DELETE FROM users WHERE id = 'u2'`);
  const afterUDel = await fresh.query<{ id: string }>(
    `SELECT id FROM concepts WHERE user_id = 'u2'`,
  );
  assert.equal(afterUDel.rows.length, 0);
  await fresh.close();

  // 2. Upgrade from 0000..0016 -> 0017 (and idempotent re-run)
  const upgraded = new PGlite();
  const journal = JSON.parse(
    await readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  for (const entry of journal.entries) {
    if (entry.idx > 16) break;
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
  await upgraded.exec(
    `INSERT INTO users (id, name, email) VALUES ('u0', 'Existing', 'u0@c.t')`,
  );
  const mig17 = await readFile(
    path.resolve("drizzle/0017_concepts.sql"),
    "utf8",
  );
  for (let pass = 0; pass < 2; pass++) {
    for (const stmt of mig17
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await upgraded.exec(stmt);
    }
  }
  const userCheck = await upgraded.query<{ id: string }>(
    `SELECT id FROM users WHERE id = 'u0'`,
  );
  assert.equal(userCheck.rows.length, 1);
  await upgraded.close();
});

test("concept key normalization, flexible matching, strict ASCII boundaries, CJK adjacency, and longest-match-first", () => {
  assert.equal(MAX_CONCEPTS, 500);
  assert.equal(CONCEPT_UNGROUPED_LABEL, "未分组");

  // Normalization equivalence
  assert.equal(normalizeConceptKey("Cross-Encoder"), "cross encoder");
  assert.equal(normalizeConceptKey("cross encoder"), "cross encoder");
  assert.equal(normalizeConceptKey("CROSS_ENCODER"), "cross encoder");
  assert.equal(normalizeConceptKey("Cross–Encoder"), "cross encoder");
  assert.equal(normalizeConceptKey("Cross—Encoder"), "cross encoder");
  assert.equal(normalizeConceptKey("Cross·Encoder"), "cross encoder");
  assert.equal(normalizeConceptKey("  Cross   Encoder  "), "cross encoder");
  assert.equal(normalizeConceptKey("大 Key"), "大key");
  assert.equal(normalizeConceptKey("大Key"), "大key");
  assert.equal(normalizeConceptKey("大-Key"), "大key");
  assert.equal(normalizeConceptKey("Redis 缓存"), "redis缓存");
  assert.equal(normalizeConceptKey("Redis缓存"), "redis缓存");
  assert.equal(normalizeConceptKey("   ---   "), "");

  // Alias normalization & input parsing
  assert.deepEqual(
    normalizeConceptAliases(["交叉编码器", "cross encoder", "CE", "ce", " "], "Cross-Encoder"),
    ["交叉编码器", "CE"],
  );
  assert.deepEqual(
    parseConceptAliasesInput("交叉编码器，CE; Cross-Encoder,  重排器 ", "Cross-Encoder"),
    ["交叉编码器", "CE", "重排器"],
  );

  // Flexible matching + aliases + boundary guards
  const cCross = makeConcept({
    id: "c-cross",
    term: "Cross-Encoder",
    aliases: ["交叉编码器", "CE"],
    color: "sky",
  });
  const cEncoder = makeConcept({ id: "c-enc", term: "Encoder" });
  const cCrossOnly = makeConcept({ id: "c-cross-only", term: "Cross" });
  const cBigKey = makeConcept({ id: "c-bigkey", term: "大Key", color: "amber" });
  const cBigKeySpaced = makeConcept({ id: "c-hot", term: "热 Key", color: "rose" });
  const cAI = makeConcept({ id: "c-ai", term: "AI" });
  const cCpp = makeConcept({ id: "c-cpp", term: "C++" });
  const cNode = makeConcept({ id: "c-node", term: "Node.js" });
  const cGraphRag = makeConcept({ id: "c-grag", term: "Graph RAG" });
  const cMyGraph = makeConcept({ id: "c-mgraph", term: "my Graph" });
  const cRag = makeConcept({ id: "c-rag", term: "RAG" });

  const all = [
    cCross,
    cEncoder,
    cCrossOnly,
    cBigKey,
    cBigKeySpaced,
    cAI,
    cCpp,
    cNode,
    cGraphRag,
    cMyGraph,
    cRag,
  ];
  const matcher = buildConceptMatcherPattern(all);
  assert.ok(matcher);

  // Variants of Cross-Encoder including CJK adjacency and joined form
  const variantSample =
    "使用Cross-Encoder重排，基于cross encoder精排，以及CROSS_ENCODER、Cross–Encoder、Cross·Encoder、CrossEncoder、crossencoder和交叉编码器与CE。";
  const variantMatches = findConceptMatchesInText(variantSample, all, matcher);
  assert.deepEqual(
    variantMatches.map((m) => [m.text, m.concept.id]),
    [
      ["Cross-Encoder", "c-cross"],
      ["cross encoder", "c-cross"],
      ["CROSS_ENCODER", "c-cross"],
      ["Cross–Encoder", "c-cross"],
      ["Cross·Encoder", "c-cross"],
      ["CrossEncoder", "c-cross"],
      ["crossencoder", "c-cross"],
      ["交叉编码器", "c-cross"],
      ["CE", "c-cross"],
    ],
  );

  // CJK-Latin spacing both directions & boundary guard on 大Keyword
  const cjkSample = "处理大 Key 问题、大Key拆分、大Keyword不匹配、以及热Key和热 Key场景";
  const cjkMatches = findConceptMatchesInText(cjkSample, all, matcher);
  assert.deepEqual(
    cjkMatches.map((m) => [m.text, m.concept.id]),
    [
      ["大 Key", "c-bigkey"],
      ["大Key", "c-bigkey"],
      ["热Key", "c-hot"],
      ["热 Key", "c-hot"],
    ],
  );

  // Strict ASCII word boundary guards: NO false matches inside ASCII words
  const guardSample =
    "main email pair tail AI2 _AI AI_ OpenAI AC++ NodeXjs vs AI模型 生成式AI 用C++开发 Node.js服务";
  const guardMatches = findConceptMatchesInText(guardSample, all, matcher);
  assert.deepEqual(
    guardMatches.map((m) => [m.text, m.concept.id]),
    [
      ["AI", "c-ai"],
      ["AI", "c-ai"],
      ["C++", "c-cpp"],
      ["Node.js", "c-node"],
    ],
  );

  // Longest-match-first across overlapping candidates (my Graph vs Graph RAG vs RAG)
  const overlapSample = "my Graph RAG 使用 Cross-Encoder 和 Encoder";
  const overlapMatches = findConceptMatchesInText(overlapSample, all, matcher);
  assert.deepEqual(
    overlapMatches.map((m) => [m.text, m.concept.id]),
    [
      ["Graph RAG", "c-grag"],
      ["Cross-Encoder", "c-cross"],
      ["Encoder", "c-enc"],
    ],
  );

  // findMatchingConcept: primary term takes precedence over alias
  const cPrimaryCe = makeConcept({ id: "c-ce", term: "CE" });
  assert.equal(findMatchingConcept([cCross, cPrimaryCe], "ce")?.id, "c-ce");
  assert.equal(findMatchingConcept([cCross], "交叉编码器")?.id, "c-cross");
  assert.equal(findMatchingConcept([cCross], "CROSS_ENCODER")?.id, "c-cross");
  assert.equal(findMatchingConcept([cBigKey], "大 Key")?.id, "c-bigkey");

  // Grouping: natural Chinese sort, named first, 未分组 last (omitted if empty)
  const grouped = groupConceptsByName([
    makeConcept({ id: "1", term: "未分组项", groupName: "" }),
    makeConcept({ id: "2", term: "B项", groupName: "第10章" }),
    makeConcept({ id: "3", term: "A项", groupName: "第2章" }),
    makeConcept({ id: "4", term: "C项", groupName: "第2章" }),
  ]);
  assert.deepEqual(
    grouped.map((g) => ({ groupName: g.groupName, label: g.label, terms: g.items.map((i) => i.term) })),
    [
      { groupName: "第2章", label: "第2章", terms: ["A项", "C项"] },
      { groupName: "第10章", label: "第10章", terms: ["B项"] },
      { groupName: "", label: "未分组", terms: ["未分组项"] },
    ],
  );
  assert.equal(
    groupConceptsByName([makeConcept({ id: "2", term: "B", groupName: "RAG" })]).length,
    1,
  );

  // SSR-safe prefs default false
  assert.equal(readConceptLinksPref("u1"), false);
  writeConceptLinksPref("u1", true); // no-op in Node SSR
});

test("applyConceptLinks skips code/pre/katex/a/annotations, stamps attributes, and cleans up reversibly", () => {
  const doc = new MockDocument();
  const root = doc.createElement("div");

  const p1 = doc.createElement("p");
  p1.appendChild(doc.createTextNode("在检索阶段结合 cross encoder 与大 Key 治理。"));
  root.appendChild(p1);

  const pre = doc.createElement("pre");
  pre.appendChild(doc.createTextNode("Cross-Encoder in pre"));
  root.appendChild(pre);

  const p2 = doc.createElement("p");
  const code = doc.createElement("code");
  code.appendChild(doc.createTextNode("cross_encoder"));
  p2.appendChild(code);
  const a = doc.createElement("a");
  a.appendChild(doc.createTextNode("Cross-Encoder Link"));
  p2.appendChild(a);
  const katex = doc.createElement("span");
  katex.className = "katex";
  katex.appendChild(doc.createTextNode("Cross-Encoder"));
  p2.appendChild(katex);
  const annMark = doc.createElement("mark");
  annMark.className = "prose-annotation-mark color-accent";
  annMark.appendChild(doc.createTextNode("Cross-Encoder"));
  p2.appendChild(annMark);
  root.appendChild(p2);

  const originalText = root.textContent;
  const concepts = [
    makeConcept({ id: "c1", term: "Cross-Encoder", color: "sky" }),
    makeConcept({ id: "c2", term: "大Key", color: "amber" }),
  ];

  const { matchedConceptIds, matchCount, cleanup } = applyConceptLinks(
    root as unknown as HTMLElement,
    concepts,
    "c1",
  );
  assert.deepEqual([...matchedConceptIds].sort(), ["c1", "c2"]);
  assert.equal(matchCount, 2);

  const links = root.collectConceptLinks();
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, "cross encoder");
  assert.equal(links[0].dataset.conceptId, "c1");
  assert.equal(links[0].getAttribute("data-concept-id"), "c1");
  assert.ok(links[0].className.includes("color-sky"));
  assert.ok(links[0].className.includes("is-active"));
  assert.equal(links[0].getAttribute("role"), "button");
  assert.equal(links[0].tabIndex, 0);
  assert.equal(links[0].getAttribute("aria-label"), "查看概念释义：Cross-Encoder");

  assert.equal(links[1].textContent, "大 Key");
  assert.equal(links[1].dataset.conceptId, "c2");
  assert.ok(links[1].className.includes("color-amber"));
  assert.ok(!links[1].className.includes("is-active"));
  assert.equal(root.textContent, originalText);

  // Reversible & idempotent cleanup
  cleanup();
  assert.equal(root.collectConceptLinks().length, 0);
  assert.equal(root.textContent, originalText);
  assert.equal(p1.childNodes.length, 1);
  cleanup();
  assert.equal(root.collectConceptLinks().length, 0);
  assert.equal(root.textContent, originalText);
});

test("concepts CRUD API, 409 CONCEPT_EXISTS, group rename/dissolve/move, tenant isolation, and ETag invalidation", async () => {
  // Create a private question for Alice
  const { id: qAlicePrivate } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: alice.deckId,
        title: "RAG 重排架构",
        answer: "召回后通过 Cross-Encoder 进行精排。",
        tags: ["RAG"],
      }),
    )
  ).json();

  const etag0 = await getEtag(alice);
  // 304 check
  const notModified = await workspaceRoute.GET(
    req(alice, "/api/workspace", undefined, {
      headers: { "if-none-match": etag0 },
    }),
  );
  assert.equal(notModified.status, 304);

  // Create concept
  const createRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "create",
      term: "Cross-Encoder",
      aliases: ["交叉编码器", "CE", "cross encoder"],
      definition: "将 query 与 doc 拼接输入 Transformer 做全交互打分的精排模型。",
      groupName: "RAG",
      color: "sky",
      sourceQuestionId: qAlicePrivate,
    }),
  );
  assert.equal(createRes.status, 200);
  const { concept: c1 } = (await createRes.json()) as { concept: ConceptView };
  assert.equal(c1.term, "Cross-Encoder");
  assert.equal(c1.normalizedKey, "cross encoder");
  assert.deepEqual(c1.aliases, ["交叉编码器", "CE"]);
  assert.equal(c1.groupName, "RAG");
  assert.equal(c1.color, "sky");
  assert.equal(c1.sourceQuestionId, qAlicePrivate);

  // ETag invalidated on create
  const etag1 = await getEtag(alice);
  assert.notEqual(etag1, etag0);

  // Duplicate normalizedKey -> 409 CONCEPT_EXISTS with details.existing
  const dupRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "create",
      term: "CROSS_ENCODER",
      definition: "重复概念",
    }),
  );
  assert.equal(dupRes.status, 409);
  const dupBody = await dupRes.json();
  assert.equal(dupBody.code, "CONCEPT_EXISTS");
  assert.equal(dupBody.details.existing.id, c1.id);

  // Create second concept
  const { concept: c2 } = await (
    await conceptsRoute.POST(
      req(alice, "/api/concepts", {
        action: "create",
        term: "Bi-Encoder",
        definition: "双塔编码器，分别编码 query 和 doc。",
        groupName: "RAG",
        color: "accent",
      }),
    )
  ).json();

  // Edit to duplicate normalizedKey -> 409 CONCEPT_EXISTS
  const dupEditRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "edit",
      id: c2.id,
      term: "cross encoder",
    }),
  );
  assert.equal(dupEditRes.status, 409);
  const dupEditBody = await dupEditRes.json();
  assert.equal(dupEditBody.code, "CONCEPT_EXISTS");
  assert.equal(dupEditBody.details.existing.id, c1.id);

  // Edit definition only -> ETag invalidated immediately
  const etagBeforeEdit = await getEtag(alice);
  const editRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "edit",
      id: c1.id,
      definition: "更新后的精排模型释义：query 与 doc 联合自注意力交互。",
    }),
  );
  assert.equal(editRes.status, 200);
  const etagAfterEdit = await getEtag(alice);
  assert.notEqual(etagAfterEdit, etagBeforeEdit);

  // renameGroup (rename)
  const renRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "renameGroup",
      fromGroup: "RAG",
      toGroup: "检索增强",
    }),
  );
  assert.equal(renRes.status, 200);
  assert.equal((await renRes.json()).updated, 2);
  const etagAfterRename = await getEtag(alice);
  assert.notEqual(etagAfterRename, etagAfterEdit);

  // moveGroup
  const moveRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "moveGroup",
      ids: [c2.id],
      groupName: "向量召回",
    }),
  );
  assert.equal(moveRes.status, 200);
  assert.equal((await moveRes.json()).updated, 1);

  // renameGroup to "" dissolves group into 未分组
  const dissolveRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "renameGroup",
      fromGroup: "向量召回",
      toGroup: "",
    }),
  );
  assert.equal(dissolveRes.status, 200);
  assert.equal((await dissolveRes.json()).updated, 1);

  // GET /api/concepts + Workspace.concepts match
  const listRes = await conceptsRoute.GET(req(alice, "/api/concepts"));
  assert.equal(listRes.status, 200);
  const listed = (await listRes.json()) as ConceptView[];
  assert.equal(listed.length, 2);
  const wsAlice = await getWs(alice);
  assert.deepEqual(
    wsAlice.concepts.map((c) => [c.id, c.groupName]),
    listed.map((c) => [c.id, c.groupName]),
  );

  // Tenant isolation: Bob can create same normalizedKey, cannot edit/delete/move Alice's, cannot reference Alice's private question
  const bobPrivateSrc = await conceptsRoute.POST(
    req(bob, "/api/concepts", {
      action: "create",
      term: "Cross-Encoder",
      definition: "尝试越权引用他人私密题",
      sourceQuestionId: qAlicePrivate,
    }),
  );
  assert.equal(bobPrivateSrc.status, 404);

  const bobCreate = await conceptsRoute.POST(
    req(bob, "/api/concepts", {
      action: "create",
      term: "Cross-Encoder",
      definition: "Bob 自己的概念释义",
    }),
  );
  assert.equal(bobCreate.status, 200);
  assert.equal(
    (
      await conceptsRoute.POST(
        req(bob, "/api/concepts", {
          action: "edit",
          id: c1.id,
          definition: "越权修改",
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await conceptsRoute.POST(
        req(bob, "/api/concepts", {
          action: "delete",
          id: c1.id,
        }),
      )
    ).status,
    404,
  );
  const bobMoveAlice = await conceptsRoute.POST(
    req(bob, "/api/concepts", {
      action: "moveGroup",
      ids: [c1.id],
      groupName: "劫持分组",
    }),
  );
  assert.equal((await bobMoveAlice.json()).updated, 0);

  // Validation errors (400)
  assert.equal(
    (
      await conceptsRoute.POST(
        req(alice, "/api/concepts", {
          action: "create",
          term: "---",
          definition: "纯符号",
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await conceptsRoute.POST(
        req(alice, "/api/concepts", {
          action: "create",
          term: "a".repeat(121),
          definition: "超长名称",
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await conceptsRoute.POST(
        req(alice, "/api/concepts", {
          action: "create",
          term: "Valid",
          definition: "   ",
        }),
      )
    ).status,
    400,
  );

  // Delete concept -> ETag invalidated
  const etagBeforeDel = await getEtag(alice);
  const delRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", { action: "delete", id: c2.id }),
  );
  assert.equal(delRes.status, 200);
  const etagAfterDel = await getEtag(alice);
  assert.notEqual(etagAfterDel, etagBeforeDel);
});

test("unified annotation <-> concept creation, reuse/update, bidirectional sync, delete preservation, and importFromAnnotations", async () => {
  // Create 2 questions for Alice and publish deck so Bob can subscribe
  const { id: q1 } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: alice.deckId,
        title: "Redis 大Key 问题",
        answer: "单 Key 过大导致阻塞与带宽打满，可拆分大 Key 或渐进删除。",
        tags: ["Redis"],
      }),
    )
  ).json();
  const { id: q2 } = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "create",
        deckId: alice.deckId,
        title: "缓存治理实践",
        answer: "监控发现大Key和热Key，并结合 MVCC 与 HNSW 分析。",
        tags: ["Redis"],
      }),
    )
  ).json();

  // 1. Add annotation with saveAsConcept=true -> creates BOTH annotation & concept
  const add1Res = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "addAnnotation",
      id: q1,
      quote: "大Key",
      comment: "String > 10KB 或集合元素过多的 Redis 键。",
      color: "amber",
      saveAsConcept: true,
      conceptGroup: "Redis",
      aliases: ["BigKey"],
    }),
  );
  assert.equal(add1Res.status, 200);
  const add1 = (await add1Res.json()) as {
    ok: boolean;
    annotation: QuestionAnnotation;
    concept: ConceptView;
    annotations: QuestionAnnotation[];
    version: number;
  };
  assert.equal(add1.ok, true);
  assert.ok(add1.concept);
  assert.equal(add1.annotation.conceptId, add1.concept.id);
  assert.equal(add1.concept.term, "大Key");
  assert.equal(add1.concept.groupName, "Redis");
  assert.deepEqual(add1.concept.aliases, ["BigKey"]);
  assert.equal(add1.concept.sourceQuestionId, q1);

  // 2. On q2, add annotation with variant "大 Key" & updateExistingConcept=false -> reuses without overwriting
  const add2Res = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "addAnnotation",
      id: q2,
      quote: "大 Key",
      comment: "另一题里的补充摘记",
      color: "rose",
      saveAsConcept: true,
      updateExistingConcept: false,
    }),
  );
  assert.equal(add2Res.status, 200);
  const add2 = await add2Res.json();
  assert.equal(add2.concept.id, add1.concept.id);
  assert.equal(add2.annotation.conceptId, add1.concept.id);
  assert.equal(add2.concept.definition, "String > 10KB 或集合元素过多的 Redis 键。");

  // 2b. updateExistingConcept=true updates the concept's definition/color/groupName and syncs aliases
  const add2bRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "addAnnotation",
      id: q2,
      quote: "大-Key",
      comment: "通过 updateExistingConcept 覆盖更新的大 Key 释义。",
      color: "rose",
      saveAsConcept: true,
      conceptGroup: "Redis治理",
      aliases: ["大键"],
      updateExistingConcept: true,
    }),
  );
  assert.equal(add2bRes.status, 200);
  const add2b = await add2bRes.json();
  assert.equal(add2b.concept.id, add1.concept.id);
  assert.equal(
    add2b.concept.definition,
    "通过 updateExistingConcept 覆盖更新的大 Key 释义。",
  );
  assert.equal(add2b.concept.groupName, "Redis治理");
  assert.deepEqual(add2b.concept.aliases, ["BigKey", "大键"]);

  // 3. Edit annotation on q1 with syncConcept=false leaves concept untouched, then default syncConcept=true syncs!
  const editNoSyncRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "editAnnotation",
      id: q1,
      annotationId: add1.annotation.id,
      comment: "仅本题局部批注，不同步概念库",
      syncConcept: false,
    }),
  );
  assert.equal(editNoSyncRes.status, 200);
  assert.equal((await editNoSyncRes.json()).concept, null);
  const wsNoSync = await getWs(alice);
  assert.equal(
    wsNoSync.concepts.find((c) => c.id === add1.concept.id)!.definition,
    "通过 updateExistingConcept 覆盖更新的大 Key 释义。",
  );

  // Edit annotation on q1 with default syncConcept=true -> updates concept AND syncs q2's linked annotation!
  const editAnnRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "editAnnotation",
      id: q1,
      annotationId: add1.annotation.id,
      comment: "统一释义：大 Key 会引发单线程阻塞、主从同步延迟与网络抖动。",
      color: "sky",
    }),
  );
  assert.equal(editAnnRes.status, 200);
  const editAnn = await editAnnRes.json();
  assert.equal(editAnn.concept.id, add1.concept.id);
  assert.equal(
    editAnn.concept.definition,
    "统一释义：大 Key 会引发单线程阻塞、主从同步延迟与网络抖动。",
  );
  assert.equal(editAnn.concept.color, "sky");

  const wsAfterEdit = await getWs(alice);
  const q2AfterEdit = wsAfterEdit.questions.find((q) => q.id === q2)!;
  assert.equal(
    q2AfterEdit.annotations[0].comment,
    "统一释义：大 Key 会引发单线程阻塞、主从同步延迟与网络抖动。",
  );
  assert.equal(q2AfterEdit.annotations[0].color, "sky");

  // 4. Edit concept directly via /api/concepts -> syncs back to linked annotations too!
  const editConceptRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "edit",
      id: add1.concept.id,
      definition: "从概念库修订：建议拆分或使用 UNLINK 异步删除大 Key。",
    }),
  );
  assert.equal(editConceptRes.status, 200);
  const wsAfterConceptEdit = await getWs(alice);
  assert.equal(
    wsAfterConceptEdit.questions.find((q) => q.id === q1)!.annotations[0].comment,
    "从概念库修订：建议拆分或使用 UNLINK 异步删除大 Key。",
  );

  // 5. Delete annotation on q1 -> removes ONLY the annotation and preserves the concept!
  const delAnnRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "deleteAnnotation",
      id: q1,
      annotationId: add1.annotation.id,
    }),
  );
  assert.equal(delAnnRes.status, 200);
  const wsAfterDelAnn = await getWs(alice);
  assert.equal(wsAfterDelAnn.questions.find((q) => q.id === q1)!.annotations.length, 0);
  assert.ok(wsAfterDelAnn.concepts.some((c) => c.id === add1.concept.id));

  // 6. Long quote (> 120 chars) with saveAsConcept=true saves annotation gracefully with concept=null
  const longAnnRes = await questionsRoute.POST(
    req(alice, "/api/questions", {
      action: "addAnnotation",
      id: q1,
      quote: "长摘录".repeat(45),
      comment: "普通长段批注",
      saveAsConcept: true,
    }),
  );
  assert.equal(longAnnRes.status, 200);
  const longAnn = await longAnnRes.json();
  assert.equal(longAnn.concept, null);
  assert.equal(longAnn.annotation.conceptId, undefined);

  // 7. importFromAnnotations: single targeted item + bulk promotion + variant dedup
  const unlinked1 = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "addAnnotation",
        id: q2,
        quote: "MVCC",
        comment: "多版本并发控制，通过 Undo Log 和 ReadView 实现非阻塞快照读。",
        color: "accent",
      }),
    )
  ).json();
  const unlinked2 = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "addAnnotation",
        id: q1,
        quote: "mvcc",
        comment: "重复变体批注",
        color: "amber",
      }),
    )
  ).json();
  const unlinked3 = await (
    await questionsRoute.POST(
      req(alice, "/api/questions", {
        action: "addAnnotation",
        id: q2,
        quote: "HNSW",
        comment: "分层可导航小世界图近似最近邻索引。",
        color: "sky",
      }),
    )
  ).json();

  // Single-item promote (HNSW)
  const singleImportRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "importFromAnnotations",
      items: [{ questionId: q2, annotationId: unlinked3.annotation.id }],
      groupName: "向量索引",
    }),
  );
  assert.equal(singleImportRes.status, 200);
  const singleImport = await singleImportRes.json();
  assert.equal(singleImport.created, 1);
  assert.equal(singleImport.linked, 1);
  assert.equal(singleImport.concepts[0].term, "HNSW");
  assert.equal(singleImport.concepts[0].groupName, "向量索引");

  // Bulk promote (MVCC + mvcc -> 1 created, 2 linked; ignores long quote & already-linked HNSW)
  const bulkImportRes = await conceptsRoute.POST(
    req(alice, "/api/concepts", {
      action: "importFromAnnotations",
    }),
  );
  assert.equal(bulkImportRes.status, 200);
  const bulkImport = await bulkImportRes.json();
  assert.equal(bulkImport.created, 1);
  assert.equal(bulkImport.linked, 2);

  const wsAfterImport = await getWs(alice);
  const mvccConcept = wsAfterImport.concepts.find((c) => c.normalizedKey === "mvcc")!;
  assert.ok(mvccConcept);
  const q1MvccAnn = wsAfterImport.questions
    .find((q) => q.id === q1)!
    .annotations.find((a) => a.id === unlinked2.annotation.id)!;
  const q2MvccAnn = wsAfterImport.questions
    .find((q) => q.id === q2)!
    .annotations.find((a) => a.id === unlinked1.annotation.id)!;
  assert.equal(q1MvccAnn.conceptId, mvccConcept.id);
  assert.equal(q2MvccAnn.conceptId, mvccConcept.id);

  // 8. Subscribed question concept-linked annotation stays strictly tenant-isolated
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
  const bobSubAnn = await questionsRoute.POST(
    req(bob, "/api/questions", {
      action: "addAnnotation",
      id: q2,
      quote: "热Key",
      comment: "Bob 对热 Key 的个人概念总结",
      saveAsConcept: true,
    }),
  );
  assert.equal(bobSubAnn.status, 200);
  const wsAliceCheck = await getWs(alice);
  assert.ok(!wsAliceCheck.concepts.some((c) => c.normalizedKey === "热key"));
  const wsBobCheck = await getWs(bob);
  assert.ok(wsBobCheck.concepts.some((c) => c.normalizedKey === "热key"));
});

test("export & backup restore preserves concepts, remaps IDs/sourceQuestionId/annotations.conceptId idempotently, and supports legacy backups", async () => {
  // 1. Export Alice's workspace (contains concepts + concept-linked annotations)
  const expRes = await exportRoute.GET(req(alice, "/api/export"));
  assert.equal(expRes.status, 200);
  const exported = await expRes.json();
  assert.equal(exported.format, "shiyi-backup");
  assert.equal(exported.version, 3);
  assert.ok(Array.isArray(exported.concepts));
  assert.ok(exported.concepts.length >= 3);

  // 2. Restore Alice's backup into Charlie (cross-user ID collision remapping!)
  const restore1Res = await restoreRoute.POST(
    req(charlie, "/api/backup/restore", exported),
  );
  assert.equal(restore1Res.status, 200);
  const restore1 = await restore1Res.json();
  assert.equal(restore1.restored.concepts, exported.concepts.length);

  const wsCharlie = await getWs(charlie);
  assert.equal(wsCharlie.concepts.length, exported.concepts.length);
  const charlieConceptIds = new Set(wsCharlie.concepts.map((c) => c.id));
  const charlieQuestionIds = new Set(wsCharlie.questions.map((q) => q.id));

  // Verify concept IDs were remapped away from Alice's IDs, sourceQuestionId points to Charlie's question,
  // and restored annotations' conceptId points to Charlie's remapped concepts!
  const aliceConceptIds = new Set(
    (exported.concepts as ConceptView[]).map((c) => c.id),
  );
  for (const c of wsCharlie.concepts) {
    assert.ok(!aliceConceptIds.has(c.id), "cross-user concept ID must be remapped");
    if (c.sourceQuestionId) {
      assert.ok(
        charlieQuestionIds.has(c.sourceQuestionId),
        "remapped sourceQuestionId must exist in Charlie's questions",
      );
    }
  }
  const linkedAnns = wsCharlie.questions.flatMap((q) =>
    q.annotations.filter((a) => Boolean(a.conceptId)),
  );
  assert.ok(linkedAnns.length >= 2);
  for (const ann of linkedAnns) {
    assert.ok(
      charlieConceptIds.has(ann.conceptId!),
      "restored annotation.conceptId must point to Charlie's remapped concept",
    );
    assert.ok(!aliceConceptIds.has(ann.conceptId!));
  }

  // 3. Re-running restore on Charlie is 100% idempotent
  const restore2Res = await restoreRoute.POST(
    req(charlie, "/api/backup/restore", exported),
  );
  assert.equal(restore2Res.status, 200);
  const restore2 = await restore2Res.json();
  assert.equal(restore2.restored.concepts, 0);
  assert.equal((await getWs(charlie)).concepts.length, exported.concepts.length);

  // 4. Legacy backup (v2 / v3 without `concepts` key) restores cleanly
  const legacyUser = await register("concept-legacy");
  const legacyBackup = {
    format: "shiyi-backup",
    version: 2,
    decks: [
      {
        id: randomUUID(),
        title: "旧版题库",
        description: "",
        groupName: "后端",
        color: "sage",
        isOwner: true,
      },
    ],
    questions: [],
  };
  const legacyRes = await restoreRoute.POST(
    req(legacyUser, "/api/backup/restore", legacyBackup),
  );
  assert.equal(legacyRes.status, 200);
  const legacyBody = await legacyRes.json();
  assert.equal(legacyBody.restored.concepts, 0);
  assert.equal(legacyBody.restored.decks, 1);
});

test("typed client helpers dispatch exact API URLs and payloads", async () => {
  const calls: { url: string; payload: unknown; options?: unknown }[] = [];
  const mutate: WorkspaceMutate = async (url, data, options) => {
    calls.push({ url, payload: data, options });
    return { ok: true };
  };

  await createConcept(
    mutate,
    { term: "RAG", definition: "检索增强生成", aliases: ["检索增强"], groupName: "LLM", color: "sky" },
    { throwOnCodes: ["CONCEPT_EXISTS"] },
  );
  await editConcept(mutate, { id: "c1", definition: "新释义" });
  await deleteConcept(mutate, "c1");
  await renameConceptGroup(mutate, "LLM", "大模型");
  await moveConceptsToGroup(mutate, ["c1", "c2"], "大模型");
  await importConceptsFromAnnotations(mutate, {
    items: [{ questionId: "q1", annotationId: "a1" }],
    groupName: "LLM",
  });
  await addQuestionAnnotation(mutate, {
    id: "q1",
    quote: "RAG",
    comment: "释义",
    saveAsConcept: true,
    conceptGroup: "LLM",
    aliases: ["检索增强"],
    updateExistingConcept: true,
  });
  await editQuestionAnnotation(mutate, {
    id: "q1",
    annotationId: "a1",
    comment: "更新释义",
    syncConcept: true,
  });

  assert.equal(calls.length, 8);
  assert.equal(calls[0].url, "/api/concepts");
  assert.deepEqual(calls[0].payload, {
    action: "create",
    term: "RAG",
    definition: "检索增强生成",
    aliases: ["检索增强"],
    groupName: "LLM",
    color: "sky",
  });
  assert.deepEqual(calls[0].options, { throwOnCodes: ["CONCEPT_EXISTS"] });
  assert.deepEqual(calls[1].payload, {
    action: "edit",
    id: "c1",
    definition: "新释义",
  });
  assert.deepEqual(calls[2].payload, { action: "delete", id: "c1" });
  assert.deepEqual(calls[3].payload, {
    action: "renameGroup",
    fromGroup: "LLM",
    toGroup: "大模型",
  });
  assert.deepEqual(calls[4].payload, {
    action: "moveGroup",
    ids: ["c1", "c2"],
    groupName: "大模型",
  });
  assert.deepEqual(calls[5].payload, {
    action: "importFromAnnotations",
    items: [{ questionId: "q1", annotationId: "a1" }],
    groupName: "LLM",
  });
  assert.equal(calls[6].url, "/api/questions");
  assert.deepEqual(calls[6].payload, {
    action: "addAnnotation",
    id: "q1",
    quote: "RAG",
    comment: "释义",
    color: "accent",
    saveAsConcept: true,
    conceptGroup: "LLM",
    aliases: ["检索增强"],
    updateExistingConcept: true,
  });
  assert.deepEqual(calls[7].payload, {
    action: "editAnnotation",
    id: "q1",
    annotationId: "a1",
    comment: "更新释义",
    syncConcept: true,
  });

  // Recursive concept folder client helpers
  const fCalls: { url: string; payload: unknown; options?: unknown }[] = [];
  const fMutate: WorkspaceMutate = async (url, data, options) => {
    fCalls.push({ url, payload: data, options });
    return { ok: true };
  };
  await createConceptFolder(
    fMutate,
    { title: "技术", parentId: null, color: "blue" },
    { throwOnCodes: ["FOLDER_NAME_CONFLICT"] },
  );
  await editConceptFolder(fMutate, { id: "f1", title: "后端技术", color: "sand" });
  await moveConceptFolder(fMutate, {
    folderId: "f1",
    targetParentId: "f2",
    conflictStrategy: "merge",
  });
  await groupIntoNewConceptFolder(fMutate, {
    parentId: null,
    title: "核心专题",
    folderIds: ["f1"],
    conceptIds: ["c1"],
  });
  await dissolveConceptFolder(fMutate, "f1", "keepBoth");
  await deleteConceptFolder(fMutate, "f2");
  await moveConceptsToFolder(fMutate, ["c1", "c2"], "f3");

  assert.equal(fCalls.length, 7);
  assert.deepEqual(fCalls[0].payload, {
    action: "createFolder",
    title: "技术",
    parentId: null,
    color: "blue",
  });
  assert.deepEqual(fCalls[1].payload, {
    action: "editFolder",
    id: "f1",
    title: "后端技术",
    color: "sand",
  });
  assert.deepEqual(fCalls[2].payload, {
    action: "moveFolder",
    folderId: "f1",
    targetParentId: "f2",
    conflictStrategy: "merge",
  });
  assert.deepEqual(fCalls[3].payload, {
    action: "groupIntoNewFolder",
    parentId: null,
    title: "核心专题",
    color: "sage",
    folderIds: ["f1"],
    conceptIds: ["c1"],
    conflictStrategy: "abort",
  });
  assert.deepEqual(fCalls[4].payload, {
    action: "dissolveFolder",
    folderId: "f1",
    conflictStrategy: "keepBoth",
  });
  assert.deepEqual(fCalls[5].payload, { action: "deleteFolder", folderId: "f2" });
  assert.deepEqual(fCalls[6].payload, {
    action: "moveConcepts",
    ids: ["c1", "c2"],
    folderId: "f3",
  });
});

test("0018_concept_folders migration upgrades 0017 group_name data idempotently and enforces constraints", async () => {
  const pg = new PGlite();
  const journal = JSON.parse(
    await readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const execFile = async (tag: string) => {
    const raw = await readFile(path.resolve("drizzle", `${tag}.sql`), "utf8");
    for (const stmt of raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pg.exec(stmt);
    }
  };
  for (const entry of journal.entries) {
    if (entry.idx > 17) break;
    await execFile(entry.tag);
  }

  await pg.exec(`
    INSERT INTO users (id, name, email) VALUES ('u1', 'A', 'a@cf.t');
    INSERT INTO concepts (id, user_id, term, normalized_key, definition, group_name) VALUES
      ('c1', 'u1', 'Cross-Encoder', 'cross encoder', 'def1', 'RAG'),
      ('c2', 'u1', 'Bi-Encoder', 'bi encoder', 'def2', 'rag'),
      ('c3', 'u1', 'A/B Test', 'a/b test', 'def3', '实验/评估'),
      ('c4', 'u1', 'RootConcept', 'rootconcept', 'def4', '');
  `);

  // Run 0018 twice to verify idempotency.
  await execFile("0018_concept_folders");
  await execFile("0018_concept_folders");

  const folders = await pg.query<{ id: string; title: string; parent_id: string | null }>(
    `SELECT id, title, parent_id FROM concept_folders WHERE user_id = 'u1' ORDER BY title`,
  );
  assert.equal(folders.rows.length, 2);
  const titles = folders.rows.map((r) => r.title).sort();
  assert.deepEqual(titles, ["RAG", "实验／评估"]);

  const migrated = await pg.query<{ id: string; folder_id: string | null }>(
    `SELECT id, folder_id FROM concepts WHERE user_id = 'u1' ORDER BY id`,
  );
  const byId = new Map(migrated.rows.map((r) => [r.id, r.folder_id]));
  assert.ok(byId.get("c1"));
  assert.equal(byId.get("c1"), byId.get("c2"), "case-insensitive group_name shares single folder");
  assert.ok(byId.get("c3"));
  assert.notEqual(byId.get("c3"), byId.get("c1"));
  assert.equal(byId.get("c4"), null);

  // Self-parent CHECK constraint
  const fId = folders.rows[0].id;
  await assert.rejects(
    () => pg.exec(`UPDATE concept_folders SET parent_id = '${fId}' WHERE id = '${fId}'`),
    /check|constraint/i,
  );
  // Sibling unique index constraint
  await assert.rejects(
    () =>
      pg.exec(
        `INSERT INTO concept_folders (id, user_id, parent_id, title) VALUES ('dup', 'u1', NULL, 'rag')`,
      ),
    /unique|duplicate/i,
  );
  await pg.close();
});

test("recursive concept folders CRUD, Finder 3-way conflicts, dissolve, delete, ETag, and backup round-trip", async () => {
  const userA = await register("cf-alice");
  const userB = await register("cf-bob");
  const userRestore = await register("cf-restore");

  // 1. Create nested folder hierarchy: 技术 -> RAG -> 重排
  const fTech = (
    await (
      await conceptsRoute.POST(
        req(userA, "/api/concepts", {
          action: "createFolder",
          parentId: null,
          title: "技术",
          color: "blue",
        }),
      )
    ).json()
  ).folder as ConceptFolderView;
  assert.equal(fTech.title, "技术");
  assert.equal(fTech.parentId, null);

  // Duplicate sibling -> 409 FOLDER_NAME_CONFLICT
  const dupFolderRes = await conceptsRoute.POST(
    req(userA, "/api/concepts", {
      action: "createFolder",
      parentId: null,
      title: " 技术 ",
    }),
  );
  assert.equal(dupFolderRes.status, 409);
  assert.equal((await dupFolderRes.json()).code, "FOLDER_NAME_CONFLICT");

  // Invalid Finder name -> 400
  assert.equal(
    (
      await conceptsRoute.POST(
        req(userA, "/api/concepts", {
          action: "createFolder",
          parentId: null,
          title: "bad/name",
        }),
      )
    ).status,
    400,
  );

  const fRag = (
    await (
      await conceptsRoute.POST(
        req(userA, "/api/concepts", {
          action: "createFolder",
          parentId: fTech.id,
          title: "RAG",
          color: "sage",
        }),
      )
    ).json()
  ).folder as ConceptFolderView;

  // Create concept inside 技术 / RAG
  const { concept: cRerank } = await (
    await conceptsRoute.POST(
      req(userA, "/api/concepts", {
        action: "create",
        term: "Cross-Encoder",
        definition: "全交互精排模型",
        folderId: fRag.id,
        color: "sky",
      }),
    )
  ).json();
  assert.equal(cRerank.folderId, fRag.id);
  assert.equal(cRerank.folderPath, "技术 / RAG");
  assert.equal(cRerank.groupName, "RAG");

  // Verify buildConceptFolderIndex & recursive counts
  const ws1 = await getWs(userA);
  const idx1 = buildConceptFolderIndex(ws1.conceptFolders, ws1.concepts);
  assert.equal(idx1.depthOf(fTech.id), 1);
  assert.equal(idx1.depthOf(fRag.id), 2);
  assert.equal(idx1.subtreeHeight(fTech.id), 2);
  assert.equal(idx1.pathOf(fRag.id), "技术 / RAG");
  assert.equal(idx1.relativePathOf(fRag.id, fTech.id), "RAG");
  assert.equal(idx1.flatList.length, 2);
  assert.equal(ws1.conceptFolders.find((f) => f.id === fTech.id)!.count, 1);
  assert.equal(ws1.conceptFolders.find((f) => f.id === fTech.id)!.directCount, 0);
  assert.equal(ws1.conceptFolders.find((f) => f.id === fRag.id)!.count, 1);
  assert.equal(ws1.conceptFolders.find((f) => f.id === fRag.id)!.directCount, 1);

  // Edit folder title -> ETag invalidates & concept folderPath updates!
  const etagBeforeFolderEdit = await getEtag(userA);
  const editFolderRes = await conceptsRoute.POST(
    req(userA, "/api/concepts", {
      action: "editFolder",
      id: fTech.id,
      title: "AI技术",
      color: "sand",
    }),
  );
  assert.equal(editFolderRes.status, 200);
  assert.notEqual(await getEtag(userA), etagBeforeFolderEdit);
  const wsAfterRename = await getWs(userA);
  assert.equal(
    wsAfterRename.concepts.find((c) => c.id === cRerank.id)!.folderPath,
    "AI技术 / RAG",
  );

  // Cycle prevention on moveFolder -> 400
  assert.equal(
    (
      await conceptsRoute.POST(
        req(userA, "/api/concepts", {
          action: "moveFolder",
          folderId: fTech.id,
          targetParentId: fRag.id,
        }),
      )
    ).status,
    400,
  );

  // Create root folder "RAG" to test Finder 3-way conflict when moving AI技术/RAG -> root
  const fRootRag = (
    await (
      await conceptsRoute.POST(
        req(userA, "/api/concepts", {
          action: "createFolder",
          parentId: null,
          title: "RAG",
        }),
      )
    ).json()
  ).folder as ConceptFolderView;
  const { concept: cBi } = await (
    await conceptsRoute.POST(
      req(userA, "/api/concepts", {
        action: "create",
        term: "Bi-Encoder",
        definition: "双塔编码器",
        folderId: fRootRag.id,
      }),
    )
  ).json();

  // abort -> 409 FOLDER_NAME_CONFLICT
  const moveAbort = await conceptsRoute.POST(
    req(userA, "/api/concepts", {
      action: "moveFolder",
      folderId: fRag.id,
      targetParentId: null,
      conflictStrategy: "abort",
    }),
  );
  assert.equal(moveAbort.status, 409);
  assert.equal((await moveAbort.json()).code, "FOLDER_NAME_CONFLICT");

  // merge -> merges fRag into fRootRag (both concepts now inside fRootRag!)
  const moveMerge = await conceptsRoute.POST(
    req(userA, "/api/concepts", {
      action: "moveFolder",
      folderId: fRag.id,
      targetParentId: null,
      conflictStrategy: "merge",
    }),
  );
  assert.equal(moveMerge.status, 200);
  const moveMergeBody = await moveMerge.json();
  assert.equal(moveMergeBody.mergedIntoId, fRootRag.id);
  assert.equal(
    moveMergeBody.concepts.find((c: ConceptView) => c.id === cRerank.id).folderId,
    fRootRag.id,
  );
  assert.equal(
    moveMergeBody.conceptFolders.find((f: ConceptFolderView) => f.id === fRootRag.id).count,
    2,
  );

  // groupIntoNewFolder: wrap fRootRag and a root concept into "知识体系"
  const { concept: cRoot } = await (
    await conceptsRoute.POST(
      req(userA, "/api/concepts", {
        action: "create",
        term: "Attention",
        definition: "注意力机制",
        folderId: null,
      }),
    )
  ).json();
  const grpRes = await conceptsRoute.POST(
    req(userA, "/api/concepts", {
      action: "groupIntoNewFolder",
      parentId: null,
      title: "知识体系",
      folderIds: [fRootRag.id],
      conceptIds: [cRoot.id],
    }),
  );
  assert.equal(grpRes.status, 200);
  const grpBody = await grpRes.json();
  assert.equal(grpBody.folder.count, 3);
  assert.equal(grpBody.folder.directCount, 1);

  // Export & restore into userRestore (verifies nested conceptFolders + folderId remap + idempotency!)
  const expJson = await (await exportRoute.GET(req(userA, "/api/export"))).json();
  assert.ok(Array.isArray(expJson.conceptFolders));
  assert.ok(expJson.conceptFolders.length >= 2);
  const r1 = await (
    await restoreRoute.POST(req(userRestore, "/api/backup/restore", expJson))
  ).json();
  assert.equal(r1.restored.conceptFolders, expJson.conceptFolders.length);
  assert.equal(r1.restored.concepts, expJson.concepts.length);
  const wsRestored = await getWs(userRestore);
  const restoredCross = wsRestored.concepts.find(
    (c) => c.normalizedKey === "cross encoder",
  )!;
  assert.equal(restoredCross.folderPath, "知识体系 / RAG");
  // Idempotent second restore
  const r2 = await (
    await restoreRoute.POST(req(userRestore, "/api/backup/restore", expJson))
  ).json();
  assert.equal(r2.restored.conceptFolders, 0);
  assert.equal(r2.restored.concepts, 0);

  // Legacy backup with ONLY concepts[].groupName (no conceptFolders) synthesizes top-level folders!
  const legacyGroupUser = await register("cf-legacy-group");
  const legacyGroupRestore = await (
    await restoreRoute.POST(
      req(legacyGroupUser, "/api/backup/restore", {
        format: "shiyi-backup",
        version: 3,
        concepts: [
          {
            id: randomUUID(),
            term: "HNSW",
            definition: "图索引",
            groupName: "向量检索",
            color: "sky",
          },
        ],
      }),
    )
  ).json();
  assert.equal(legacyGroupRestore.restored.conceptFolders, 1);
  assert.equal(legacyGroupRestore.restored.concepts, 1);
  const wsLegacy = await getWs(legacyGroupUser);
  assert.equal(wsLegacy.concepts[0].folderPath, "向量检索");

  // dissolveFolder on 知识体系 lifts cRoot to root and fRootRag to root (even if child shared name!)
  const dissolveRes = await conceptsRoute.POST(
    req(userA, "/api/concepts", {
      action: "dissolveFolder",
      folderId: grpBody.folder.id,
    }),
  );
  assert.equal(dissolveRes.status, 200);
  const dissolveBody = await dissolveRes.json();
  assert.equal(dissolveBody.liftedConcepts, 1);
  assert.equal(dissolveBody.liftedFolders, 1);
  assert.equal(
    dissolveBody.concepts.find((c: ConceptView) => c.id === cRoot.id).folderId,
    null,
  );

  // Tenant isolation: userB cannot edit/delete/move userA's concept folders
  assert.equal(
    (
      await conceptsRoute.POST(
        req(userB, "/api/concepts", {
          action: "editFolder",
          id: fRootRag.id,
          title: "劫持",
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await conceptsRoute.POST(
        req(userB, "/api/concepts", {
          action: "deleteFolder",
          folderId: fRootRag.id,
        }),
      )
    ).status,
    404,
  );

  // deleteFolder deletes folder + its concepts cleanly and unlinks any annotations
  const delFolderRes = await conceptsRoute.POST(
    req(userA, "/api/concepts", {
      action: "deleteFolder",
      folderId: fRootRag.id,
    }),
  );
  assert.equal(delFolderRes.status, 200);
  const delFolderBody = await delFolderRes.json();
  assert.equal(delFolderBody.deletedFolders, 1);
  assert.equal(delFolderBody.deletedConcepts, 2);
  assert.ok(delFolderBody.deletedConceptIds.includes(cRerank.id));
  assert.ok(delFolderBody.deletedConceptIds.includes(cBi.id));
  assert.equal(delFolderBody.concepts.length, 1); // cRoot remains at root
});

test("applyLocalWorkspacePatch handles all concept, conceptFolder, deck, and question mutations without workspace reload", async () => {
  const userP = await register("cf-patch");
  const initial = await getWs(userP);
  const rootDeckId = initial.decks[0].id;

  // 1. /api/decks create -> returns patched workspace immediately
  const deckCreateBody = { action: "create", title: "算法", parentId: null, description: "题单", color: "blue" };
  const deckCreateRes = await (await decksRoute.POST(req(userP, "/api/decks", deckCreateBody))).json();
  let ws = applyLocalWorkspacePatch(initial, "/api/decks", deckCreateBody, deckCreateRes)!;
  assert.ok(ws, "/api/decks create must patch locally");
  assert.ok(ws.decks.some((d) => d.id === deckCreateRes.id && d.title === "算法"));

  // 2. /api/questions create -> inserts question + updates deck count & stats locally
  const qCreateBody = {
    action: "create",
    deckId: deckCreateRes.id,
    title: "快速排序",
    answer: "分治排序算法",
    tags: ["排序"],
  };
  const qCreateRes = await (await questionsRoute.POST(req(userP, "/api/questions", qCreateBody))).json();
  ws = applyLocalWorkspacePatch(ws, "/api/questions", qCreateBody, qCreateRes)!;
  assert.ok(ws, "/api/questions create must patch locally");
  assert.equal(ws.questions.length, 1);
  assert.equal(ws.questions[0].folderPath, "算法");
  assert.equal(ws.decks.find((d) => d.id === deckCreateRes.id)!.count, 1);
  assert.equal(ws.stats.total, 1);

  // 3. /api/decks edit -> updates deck title & refreshes question folderPath locally
  const deckEditBody = {
    action: "edit",
    deckId: deckCreateRes.id,
    title: "核心算法",
    description: "题单",
    expected: { title: "算法", description: "题单" },
  };
  const deckEditRes = await (await decksRoute.POST(req(userP, "/api/decks", deckEditBody))).json();
  ws = applyLocalWorkspacePatch(ws, "/api/decks", deckEditBody, deckEditRes)!;
  assert.ok(ws, "/api/decks edit must patch locally");
  assert.equal(ws.questions[0].folderPath, "核心算法");

  // 4. /api/concepts createFolder & create concept -> updates conceptFolders & counts locally
  const cfBody = { action: "createFolder", title: "基础", parentId: null, color: "sage" };
  const cfRes = await (await conceptsRoute.POST(req(userP, "/api/concepts", cfBody))).json();
  ws = applyLocalWorkspacePatch(ws, "/api/concepts", cfBody, cfRes)!;
  assert.ok(ws, "/api/concepts createFolder must patch locally");
  assert.equal(ws.conceptFolders.length, 1);

  const cBody = {
    action: "create",
    term: "时间复杂度",
    definition: "渐近上界 O(n log n)",
    folderId: cfRes.folder.id,
    color: "accent",
  };
  const cRes = await (await conceptsRoute.POST(req(userP, "/api/concepts", cBody))).json();
  ws = applyLocalWorkspacePatch(ws, "/api/concepts", cBody, cRes)!;
  assert.ok(ws, "/api/concepts create must patch locally");
  assert.equal(ws.concepts.length, 1);
  assert.equal(ws.conceptFolders[0].count, 1);

  // 5. /api/questions addAnnotation with saveAsConcept -> merges concept into ws.concepts locally!
  const annBody = {
    action: "addAnnotation",
    id: qCreateRes.id,
    quote: "分治",
    comment: "将大问题拆解为子问题递归求解",
    color: "amber",
    saveAsConcept: true,
    conceptFolderId: cfRes.folder.id,
  };
  const annRes = await (await questionsRoute.POST(req(userP, "/api/questions", annBody))).json();
  ws = applyLocalWorkspacePatch(ws, "/api/questions", annBody, annRes)!;
  assert.ok(ws, "/api/questions addAnnotation must patch locally");
  assert.equal(ws.concepts.length, 2);
  assert.equal(ws.conceptFolders[0].count, 2);

  // 6. /api/questions move -> updates folderPath & deck counts locally
  const qMoveBody = {
    action: "move",
    id: qCreateRes.id,
    deckId: rootDeckId,
    duplicateStrategy: "check",
  };
  const qMoveRes = await (await questionsRoute.POST(req(userP, "/api/questions", qMoveBody))).json();
  ws = applyLocalWorkspacePatch(ws, "/api/questions", qMoveBody, qMoveRes)!;
  assert.ok(ws, "/api/questions move must patch locally");
  assert.equal(ws.decks.find((d) => d.id === deckCreateRes.id)!.count, 0);
  assert.equal(ws.decks.find((d) => d.id === rootDeckId)!.count, 1);

  // 7. /api/questions delete -> removes question & updates stats locally
  const qDelBody = { action: "delete", id: qCreateRes.id };
  const qDelRes = await (await questionsRoute.POST(req(userP, "/api/questions", qDelBody))).json();
  ws = applyLocalWorkspacePatch(ws, "/api/questions", qDelBody, qDelRes)!;
  assert.ok(ws, "/api/questions delete must patch locally");
  assert.equal(ws.questions.length, 0);
  assert.equal(ws.stats.total, 0);

  // Verify patched state matches fresh server snapshot on counts & concepts!
  const serverWs = await getWs(userP);
  assert.equal(ws.questions.length, serverWs.questions.length);
  assert.equal(ws.concepts.length, serverWs.concepts.length);
  assert.equal(ws.conceptFolders.length, serverWs.conceptFolders.length);
  assert.deepEqual(
    recomputeConceptFolderState(ws.conceptFolders, ws.concepts).conceptFolders.map((f) => [f.id, f.count]),
    serverWs.conceptFolders.map((f) => [f.id, f.count]),
  );
});
