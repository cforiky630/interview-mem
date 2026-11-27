"use client";

import { useEffect, useState } from "react";
import { BookmarkPlus, Layers2, Loader2 } from "lucide-react";
import type { ChatMessage, DeckView, QuestionView } from "@/lib/types";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { FolderSelectOptions } from "./folder-select-options";

export type AiSaveTarget =
  | { kind: "note"; message: ChatMessage }
  | { kind: "card"; message: ChatMessage };

export function AiSaveDialog({
  target,
  question,
  ownedDecks,
  defaultCardTitle,
  defaultDeckId,
  busy,
  onClose,
  onConfirmNote,
  onConfirmCard,
}: {
  target: AiSaveTarget | null;
  question: QuestionView | undefined;
  ownedDecks: DeckView[];
  defaultCardTitle: string;
  defaultDeckId: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirmNote: (heading: string) => Promise<boolean>;
  onConfirmCard: (payload: {
    title: string;
    deckId: string | null;
  }) => Promise<boolean>;
}) {
  const [heading, setHeading] = useState("AI 补充");
  const [title, setTitle] = useState("");
  const [deckId, setDeckId] = useState("");

  const targetKey = target ? `${target.kind}:${target.message.id}` : "";

  useEffect(() => {
    if (!target) return;
    setHeading("AI 补充");
    setTitle(defaultCardTitle);
    setDeckId(defaultDeckId ?? "");
  }, [targetKey, target, defaultCardTitle, defaultDeckId]);

  const rawContent = target?.message.content.trim() ?? "";
  const previewText =
    rawContent.length > 260 ? `${rawContent.slice(0, 260).trimEnd()}…` : rawContent;
  const existingNoteLen = question?.note.trim().length ?? 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!target || busy) return;
    if (target.kind === "note") {
      const ok = await onConfirmNote(heading.trim() || "AI 补充");
      if (ok) onClose();
      return;
    }
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    const ok = await onConfirmCard({
      title: cleanTitle,
      deckId: deckId || null,
    });
    if (ok) onClose();
  }

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={target?.kind === "card" ? "存为卡片" : "存为笔记"}
      className="ai-save-dialog"
    >
      {target && question && (
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="dialog-form ai-save-form">
            <div className="ai-save-explain">
              {target.kind === "note" ? (
                <>
                  <BookmarkPlus size={16} />
                  <p>追加到本题个人笔记末尾，不影响参考答案。</p>
                </>
              ) : (
                <>
                  <Layers2 size={16} />
                  <p>在资料中新建一条独立内容，后续会单独安排复习。</p>
                </>
              )}
            </div>

            <div className="ai-save-meta">
              <div>
                <span>{target.kind === "card" ? "来源题目" : "归属题目"}</span>
                <strong>{question.title}</strong>
              </div>
              {target.kind === "note" ? (
                <div>
                  <span>现有笔记</span>
                  <strong>
                    {existingNoteLen > 0 ? `已有 ${existingNoteLen} 字` : "暂无"}
                  </strong>
                </div>
              ) : (
                <div>
                  <span>标签</span>
                  <strong>
                    {question.tags.length ? question.tags.join("、") : "无"}
                  </strong>
                </div>
              )}
            </div>

            {target.kind === "note" ? (
              <label className="field">
                <span>小节标题</span>
                <input
                  type="text"
                  maxLength={40}
                  disabled={busy}
                  placeholder="AI 补充"
                  value={heading}
                  onChange={(e) => setHeading(e.target.value)}
                />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>卡片标题</span>
                  <input
                    type="text"
                    required
                    autoFocus
                    maxLength={200}
                    disabled={busy}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>存入文件夹</span>
                  <select
                    disabled={busy}
                    value={deckId}
                    onChange={(e) => setDeckId(e.target.value)}
                  >
                    <FolderSelectOptions decks={ownedDecks} includeRoot />
                  </select>
                </label>
              </>
            )}

            <div className="ai-save-preview-wrap">
              <div className="ai-save-preview-head">
                <span>{target.kind === "card" ? "答案预览" : "内容预览"}</span>
                <small>{rawContent.length} 字</small>
              </div>
              <pre className="ai-save-preview">{previewText}</pre>
            </div>
          </div>

          <div className="dialog-footer">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={busy || (target.kind === "card" && !title.trim())}
            >
              {busy && <Loader2 size={14} className="spin" />}
              {target.kind === "note" ? "追加到笔记" : "创建卡片"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
