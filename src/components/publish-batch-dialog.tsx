"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckSquare,
  Copy,
  Globe,
  Link2,
  Loader2,
  Rss,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import type { Workspace } from "@/lib/types";
import { batchPublishDecks } from "@/lib/client";
import { formatDiffSummary } from "@/lib/subscriptions";
import type { Mutate } from "./dialogs";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

type FilterTab = "changes" | "unpublished" | "all";

export function PublishBatchDialog({
  open,
  userId,
  decks,
  mutate,
  onClose,
}: {
  open: boolean;
  userId: string;
  decks: Workspace["decks"];
  mutate: Mutate;
  onClose: () => void;
}) {
  const ownedDecks = useMemo(() => decks.filter((d) => d.isOwner), [decks]);
  const changedDecks = useMemo(
    () => ownedDecks.filter((d) => d.publishStatus === "changes"),
    [ownedDecks],
  );
  const unpublishedDecks = useMemo(
    () =>
      ownedDecks.filter(
        (d) =>
          d.publishStatus === "unpublished" ||
          d.publishedVersion === 0 ||
          d.visibility === "private",
      ),
    [ownedDecks],
  );

  const [filter, setFilter] = useState<FilterTab>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<"public" | "unlisted">("public");
  const [defaultSummary, setDefaultSummary] = useState("");
  const [perDeckSummary, setPerDeckSummary] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [resultInfo, setResultInfo] = useState<{
    publishedCount: number;
    skippedCount: number;
    authorLink: string;
  } | null>(null);

  const isEligible = (d: Workspace["decks"][number]) =>
    d.count > 0 || d.publishedVersion > 0;

  useEffect(() => {
    if (!open) return;
    const initialFilter: FilterTab =
      changedDecks.length > 0
        ? "changes"
        : unpublishedDecks.length > 0
          ? "unpublished"
          : "all";
    setFilter(initialFilter);
    const defaultPick =
      changedDecks.length > 0
        ? changedDecks.filter(isEligible).map((d) => d.id)
        : unpublishedDecks.filter(isEligible).map((d) => d.id);
    setSelectedIds(defaultPick);
    setVisibility("public");
    setDefaultSummary("");
    setPerDeckSummary({});
    setResultInfo(null);
  }, [open]);

  const filteredDecks = useMemo(() => {
    if (filter === "changes") return changedDecks;
    if (filter === "unpublished") return unpublishedDecks;
    return ownedDecks;
  }, [filter, changedDecks, unpublishedDecks, ownedDecks]);

  const eligibleOwnedMap = useMemo(
    () => new Map(ownedDecks.filter(isEligible).map((d) => [d.id, d])),
    [ownedDecks],
  );
  const activeSelectedIds = useMemo(
    () => selectedIds.filter((id) => eligibleOwnedMap.has(id)),
    [selectedIds, eligibleOwnedMap],
  );
  const selectedSet = useMemo(
    () => new Set(activeSelectedIds),
    [activeSelectedIds],
  );
  const visibleEligibleIds = useMemo(
    () => filteredDecks.filter(isEligible).map((d) => d.id),
    [filteredDecks],
  );
  const allVisibleSelected =
    visibleEligibleIds.length > 0 &&
    visibleEligibleIds.every((id) => selectedSet.has(id));

  function toggleDeck(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function toggleSelectVisible() {
    if (allVisibleSelected) {
      const visibleSet = new Set(visibleEligibleIds);
      setSelectedIds((prev) => prev.filter((id) => !visibleSet.has(id)));
    } else {
      setSelectedIds((prev) => [...new Set([...prev, ...visibleEligibleIds])]);
    }
  }

  async function handlePublish() {
    if (!activeSelectedIds.length || busy) return;
    setBusy(true);
    try {
      const items = activeSelectedIds.map((id) => {
        const deck = eligibleOwnedMap.get(id)!;
        const custom = perDeckSummary[id]?.trim();
        return {
          deckId: deck.id,
          expectedVersion: deck.publishedVersion,
          visibility,
          ...(custom ? { summary: custom } : {}),
        };
      });
      const res = await batchPublishDecks(mutate, {
        items,
        defaultVisibility: visibility,
        defaultSummary: defaultSummary.trim(),
        skipUnchanged: false,
      });
      if (res) {
        const publishedCount = Number(res.publishedCount ?? items.length);
        const skippedCount = Number(res.skippedCount ?? 0);
        const linkUrl = new URL("/", window.location.origin);
        linkUrl.searchParams.set("view", "catalog");
        linkUrl.searchParams.set("author", userId);
        setResultInfo({
          publishedCount,
          skippedCount,
          authorLink: linkUrl.href,
        });
        toast.success(
          `已发布 ${publishedCount} 个题库，订阅者打开题库时将收到更新提示。`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="批量发布与更新"
      description="一次发布多个题库或推送最新改动，订阅者将按需确认更新；个人笔记与复习进度始终私有。"
      className="publish-batch-dialog"
    >
      <div className="dialog-form">
        <div
          className="publish-batch-filters"
          role="group"
          aria-label="筛选要发布的题库"
        >
          <button
            type="button"
            className={`deck-group-pill ${filter === "changes" ? "is-active" : ""}`}
            aria-pressed={filter === "changes"}
            disabled={busy}
            onClick={() => setFilter("changes")}
          >
            待更新 <small>{changedDecks.length}</small>
          </button>
          <button
            type="button"
            className={`deck-group-pill ${filter === "unpublished" ? "is-active" : ""}`}
            aria-pressed={filter === "unpublished"}
            disabled={busy}
            onClick={() => setFilter("unpublished")}
          >
            未公开 <small>{unpublishedDecks.length}</small>
          </button>
          <button
            type="button"
            className={`deck-group-pill ${filter === "all" ? "is-active" : ""}`}
            aria-pressed={filter === "all"}
            disabled={busy}
            onClick={() => setFilter("all")}
          >
            全部 <small>{ownedDecks.length}</small>
          </button>
          {visibleEligibleIds.length > 0 && (
            <button
              type="button"
              className="text-button"
              style={{ marginLeft: "auto", fontSize: "0.78rem" }}
              disabled={busy}
              onClick={toggleSelectVisible}
            >
              {allVisibleSelected ? "取消全选" : "全选当前"}
            </button>
          )}
        </div>

        <div className="publish-batch-list">
          {filteredDecks.length ? (
            filteredDecks.map((d) => {
              const eligible = isEligible(d);
              const selected = eligible && selectedSet.has(d.id);
              const statusPill =
                !eligible ? (
                  <span className="deck-status-pill is-unpublished">
                    空题库不可发布
                  </span>
                ) : d.publishStatus === "changes" && d.unpublishedDiff ? (
                  <span className="deck-status-pill is-changes">
                    v{d.publishedVersion} → v{d.publishedVersion + 1} ·{" "}
                    {formatDiffSummary(d.unpublishedDiff)}
                  </span>
                ) : d.publishedVersion === 0 ? (
                  <span className="deck-status-pill is-unpublished">未发布</span>
                ) : d.visibility === "private" ? (
                  <span className="deck-status-pill is-unpublished">
                    私密 v{d.publishedVersion}
                  </span>
                ) : (
                  <span className="deck-status-pill">
                    已同步 v{d.publishedVersion}
                  </span>
                );
              return (
                <div
                  key={d.id}
                  className={`publish-batch-row color-${d.color} ${selected ? "is-selected" : ""}`}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      minWidth: 0,
                    }}
                  >
                    <button
                      type="button"
                      className={`batch-check-btn ${selected ? "is-checked" : ""}`}
                      aria-label={
                        selected ? `取消选择：${d.title}` : `选择：${d.title}`
                      }
                      aria-pressed={selected}
                      disabled={busy || !eligible}
                      onClick={() => toggleDeck(d.id)}
                    >
                      {selected ? (
                        <CheckSquare size={17} />
                      ) : (
                        <Square size={17} />
                      )}
                    </button>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--deck-accent)",
                        flexShrink: 0,
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy || !eligible}
                      onClick={() => toggleDeck(d.id)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: "left",
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: "4px 8px",
                      }}
                    >
                      <strong
                        style={{
                          fontSize: "0.86rem",
                          color: "var(--text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "100%",
                        }}
                      >
                        {d.title}
                      </strong>
                      <small
                        style={{
                          fontSize: "0.74rem",
                          color: "var(--muted)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {d.count} 题
                      </small>
                      {statusPill}
                    </button>
                  </div>
                  {selected && (
                    <input
                      aria-label={`「${d.title}」本次更新说明（可选）`}
                      value={perDeckSummary[d.id] ?? ""}
                      onChange={(e) =>
                        setPerDeckSummary((prev) => ({
                          ...prev,
                          [d.id]: e.target.value,
                        }))
                      }
                      maxLength={1000}
                      disabled={busy}
                      placeholder="单独填写该题库更新说明（留空则使用下方统一说明）"
                    />
                  )}
                </div>
              );
            })
          ) : (
            <p className="muted" style={{ padding: "12px 4px", margin: 0 }}>
              {filter === "changes"
                ? "所有已发布题库均已是最新状态，没有待推送的改动。"
                : filter === "unpublished"
                  ? "所有自有题库均已公开发布。"
                  : "还没有自有题库。"}
            </p>
          )}
        </div>

        <div className="publish-batch-config">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: "0.8rem",
                fontWeight: 600,
                color: "var(--subtle)",
              }}
            >
              可见范围
            </span>
            <div className="group-view-toggle" role="group" aria-label="可见范围">
              <button
                type="button"
                className={visibility === "public" ? "is-active" : ""}
                aria-pressed={visibility === "public"}
                disabled={busy}
                onClick={() => setVisibility("public")}
              >
                <Globe size={13} />
                <span>公开到发现</span>
              </button>
              <button
                type="button"
                className={visibility === "unlisted" ? "is-active" : ""}
                aria-pressed={visibility === "unlisted"}
                disabled={busy}
                onClick={() => setVisibility("unlisted")}
              >
                <Link2 size={13} />
                <span>仅链接可订阅</span>
              </button>
            </div>
          </div>
          <label className="field">
            统一更新说明（可选）
            <input
              value={defaultSummary}
              onChange={(e) => setDefaultSummary(e.target.value)}
              maxLength={1000}
              disabled={busy}
              placeholder="例如：补充字节二面 5 道高频题、修正 MVCC 答案"
            />
          </label>
        </div>

        {resultInfo && (
          <div className="publish-batch-result">
            <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--text)" }}>
              已发布 {resultInfo.publishedCount} 个题库
              {resultInfo.skippedCount > 0
                ? `（跳过 ${resultInfo.skippedCount} 个无改动题库）`
                : ""}
              。分享你的创作者主页，同伴可一键订阅你的公开题库：
            </p>
            <div className="share-link">
              <input
                aria-label="创作者主页链接"
                readOnly
                value={resultInfo.authorLink}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label="复制创作者主页链接"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(resultInfo.authorLink)
                    .then(() => toast.success("创作者主页链接已复制。"));
                }}
              >
                <Copy size={16} />
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="dialog-footer">
        <span className="muted small">已选 {activeSelectedIds.length} 个题库</span>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {resultInfo ? "完成" : "取消"}
        </Button>
        {!resultInfo && (
          <Button
            disabled={busy || activeSelectedIds.length === 0}
            onClick={() => void handlePublish()}
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Rss size={15} />
            )}{" "}
            一键发布 / 更新 ({activeSelectedIds.length})
          </Button>
        )}
        {resultInfo && (
          <Button variant="outline" onClick={onClose}>
            <Check size={15} /> 关闭
          </Button>
        )}
      </div>
    </Dialog>
  );
}
