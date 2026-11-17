"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Check,
  ClipboardPaste,
  FileText,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Download,
  Sun,
  Moon,
  Rss,
  Copy,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import type { Workspace, QuestionView, DeckView } from "@/lib/types";
import { parseQuestions } from "@/lib/importer";
import { api } from "@/lib/client";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { AiConnectionForm } from "./ai-connection-form";

const Editor = dynamic(() => import("./editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <div className="editor-loading">正在加载编辑器…</div>,
});
export type Mutate = (
  url: string,
  data: unknown,
) => Promise<Record<string, unknown> | null>;

export function ImportDialog({
  open,
  onClose,
  data,
  preferredDeck,
  mutate,
  onView,
}: {
  open: boolean;
  onClose: () => void;
  data: Workspace;
  preferredDeck?: string;
  mutate: Mutate;
  onView: (deckId: string) => void;
}) {
  const own = data.decks.filter((d) => d.isOwner);
  const [deckId, setDeckId] = useState(preferredDeck ?? own[0]?.id ?? "");
  const [raw, setRaw] = useState("");
  const [mode, setMode] = useState("rules");
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [result, setResult] = useState<{
    added: number;
    duplicates: number;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const latest = useRef({ deckId, mode });
  latest.current = { deckId, mode };
  const storageKey = `shiyi:import:${data.user.id}`;
  useEffect(() => {
    if (open) {
      setRaw(localStorage.getItem(storageKey) ?? "");
      setResult(null);
      if (preferredDeck && own.some((d) => d.id === preferredDeck))
        setDeckId(preferredDeck);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, preferredDeck, storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = parseQuestions(raw);
  function updateRaw(value: string) {
    setRaw(value);
    localStorage.setItem(storageKey, value);
    setResult(null);
  }
  async function importRaw(value = raw) {
    if (!value.trim() || !latest.current.deckId || inFlight.current) return;
    if (timer.current) clearTimeout(timer.current);
    setScheduled(false);
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await mutate("/api/import", {
        batchId: crypto.randomUUID(),
        deckId: latest.current.deckId,
        raw: value,
        mode: latest.current.mode,
      });
      if (response) {
        const stats = {
          added: Number(response.added),
          duplicates: Number(response.duplicates),
        };
        setResult(stats);
        localStorage.removeItem(storageKey);
        toast.success(
          `已入库 ${stats.added} 道题${stats.duplicates ? `，跳过 ${stats.duplicates} 道重复内容` : ""}`,
        );
      }
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  function close() {
    if (timer.current) clearTimeout(timer.current);
    setScheduled(false);
    onClose();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) close();
      }}
      title="导入面试题"
      className="import-dialog"
    >
      <div className="import-options">
        <label className="field">
          保存到题库
          <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            {own.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented">
          <button
            className={mode === "rules" ? "selected" : ""}
            onClick={() => setMode("rules")}
          >
            <FileText size={14} /> 标准解析
          </button>
          <button
            className={mode === "ai" ? "selected" : ""}
            disabled={!data.settings.hasKey}
            title={
              !data.settings.hasKey
                ? "先在设置中配置 API Key"
                : "使用自己的 Key 整理资料"
            }
            onClick={() => setMode("ai")}
          >
            <Sparkles size={14} /> AI 整理
          </button>
        </div>
      </div>
      <div className="import-columns">
        <div className="import-input-area">
          <div className="input-caption">
            <span>
              <ClipboardPaste size={15} /> 粘贴面试资料
            </span>
            <span>{raw.length.toLocaleString()} / 100,000</span>
          </div>
          <textarea
            aria-label="面试资料"
            placeholder={"## 题目\n参考答案…"}
            value={raw}
            maxLength={100000}
            disabled={busy}
            onChange={(e) => {
              if (timer.current) clearTimeout(timer.current);
              setScheduled(false);
              updateRaw(e.target.value);
            }}
            onPaste={(e) => {
              if (busy) return;
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              const target = e.currentTarget;
              const next =
                raw.slice(0, target.selectionStart) +
                text +
                raw.slice(target.selectionEnd);
              if (next.length > 100000) {
                toast.error("内容过长，请分批粘贴。");
                return;
              }
              updateRaw(next);
              if (auto && next.trim()) {
                if (timer.current) clearTimeout(timer.current);
                setScheduled(true);
                timer.current = setTimeout(() => void importRaw(next), 1200);
              }
            }}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              disabled={busy}
            />{" "}
            粘贴后自动入库
            {scheduled && <span>即将入库…</span>}
          </label>
        </div>
        <div className="import-preview">
          <div className="input-caption">
            <span>识别预览</span>
            <span>{parsed.length} 道题</span>
          </div>
          {parsed.length ? (
            <div className="import-preview-list">
              {parsed.slice(0, 30).map((q, i) => (
                <div key={i}>
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{q.title}</strong>
                    <p>
                      {q.needsEditing
                        ? "待补充答案"
                        : q.answer.replace(/[#*`>]/g, "").slice(0, 80)}
                    </p>
                  </div>
                </div>
              ))}
              {parsed.length > 30 && (
                <p className="muted">另有 {parsed.length - 30} 道题…</p>
              )}
            </div>
          ) : (
            <div className="preview-empty">
              <FileText size={30} />
              <p>粘贴资料后预览</p>
            </div>
          )}
        </div>
      </div>
      {result && (
        <div className="import-result" role="status">
          <Check size={18} /> 已入库 {result.added} 道题
          {result.duplicates ? `，跳过 ${result.duplicates} 道重复内容` : ""}
          <button
            className="text-button"
            onClick={() => {
              close();
              onView(deckId);
            }}
          >
            去题库看看
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="dialog-footer">
        <Button
          disabled={busy || !raw.trim() || !deckId || result !== null}
          onClick={() => void importRaw()}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}{" "}
          {busy ? "正在整理入库…" : `导入 ${parsed.length} 道题`}
        </Button>
      </div>
    </Dialog>
  );
}

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
      description="给这一组知识，一个清楚的名字。"
    >
      <div className="dialog-form">
        <label className="field">
          题库名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="例如：Java 后端核心知识"
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
            placeholder="准备学习哪些内容？"
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
        <span className="muted small">创建后默认只有你自己可见。</span>
        <Button disabled={busy || !title.trim()} onClick={() => void create()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}{" "}
          创建题库
        </Button>
      </div>
    </Dialog>
  );
}

export function EditQuestionDialog({
  question,
  onClose,
  mutate,
}: {
  question: QuestionView | null;
  onClose: () => void;
  mutate: Mutate;
}) {
  const [title, setTitle] = useState("");
  const [answer, setAnswer] = useState("");
  const [tags, setTags] = useState("");
  const [major, setMajor] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (question) {
      setTitle(question.title);
      setAnswer(question.answer);
      setTags(question.tags.join(", "));
      setMajor(false);
    }
  }, [question?.id]);
  async function save() {
    if (!question) return;
    setBusy(true);
    try {
      const result = await mutate("/api/questions", {
        action: "edit",
        id: question.id,
        expectedRevision: question.revision,
        title,
        answer,
        tags: Array.from(
          new Set(
            tags
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ),
        major,
      });
      if (result) {
        toast.success(
          "题目已保存。已发布题库需要再次发布，订阅者才会收到修改。",
        );
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={!!question}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="整理这道题"
      description="把答案改写成自己理解和表达的方式。"
      className="edit-dialog"
    >
      <div className="dialog-form">
        <label className="field">
          题目
          <input
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="field">
          参考答案
          {question && (
            <Editor
              key={question.id}
              value={question.answer}
              onChange={setAnswer}
            />
          )}
        </div>
        <label className="field">
          标签
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="用逗号分隔，例如：React, 高频, Hooks"
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={major}
            onChange={(e) => setMajor(e.target.checked)}
          />{" "}
          重要修正，提醒重新复习
        </label>
      </div>
      <div className="dialog-footer">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button disabled={busy || !title.trim()} onClick={() => void save()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{" "}
          保存修改
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
        setLink(`${window.location.origin}/?subscribe=${deck.id}`);
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
          <p>发布后的内容可被其他用户订阅。</p>
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
}: {
  open: boolean;
  onClose: () => void;
  data: Workspace;
  mutate: Mutate;
}) {
  const [tab, setTab] = useState("ai");
  const [goal, setGoal] = useState(data.settings.dailyGoal);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(data.settings.theme);
  useEffect(() => {
    if (open) {
      setGoal(data.settings.dailyGoal);
      setTheme(data.settings.theme);
    }
  }, [open]);
  async function savePreferences() {
    setBusy(true);
    try {
      const result = await mutate("/api/settings", {
        action: "preferences",
        dailyGoal: Number(goal),
        theme,
        timeZone: data.settings.timeZone,
      });
      if (result) toast.success("学习偏好已保存。");
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
      title="让拾忆更适合你"
      description="管理 AI 连接、学习节奏与自己的数据。"
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
          <AiConnectionForm settings={data.settings} mutate={mutate} />
        ) : tab === "study" ? (
          <>
            <label className="field">
              每日复习目标
              <div className="goal-input">
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={goal}
                  onChange={(e) => setGoal(Number(e.target.value))}
                />
                <span>次 / 天</span>
              </div>
              <small>这是节奏提醒；到期题目仍会完整显示。</small>
            </label>
            <div className="field">
              界面主题
              <div className="theme-options">
                <button
                  className={theme === "light" ? "selected" : ""}
                  onClick={() => setTheme("light")}
                >
                  <Sun size={22} /> 清晨 · 浅色
                </button>
                <button
                  className={theme === "dark" ? "selected" : ""}
                  onClick={() => setTheme("dark")}
                >
                  <Moon size={22} /> 夜读 · 深色
                </button>
              </div>
            </div>
            <div className="security-note">
              <FileText size={17} />
              <p>
                复习采用 FSRS-7，目标保持率为
                90%。实际间隔由你每次的记忆反馈决定。统计时区：
                {data.settings.timeZone}。
              </p>
            </div>
            <Button
              disabled={busy || goal < 1 || goal > 200}
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
              导出包含题库内容、私人笔记、完整复习历史、导入原文以及 AI 对话的
              JSON 文件。API Key 不包含在导出中。
            </p>
            <Button asChild variant="outline">
              <a href="/api/export" download>
                <Download size={16} /> 导出我的数据
              </a>
            </Button>
            <p className="muted small">
              当前提供备份导出。完整备份恢复功能尚未提供。
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
