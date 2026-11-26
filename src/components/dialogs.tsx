"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  FolderTree as FolderTreeIcon,
  Info,
  Loader2,
  Lock,
  Plus,
  Rss,
} from "lucide-react";
import { toast } from "sonner";
import type { DeckView, DuplicateHit, Workspace } from "@/lib/types";
import {
  batchPublishDecks,
  unpublishDeck,
  type WorkspaceMutate,
} from "@/lib/client";
import { normalizeTagValue } from "@/lib/markdown-source";
import { buildFolderIndex, ROOT_FOLDER_LABEL } from "@/lib/folders";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { FolderSelectOptions } from "./folder-select-options";
import { isImeComposing } from "./folder-dialogs";

export type Mutate = WorkspaceMutate;

function submitOnEnter(
  event: React.KeyboardEvent<HTMLInputElement>,
  canSubmit: boolean,
  submit: () => void | Promise<void>,
) {
  if (event.key === "Enter" && !isImeComposing(event) && canSubmit) {
    event.preventDefault();
    void submit();
  }
}

function submitOnCtrlEnter(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  canSubmit: boolean,
  submit: () => void | Promise<void>,
) {
  if (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    !isImeComposing(event) &&
    canSubmit
  ) {
    event.preventDefault();
    void submit();
  }
}

export function CreateQuestionDialog({
  open,
  defaultDeckId,
  data,
  mutate,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaultDeckId?: string | null;
  data: Workspace;
  mutate: Mutate;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [deckId, setDeckId] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const ownedDecks = useMemo(
    () => data.decks.filter((d) => d.isOwner),
    [data.decks],
  );

  useEffect(() => {
    if (!open) return;
    const preferredDeck =
      defaultDeckId && ownedDecks.some((d) => d.id === defaultDeckId)
        ? defaultDeckId
        : "";
    setDeckId(preferredDeck);
  }, [open, defaultDeckId, ownedDecks]);

  const parsedTags = [
    ...new Set(tagsInput.split(/[,，]/).map(normalizeTagValue).filter(Boolean)),
  ];
  const tagsTooMany = parsedTags.length > 12;
  const tagTooLong = parsedTags.some((t) => t.length > 30);
  const invalid =
    !title.trim() ||
    title.trim().length > 200 ||
    answer.length > 100_000 ||
    tagsTooMany ||
    tagTooLong;

  async function create() {
    if (invalid || busy) return;
    setBusy(true);
    try {
      const result = await mutate("/api/questions", {
        action: "create",
        deckId: deckId || null,
        title: title.trim(),
        answer,
        tags: parsedTags,
      });
      if (result?.id) {
        const duplicates = Array.isArray(result.duplicates)
          ? (result.duplicates as DuplicateHit[])
          : [];
        setTitle("");
        setTagsInput("");
        setAnswer("");
        onClose();
        if (duplicates.length > 0) {
          toast.info(
            `已保存。提示：在「${duplicates[0].path}」已有相同内容，可在「重复内容」中合并整理。`,
          );
        } else {
          toast.success("已保存到资料库。");
        }
        onCreated(String(result.id));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title="新建资料"
      description="记录一道面试题或整篇笔记，答案可先留空稍后补充。"
    >
      <div className="dialog-form">
        <label className="field">
          标题 / 题干
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => submitOnEnter(e, !busy && !invalid, create)}
            maxLength={200}
            disabled={busy}
            placeholder="例如：MySQL 事务隔离级别与 MVCC 是如何配合的？"
            autoFocus
          />
        </label>
        <label className="field">
          存放文件夹
          <select
            aria-label="存放文件夹"
            value={deckId}
            disabled={busy}
            onChange={(e) => setDeckId(e.target.value)}
          >
            <FolderSelectOptions
              decks={data.decks}
              includeRoot
              rootLabel={ROOT_FOLDER_LABEL}
            />
          </select>
        </label>
        <label className="field">
          标签（逗号分隔，最多 12 个）
          <input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            onKeyDown={(e) => submitOnEnter(e, !busy && !invalid, create)}
            disabled={busy}
            placeholder="例如：MySQL, 索引, 高频追问"
          />
          {(tagsTooMany || tagTooLong) && (
            <small className="danger-text">
              {tagsTooMany
                ? "最多填写 12 个标签。"
                : "单个标签不超过 30 个字。"}
            </small>
          )}
        </label>
        <label className="field">
          正文 / 参考答案（可选，支持 Markdown）
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => submitOnCtrlEnter(e, !busy && !invalid, create)}
            rows={6}
            maxLength={100_000}
            disabled={busy}
            placeholder="写下要点、代码块或追问；暂时留空将自动归入「待补答案」…"
          />
        </label>
      </div>
      <div className="dialog-footer">
        <span className="muted small">
          {answer.trim()
            ? `已填 ${answer.trim().length} 字（Ctrl/⌘+Enter 保存）`
            : "答案留空将自动进入待补答案"}
        </span>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button disabled={busy || invalid} onClick={() => void create()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}{" "}
          保存资料
        </Button>
      </div>
    </Dialog>
  );
}

export function PublishDialog({
  deck,
  decks = [],
  onClose,
  mutate,
}: {
  deck: DeckView | null;
  decks?: readonly DeckView[];
  onClose: () => void;
  mutate: Mutate;
}) {
  const [visibility, setVisibility] = useState<"public" | "unlisted">("public");
  const [summary, setSummary] = useState("");
  const [syncRelated, setSyncRelated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");

  const index = useMemo(() => buildFolderIndex(decks), [decks]);

  const scopePreview = useMemo(() => {
    if (!deck) return null;
    const subtreeIds = index.subtreeOwnedIds(deck.id);
    const subfolderCount = Math.max(0, subtreeIds.size - 1);
    let excludedSubCount = 0;
    for (const id of subtreeIds) {
      excludedSubCount += (index.subscriptionsByFolder.get(id) ?? []).length;
    }
    const publishedAncestors = index.publishedAncestors(deck.id);
    const publishedDescendants = index.publishedDescendants(deck.id);
    const relatedPublished = [...publishedAncestors, ...publishedDescendants];
    const syncableRelated = relatedPublished.filter(
      (f) => f.publishStatus === "changes",
    );
    return {
      subfolderCount,
      excludedSubCount,
      publishedAncestors,
      publishedDescendants,
      relatedPublished,
      syncableRelated,
      fullPath: index.pathOf(deck.id),
    };
  }, [deck, index]);

  useEffect(() => {
    if (deck) {
      setVisibility(deck.visibility === "unlisted" ? "unlisted" : "public");
      setSummary("");
      setSyncRelated(false);
      setLink("");
    }
  }, [deck?.id]);

  async function publish() {
    if (!deck) return;
    setBusy(true);
    try {
      let version = deck.publishedVersion + 1;
      if (syncRelated && scopePreview?.syncableRelated.length) {
        const items = [
          {
            deckId: deck.id,
            expectedVersion: deck.publishedVersion,
            visibility,
            summary,
            skipUnchanged: false,
          },
          ...scopePreview.syncableRelated.map((rel) => ({
            deckId: rel.id,
            expectedVersion: rel.publishedVersion,
            visibility:
              rel.visibility === "unlisted"
                ? ("unlisted" as const)
                : ("public" as const),
            summary,
            skipUnchanged: true,
          })),
        ];
        const res = await batchPublishDecks(mutate, {
          items,
          defaultVisibility: visibility,
          defaultSummary: summary,
          skipUnchanged: true,
        });
        if (!res) return;
        const results = Array.isArray(res.results)
          ? (res.results as {
              deckId: string;
              version: number;
              skipped: boolean;
            }[])
          : [];
        const primaryResult = results.find((r) => r.deckId === deck.id);
        if (primaryResult) version = primaryResult.version;
        const relatedUpdated = results.length
          ? results.filter((r) => r.deckId !== deck.id && !r.skipped).length
          : Math.max(0, Number(res.publishedCount ?? 1) - 1);
        const share = new URL("/", window.location.origin);
        share.searchParams.set("subscribe", deck.id);
        setLink(share.href);
        toast.success(
          relatedUpdated > 0
            ? `已发布本文件夹 v${version} 并同步更新 ${relatedUpdated} 个关联发布。`
            : `已发布 v${version}，关联文件夹均已是最新状态。`,
        );
      } else {
        const result = await mutate("/api/decks", {
          action: "publish",
          deckId: deck.id,
          expectedVersion: deck.publishedVersion,
          visibility,
          summary,
        });
        if (!result) return;
        const share = new URL("/", window.location.origin);
        share.searchParams.set("subscribe", deck.id);
        setLink(share.href);
        version = Number(result.version ?? version);
        toast.success(`已发布 v${version}，订阅者打开资料库时将收到更新提示。`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleUnpublish() {
    if (!deck || busy) return;
    setBusy(true);
    try {
      const result = await unpublishDeck(mutate, deck.id);
      if (result) {
        toast.success(
          "已转为私密，不再对外公开（既有订阅者的学习进度不受影响）。",
        );
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  const diff = deck?.unpublishedDiff;
  const canUnpublish = Boolean(
    deck && deck.publishedVersion > 0 && deck.visibility !== "private",
  );

  return (
    <Dialog
      open={!!deck}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title={deck?.publishedVersion ? "发布文件夹更新" : "发布文件夹"}
      description={scopePreview?.fullPath || deck?.title}
    >
      <div className="dialog-form">
        <div className="publish-notice">
          <Rss size={22} />
          <p>
            仅发布此刻快照中的自有内容（后续移入的新资料在再次点击「发布更新」前保持私密）；你的个人笔记与复习进度始终私有。
          </p>
        </div>

        {scopePreview && (
          <div className="publish-scope-box">
            <div className="publish-scope-line">
              <FolderTreeIcon size={15} />
              <span>
                本次将发布 <strong>{deck?.count ?? 0} 条自有资料</strong>
                {scopePreview.subfolderCount > 0
                  ? `（含 ${scopePreview.subfolderCount} 个子文件夹结构）`
                  : ""}
              </span>
            </div>
            {scopePreview.excludedSubCount > 0 && (
              <div className="publish-scope-line muted small">
                <Info size={14} />
                <span>
                  目录内放置的 {scopePreview.excludedSubCount}{" "}
                  个他人订阅资料将自动排除，不会对外发布。
                </span>
              </div>
            )}
            {scopePreview.relatedPublished.length > 0 && (
              <div className="publish-nested-notice">
                <p className="small">
                  {scopePreview.publishedAncestors.length > 0 && (
                    <>
                      上级已发布文件夹：
                      <strong>
                        {scopePreview.publishedAncestors
                          .map((f) => f.title)
                          .join("、")}
                      </strong>
                      。
                    </>
                  )}
                  {scopePreview.publishedDescendants.length > 0 && (
                    <>
                      子级已发布文件夹：
                      <strong>
                        {scopePreview.publishedDescendants
                          .map((f) => f.title)
                          .join("、")}
                      </strong>
                      。
                    </>
                  )}
                  各层快照相互独立，不会互相覆盖。
                </p>
                {scopePreview.syncableRelated.length > 0 ? (
                  <label className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={syncRelated}
                      disabled={busy}
                      onChange={(e) => setSyncRelated(e.target.checked)}
                    />
                    <span>
                      同时同步推送更新到 {scopePreview.syncableRelated.length}{" "}
                      个有待更新改动的关联文件夹（
                      {scopePreview.syncableRelated
                        .map((f) => f.title)
                        .join("、")}
                      ）
                    </span>
                  </label>
                ) : (
                  <p className="muted small">
                    关联已发布文件夹当前均与已发布版本一致，无需同步推送。
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {deck && deck.publishedVersion > 0 && (
          <div className="update-diff-pills" aria-label="本次改动概览">
            {deck.publishStatus === "changes" && diff ? (
              <>
                {diff.added > 0 && (
                  <span className="update-diff-pill is-added">
                    +{diff.added} 新增
                  </span>
                )}
                {diff.updated > 0 && (
                  <span className="update-diff-pill is-updated">
                    ~{diff.updated} 修改
                  </span>
                )}
                {diff.removed > 0 && (
                  <span className="update-diff-pill is-removed">
                    -{diff.removed} 移除
                  </span>
                )}
                {diff.groupsChanged && (
                  <span className="update-diff-pill">目录结构已调整</span>
                )}
                {diff.metaChanged && (
                  <span className="update-diff-pill">文件夹信息已更新</span>
                )}
              </>
            ) : deck.visibility === "private" ? (
              <span className="muted small">
                当前为私密状态（上次发布 v{deck.publishedVersion}
                ），发布后将重新对外可见。
              </span>
            ) : (
              <span className="muted small">
                当前内容与已发布 v{deck.publishedVersion} 一致
              </span>
            )}
          </div>
        )}

        <label className="field">
          谁可以找到这个文件夹
          <select
            value={visibility}
            disabled={busy}
            onChange={(e) =>
              setVisibility(e.target.value as "public" | "unlisted")
            }
          >
            <option value="public">公开 · 显示在发现页中</option>
            <option value="unlisted">通过链接访问 · 不显示在发现页</option>
          </select>
        </label>
        <label className="field">
          这次更新了什么？
          <textarea
            value={summary}
            disabled={busy}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="例如：补充了事件循环的代码示例，修正缓存相关答案。"
          />
        </label>
        {link && (
          <div className="share-link">
            <input aria-label="订阅链接" readOnly value={link} />
            <Button
              size="icon"
              variant="ghost"
              aria-label="复制订阅链接"
              onClick={() => {
                void navigator.clipboard
                  .writeText(link)
                  .then(() => toast.success("订阅链接已复制。"));
              }}
            >
              <Copy size={16} />
            </Button>
          </div>
        )}
      </div>
      <div className="dialog-footer">
        <span className="muted small">共 {deck?.count ?? 0} 条自有资料</span>
        {canUnpublish && !link && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void handleUnpublish()}
          >
            <Lock size={14} /> 转为私密
          </Button>
        )}
        {link ? (
          <Button onClick={onClose}>
            <Check size={15} /> 完成
          </Button>
        ) : (
          <Button
            disabled={busy || (!deck?.count && !deck?.publishedVersion)}
            onClick={() => void publish()}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Rss size={16} />}{" "}
            {deck?.publishedVersion ? "发布更新" : "确认发布"}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
