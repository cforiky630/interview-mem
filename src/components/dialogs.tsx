"use client";
import { useEffect, useState } from "react";
import {
  Check,
  Loader2,
  Plus,
  Rss,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import type { Workspace, DeckView } from "@/lib/types";
import { normalizeTagValue } from "@/lib/markdown-source";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

export type Mutate = (
  url: string,
  data: unknown,
) => Promise<Record<string, unknown> | null>;

function submitOnEnter(
  event: React.KeyboardEvent<HTMLInputElement>,
  canSubmit: boolean,
  submit: () => void | Promise<void>,
) {
  if (event.key === "Enter" && !event.nativeEvent.isComposing && canSubmit) {
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
    !event.nativeEvent.isComposing &&
    canSubmit
  ) {
    event.preventDefault();
    void submit();
  }
}

const DECK_COLORS = [
  { id: "sage", label: "鼠尾草绿" },
  { id: "blue", label: "雾蓝" },
  { id: "sand", label: "暖沙" },
  { id: "rose", label: "浅玫瑰" },
] as const;

function DeckColorSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="color-options">
      {DECK_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`color-swatch color-${c.id} ${value === c.id ? "selected" : ""}`}
          aria-label={c.label}
          aria-pressed={value === c.id}
          onClick={() => onChange(c.id)}
        >
          {value === c.id && <Check size={18} />}
        </button>
      ))}
    </div>
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
      description="按技术栈或面试专题归类题目。"
    >
      <div className="dialog-form">
        <label className="field">
          题库名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) =>
              submitOnEnter(e, !busy && !!title.trim(), create)
            }
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
            onKeyDown={(e) =>
              submitOnCtrlEnter(e, !busy && !!title.trim(), create)
            }
            maxLength={500}
            rows={3}
            placeholder="写一句话备注题库范围、目标岗位或当前复习重心（可选）…"
          />
        </label>
        <div className="field">
          主题颜色
          <DeckColorSwatches value={color} onChange={setColor} />
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

export function EditDeckDialog({
  deck,
  onClose,
  mutate,
}: {
  deck: DeckView | null;
  onClose: () => void;
  mutate: Mutate;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("sage");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (deck) {
      setTitle(deck.title);
      setDescription(deck.description);
      setColor(deck.color || "sage");
    }
  }, [deck]);
  const validColor = DECK_COLORS.some((c) => c.id === deck?.color)
    ? deck?.color
    : undefined;
  const dirty =
    !!deck &&
    (title.trim() !== deck.title ||
      description !== deck.description ||
      color !== (deck.color || "sage"));
  async function save() {
    if (!deck || !title.trim() || busy) return;
    setBusy(true);
    try {
      const result = await mutate("/api/decks", {
        action: "edit",
        deckId: deck.id,
        expected: {
          title: deck.title,
          description: deck.description,
          ...(validColor ? { color: validColor } : {}),
        },
        title: title.trim(),
        description,
        color,
      });
      if (result) {
        toast.success("题库信息已更新。");
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={!!deck}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title="编辑题库"
      description="修改题库名称、简介或标识色。"
    >
      <div className="dialog-form">
        <label className="field">
          题库名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) =>
              submitOnEnter(e, !busy && !!title.trim() && dirty, save)
            }
            maxLength={80}
            disabled={busy}
            placeholder="输入题库名称"
            autoFocus
          />
        </label>
        <label className="field">
          简单介绍
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) =>
              submitOnCtrlEnter(e, !busy && !!title.trim() && dirty, save)
            }
            maxLength={500}
            rows={3}
            disabled={busy}
            placeholder="题库范围、目标岗位或复习重心（可选）…"
          />
        </label>
        <div className="field">
          主题颜色
          <DeckColorSwatches value={color} onChange={setColor} />
        </div>
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={busy || !title.trim() || !dirty}
          onClick={() => void save()}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{" "}
          保存修改
        </Button>
      </div>
    </Dialog>
  );
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
  const ownedDecks = data.decks.filter((d) => d.isOwner);
  useEffect(() => {
    if (!open) return;
    const preferred =
      defaultDeckId && ownedDecks.some((d) => d.id === defaultDeckId)
        ? defaultDeckId
        : "";
    setDeckId(preferred);
  }, [open, defaultDeckId]);
  const parsedTags = [
    ...new Set(
      tagsInput
        .split(/[,，]/)
        .map(normalizeTagValue)
        .filter(Boolean),
    ),
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
        setTitle("");
        setTagsInput("");
        setAnswer("");
        onClose();
        toast.success("题目已保存到题库。");
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
      title="新建单题"
      description="随手记录刚遇到的一道面试题，答案可先留空稍后整理。"
    >
      <div className="dialog-form">
        <label className="field">
          题干
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
          所属题库
          <select
            aria-label="所属题库"
            value={deckId}
            disabled={busy}
            onChange={(e) => setDeckId(e.target.value)}
          >
            <option value="">未分类</option>
            {ownedDecks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
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
              {tagsTooMany ? "最多填写 12 个标签。" : "单个标签不超过 30 个字。"}
            </small>
          )}
        </label>
        <label className="field">
          参考答案（可选，支持 Markdown）
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => submitOnCtrlEnter(e, !busy && !invalid, create)}
            rows={6}
            maxLength={100_000}
            disabled={busy}
            placeholder="写下要点、代码块或追问；暂时留空将自动归入「待整理」…"
          />
        </label>
      </div>
      <div className="dialog-footer">
        <span className="muted small">
          {answer.trim()
            ? `已填 ${answer.trim().length} 字（Ctrl/⌘+Enter 保存）`
            : "答案留空将自动进入待整理"}
        </span>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button disabled={busy || invalid} onClick={() => void create()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}{" "}
          保存题目
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
