"use client";
import { useEffect, useState } from "react";
import {
  Check,
  Loader2,
  Plus,
  Sparkles,
  Download,
  Sun,
  Moon,
  Rss,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import type { Workspace, DeckView } from "@/lib/types";
import { api } from "@/lib/client";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { AiConnectionForm } from "./ai-connection-form";

export type Mutate = (
  url: string,
  data: unknown,
) => Promise<Record<string, unknown> | null>;

export function CreateDeckDialog({
  open,
  onClose,
  mutate,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  mutate: Mutate;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("sage");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const result = await mutate("/api/decks", {
        action: "create",
        title,
        description,
        color,
      });
      if (result) {
        const deck = result.deck as { id: string };
        setTitle("");
        setDescription("");
        onClose();
        onCreated(deck.id);
        toast.success("新的题库已经准备好。");
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="新建一个题库"
      description="按技术栈或面试专题归类题目。"
    >
      <div className="dialog-form">
        <label className="field">
          题库名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="例如：前端工程化、MySQL 索引与锁、高并发系统设计"
            autoFocus
          />
        </label>
        <label className="field">
          简单介绍
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="写一句话备注题库范围、目标岗位或当前复习重心（可选）…"
          />
        </label>
        <div className="field">
          主题颜色
          <div className="color-options">
            {["sage", "blue", "sand", "rose"].map((c) => (
              <button
                key={c}
                className={`color-swatch color-${c} ${color === c ? "selected" : ""}`}
                aria-label={
                  {
                    sage: "鼠尾草绿",
                    blue: "雾蓝",
                    sand: "暖沙",
                    rose: "浅玫瑰",
                  }[c]
                }
                onClick={() => setColor(c)}
              >
                {color === c && <Check size={18} />}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="dialog-footer">
        <span className="muted small">默认仅自己可见。</span>
        <Button disabled={busy || !title.trim()} onClick={() => void create()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}{" "}
          创建题库
        </Button>
      </div>
    </Dialog>
  );
}

export function PublishDialog({
  deck,
  onClose,
  mutate,
}: {
  deck: DeckView | null;
  onClose: () => void;
  mutate: Mutate;
}) {
  const [visibility, setVisibility] = useState("public");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  useEffect(() => {
    if (deck) {
      setVisibility(deck.visibility === "unlisted" ? "unlisted" : "public");
      setSummary("");
      setLink("");
    }
  }, [deck?.id]);
  async function publish() {
    if (!deck) return;
    setBusy(true);
    try {
      const result = await mutate("/api/decks", {
        action: "publish",
        deckId: deck.id,
        expectedVersion: deck.publishedVersion,
        visibility,
        summary,
      });
      if (result) {
        const share = new URL("/", window.location.origin);
        share.searchParams.set("subscribe", deck.id);
        setLink(share.href);
        toast.success(`已发布 v${result.version}，订阅者将自动收到新版本。`);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={!!deck}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={deck?.publishedVersion ? "发布更新" : "发布题库"}
      description={deck?.title}
    >
      <div className="dialog-form">
        <div className="publish-notice">
          <Rss size={23} />
          <p>发布只读快照供他人订阅；个人笔记与复习进度始终私有。</p>
        </div>
        <label className="field">
          谁可以找到这个题库
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
          >
            <option value="public">公开 · 显示在发现题库中</option>
            <option value="unlisted">通过链接访问 · 不显示在发现页</option>
          </select>
        </label>
        <label className="field">
          这次更新了什么？
          <textarea
            value={summary}
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
        <span className="muted small">
          {deck?.count ?? 0} 道题 · 下个版本 v
          {(deck?.publishedVersion ?? 0) + 1}
        </span>
        {link ? (
          <Button onClick={onClose}>完成</Button>
        ) : (
          <Button
            disabled={busy || (!deck?.count && !deck?.publishedVersion)}
            onClick={() => void publish()}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Rss size={16} />}{" "}
            发布版本
          </Button>
        )}
      </div>
    </Dialog>
  );
}

export function SettingsDialog({
  open,
  onClose,
  data,
  mutate,
  palette = "forest",
  onPaletteChange,
}: {
  open: boolean;
  onClose: () => void;
  data: Workspace;
  mutate: Mutate;
  palette?: "forest" | "lavender";
  onPaletteChange?: (palette: "forest" | "lavender") => void;
}) {
  const [tab, setTab] = useState("ai");
  const [goal, setGoal] = useState(data.settings.dailyGoal);
  const [newLimit, setNewLimit] = useState(data.settings.dailyNewLimit);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(data.settings.theme);
  const [draftPalette, setDraftPalette] = useState<"forest" | "lavender">(
    palette,
  );
  useEffect(() => {
    if (open) {
      setGoal(data.settings.dailyGoal);
      setNewLimit(data.settings.dailyNewLimit);
      setTheme(data.settings.theme);
      setDraftPalette(palette);
    }
  }, [open, palette]);
  async function savePreferences() {
    setBusy(true);
    try {
      onPaletteChange?.(draftPalette);
      const result = await mutate("/api/settings", {
        action: "preferences",
        dailyGoal: Number(goal),
        dailyNewLimit: Number(newLimit),
        theme,
        timeZone: data.settings.timeZone,
      });
      if (result) toast.success("学习偏好已保存。");
    } finally {
      setBusy(false);
    }
  }
  async function exportData() {
    setBusy(true);
    try {
      const result = await api("/api/export", undefined, {
        userId: data.user.id,
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `shiyi-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "导出失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  function close() {
    document.documentElement.dataset.theme = data.settings.theme;
    document.documentElement.dataset.palette = palette;
    onClose();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title="让拾忆更适合你"
      description="管理 AI 连接、学习偏好与数据备份。"
      className="settings-dialog"
    >
      <div className="settings-tabs">
        <button
          className={tab === "ai" ? "selected" : ""}
          onClick={() => setTab("ai")}
        >
          <Sparkles size={15} /> AI 连接
        </button>
        <button
          className={tab === "study" ? "selected" : ""}
          onClick={() => setTab("study")}
        >
          学习偏好
        </button>
        <button
          className={tab === "data" ? "selected" : ""}
          onClick={() => setTab("data")}
        >
          数据导出
        </button>
      </div>
      <div className="dialog-form">
        {tab === "ai" ? (
          <AiConnectionForm
            userId={data.user.id}
            settings={data.settings}
            mutate={mutate}
          />
        ) : tab === "study" ? (
          <>
            <label className="field">
              每日学习目标
              <div className="goal-input">
                <input
                  type="number"
                  aria-label="每日学习目标"
                  min={1}
                  max={200}
                  value={goal}
                  onChange={(e) => setGoal(Number(e.target.value))}
                />
                <span>道 / 天</span>
              </div>
              <small>同一道题当天只计一次；到期复习仍完整显示。</small>
            </label>
            <label className="field">
              每日新题上限
              <div className="goal-input">
                <input
                  aria-label="每日新题上限"
                  type="number"
                  min={0}
                  max={50}
                  value={newLimit}
                  onChange={(e) => setNewLimit(Number(e.target.value))}
                />
                <span>道 / 天</span>
              </div>
              <small>优先复习旧题；设为 0 可暂停新题。</small>
            </label>
            <div className="field">
              主题色系
              <div className="palette-options">
                <button
                  type="button"
                  className={draftPalette === "forest" ? "selected" : ""}
                  aria-pressed={draftPalette === "forest"}
                  onClick={() => {
                    setDraftPalette("forest");
                    document.documentElement.dataset.palette = "forest";
                  }}
                >
                  {draftPalette === "forest" && (
                    <span className="option-check" aria-hidden="true">
                      <Check size={12} />
                    </span>
                  )}
                  <span className="palette-swatches" aria-hidden="true">
                    <i style={{ background: "#133327" }} />
                    <i style={{ background: "#1B4D3A" }} />
                    <i style={{ background: "#5FA083" }} />
                    <i style={{ background: "#F4F5F6" }} />
                  </span>
                  <span className="palette-card-text">
                    <strong>墨绿 · 松烟</strong>
                    <small>深墨绿与纯白</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={draftPalette === "lavender" ? "selected" : ""}
                  aria-pressed={draftPalette === "lavender"}
                  onClick={() => {
                    setDraftPalette("lavender");
                    document.documentElement.dataset.palette = "lavender";
                  }}
                >
                  {draftPalette === "lavender" && (
                    <span className="option-check" aria-hidden="true">
                      <Check size={12} />
                    </span>
                  )}
                  <span className="palette-swatches" aria-hidden="true">
                    <i style={{ background: "#5C5082" }} />
                    <i style={{ background: "#B9AFD8" }} />
                    <i style={{ background: "#D7D1DC" }} />
                    <i style={{ background: "#F2EEEA" }} />
                  </span>
                  <span className="palette-card-text">
                    <strong>熏衣 · 雾紫</strong>
                    <small>月砂与奶霜</small>
                  </span>
                </button>
              </div>
            </div>
            <div className="field">
              明暗模式
              <div className="theme-options">
                <button
                  type="button"
                  className={theme === "light" ? "selected" : ""}
                  aria-pressed={theme === "light"}
                  onClick={() => {
                    setTheme("light");
                    document.documentElement.dataset.theme = "light";
                  }}
                >
                  {theme === "light" && (
                    <span className="option-check" aria-hidden="true">
                      <Check size={12} />
                    </span>
                  )}
                  <Sun size={22} /> 清晨 · 浅色
                </button>
                <button
                  type="button"
                  className={theme === "dark" ? "selected" : ""}
                  aria-pressed={theme === "dark"}
                  onClick={() => {
                    setTheme("dark");
                    document.documentElement.dataset.theme = "dark";
                  }}
                >
                  {theme === "dark" && (
                    <span className="option-check" aria-hidden="true">
                      <Check size={12} />
                    </span>
                  )}
                  <Moon size={22} /> 夜读 · 深色
                </button>
              </div>
            </div>
            <Button
              disabled={
                busy || goal < 1 || goal > 200 || newLimit < 0 || newLimit > 50
              }
              onClick={() => void savePreferences()}
            >
              保存学习偏好
            </Button>
          </>
        ) : (
          <>
            <div className="export-illustration">
              <Download size={32} />
            </div>
            <h3>你的积累，随时带走。</h3>
            <p className="muted">
              导出题库、笔记、复习记录、原文与 AI 对话的 JSON 备份（不含 API
              Key）。
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void exportData()}
            >
              <Download size={16} /> 导出我的数据
            </Button>
            <p className="muted small">
              当前支持导出备份文件，暂不支持导入恢复。
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
