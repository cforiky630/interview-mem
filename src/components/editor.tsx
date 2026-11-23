"use client";
import { useEffect, useRef, useState } from "react";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type Editor as TiptapEditor,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import katex from "katex";
import {
  Bold,
  Code,
  Code2,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  ListPlus,
  MessageSquarePlus,
  Quote,
  Redo2,
  Sigma,
  Table2,
  Undo2,
} from "lucide-react";
import { Button } from "./ui/button";
import { markAsFollowup } from "@/lib/editor-document";
import { splitFrontmatter } from "@/lib/markdown-source";
import { BlockMath, InlineMath } from "@/lib/tiptap-math";

const MARKDOWN_PASTE_RE =
  /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\$\$|\|[^|\n]+\|)|(?:\*\*[^*\n]+\*\*|`[^`\n]+`|\$(?!\s)[^$\n]+?(?<!\s)\$)/;

function joinFrontmatter(prefix: string, body: string) {
  if (!prefix) return body;
  if (!body) return prefix;
  return prefix.endsWith("\n") ? prefix + body : `${prefix}\n${body}`;
}

function MathNodeView({
  node,
  updateAttributes,
  deleteNode,
  selected,
  editor,
  displayMode,
}: NodeViewProps & { displayMode: boolean }) {
  const latex = String(node.attrs.latex ?? "");
  const [editing, setEditing] = useState(!latex.trim());
  const [draft, setDraft] = useState(latex);
  const previewRef = useRef<HTMLElement | null>(null);
  const livePreviewRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(latex);
  }, [latex]);

  useEffect(() => {
    if (!editing && previewRef.current) {
      katex.render(latex || "\\text{公式}", previewRef.current, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
      });
    }
  }, [latex, editing, displayMode]);

  useEffect(() => {
    if (editing && displayMode && livePreviewRef.current) {
      katex.render(draft.trim() || "\\text{公式}", livePreviewRef.current, {
        displayMode: true,
        throwOnError: false,
        strict: "ignore",
        trust: false,
      });
    }
  }, [draft, editing, displayMode]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      if (displayMode) textareaRef.current?.focus();
      else inputRef.current?.focus();
    });
  }, [editing, displayMode]);

  function commit() {
    const cleaned = draft.trim();
    if (!cleaned) {
      deleteNode();
      editor.commands.focus();
      return;
    }
    if (cleaned !== latex) {
      updateAttributes({ latex: cleaned });
    }
    setEditing(false);
    editor.commands.focus();
  }

  function cancel() {
    if (!latex.trim()) {
      deleteNode();
    } else {
      setDraft(latex);
      setEditing(false);
    }
    editor.commands.focus();
  }

  if (displayMode) {
    return (
      <NodeViewWrapper
        className={`tiptap-math-block ${selected ? "is-selected" : ""}`}
        contentEditable={false}
      >
        {editing ? (
          <div
            className="tiptap-math-block-editor"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <textarea
              ref={textareaRef}
              rows={2}
              value={draft}
              aria-label="编辑块级公式 LaTeX"
              placeholder="输入 LaTeX 公式（Ctrl/⌘ + Enter 确认，Esc 取消）"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel();
                }
              }}
            />
            <div
              className="tiptap-math-live-preview"
              ref={livePreviewRef}
              aria-hidden="true"
            />
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            title="点击编辑块级公式"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => {
              if (editor.isEditable) setEditing(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && editor.isEditable) {
                e.preventDefault();
                setEditing(true);
              }
            }}
          >
            <span
              ref={(el) => {
                previewRef.current = el;
              }}
            />
          </div>
        )}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      className={`tiptap-math-inline ${selected ? "is-selected" : ""}`}
      contentEditable={false}
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          className="tiptap-math-inline-input"
          value={draft}
          aria-label="编辑行内公式 LaTeX"
          placeholder="LaTeX"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
        />
      ) : (
        <span
          role="button"
          tabIndex={0}
          title="点击编辑行内公式"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => {
            if (editor.isEditable) setEditing(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && editor.isEditable) {
              e.preventDefault();
              setEditing(true);
            }
          }}
          ref={(el) => {
            previewRef.current = el;
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

const LiveInlineMath = InlineMath.extend({
  addNodeView() {
    return ReactNodeViewRenderer((props) => (
      <MathNodeView {...props} displayMode={false} />
    ));
  },
});

const LiveBlockMath = BlockMath.extend({
  addNodeView() {
    return ReactNodeViewRenderer((props) => (
      <MathNodeView {...props} displayMode />
    ));
  },
});

export function Editor({
  value,
  onChange,
  ariaLabel = "Markdown 编辑器",
  placeholder = "直接输入内容，支持 # 标题、**加粗**、- 列表、``` 代码块、$公式$…",
  autoFocus = false,
  disabled = false,
  showFollowupTools = false,
  onWholePaste,
  onPartialPaste,
  onSelectionRequired,
  onSaveShortcut,
  onEscapeKey,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  showFollowupTools?: boolean;
  onWholePaste?: (value: string) => void;
  onPartialPaste?: () => void;
  onSelectionRequired?: () => void;
  onSaveShortcut?: () => void;
  onEscapeKey?: () => void;
}) {
  const initialSplit = useRef(splitFrontmatter(value));
  const frontmatterRef = useRef(initialSplit.current.prefix);
  const emitted = useRef(value);
  const [isEmpty, setIsEmpty] = useState(!initialSplit.current.body.trim());
  const [, setSelectionTick] = useState(0);

  const editorInstanceRef = useRef<TiptapEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onWholePasteRef = useRef(onWholePaste);
  const onPartialPasteRef = useRef(onPartialPaste);
  const onSaveShortcutRef = useRef(onSaveShortcut);
  const onEscapeKeyRef = useRef(onEscapeKey);
  onChangeRef.current = onChange;
  onWholePasteRef.current = onWholePaste;
  onPartialPasteRef.current = onPartialPaste;
  onSaveShortcutRef.current = onSaveShortcut;
  onEscapeKeyRef.current = onEscapeKey;

  const editor = useEditor({
    extensions: [
      StarterKit,
      TableKit,
      LiveBlockMath,
      LiveInlineMath,
      Markdown,
    ],
    immediatelyRender: false,
    content: initialSplit.current.body,
    contentType: "markdown",
    editorProps: {
      handleKeyDown(_view, event) {
        if (event.isComposing) return false;
        if (
          (event.ctrlKey || event.metaKey) &&
          (event.key === "Enter" || event.key.toLowerCase() === "s")
        ) {
          event.preventDefault();
          onSaveShortcutRef.current?.();
          return true;
        }
        if (event.key === "Escape") {
          onEscapeKeyRef.current?.();
        }
        return false;
      },
      handlePaste(view, event) {
        const pasted = event.clipboardData?.getData("text/plain");
        if (!pasted) return false;
        const selection = view.state.selection;
        const whole =
          !view.state.doc.textContent.trim() ||
          (selection.from <= 1 &&
            selection.to >= view.state.doc.content.size - 1);
        if (onWholePasteRef.current && whole && /\n|\r/.test(pasted)) {
          event.preventDefault();
          onWholePasteRef.current(pasted);
          return true;
        }
        const insideCode = selection.$from.parent.type.spec.code;
        const hasHtml = Boolean(event.clipboardData?.getData("text/html"));
        if (!insideCode && !hasHtml && MARKDOWN_PASTE_RE.test(pasted)) {
          event.preventDefault();
          if (/\n|\r/.test(pasted)) onPartialPasteRef.current?.();
          editorInstanceRef.current
            ?.chain()
            .focus()
            .insertContent(pasted, { contentType: "markdown" })
            .run();
          return true;
        }
        if (/\n|\r/.test(pasted)) onPartialPasteRef.current?.();
        return false;
      },
      attributes: {
        class: "prose-content tiptap-content",
        "aria-label": ariaLabel,
        "data-placeholder": placeholder,
      },
    },
    onCreate: ({ editor: created }) => {
      editorInstanceRef.current = created;
      setIsEmpty(created.isEmpty);
      if (autoFocus) {
        requestAnimationFrame(() => created.commands.focus("end"));
      }
    },
    onSelectionUpdate: () => {
      setSelectionTick((n) => n + 1);
    },
    onUpdate: ({ editor: updated }) => {
      setIsEmpty(updated.isEmpty);
      const next = joinFrontmatter(
        frontmatterRef.current,
        updated.getMarkdown(),
      );
      if (next !== emitted.current) {
        emitted.current = next;
        onChangeRef.current(next);
      }
    },
  });

  useEffect(() => {
    editorInstanceRef.current = editor;
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    if (editor && value !== emitted.current) {
      const nextSplit = splitFrontmatter(value);
      frontmatterRef.current = nextSplit.prefix;
      editor.commands.setContent(nextSplit.body, {
        contentType: "markdown",
        emitUpdate: false,
      });
      emitted.current = value;
      setIsEmpty(editor.isEmpty);
    }
  }, [editor, value]);

  if (!editor) return <div className="editor-loading">编辑器加载中…</div>;

  type ToolItem =
    | { type: "sep" }
    | {
        type: "btn";
        icon: typeof Bold;
        label: string;
        active: boolean;
        canRun?: boolean;
        run: () => void;
      };

  const groups: ToolItem[] = [
    {
      type: "btn",
      icon: Heading2,
      label: "二级标题",
      active: editor.isActive("heading", { level: 2 }),
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      type: "btn",
      icon: Heading3,
      label: "三级标题",
      active: editor.isActive("heading", { level: 3 }),
      run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    { type: "sep" },
    {
      type: "btn",
      icon: Bold,
      label: "加粗",
      active: editor.isActive("bold"),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      type: "btn",
      icon: Italic,
      label: "斜体",
      active: editor.isActive("italic"),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      type: "btn",
      icon: Code,
      label: "行内代码",
      active: editor.isActive("code"),
      run: () => editor.chain().focus().toggleCode().run(),
    },
    { type: "sep" },
    {
      type: "btn",
      icon: List,
      label: "无序列表",
      active: editor.isActive("bulletList"),
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      type: "btn",
      icon: ListOrdered,
      label: "有序列表",
      active: editor.isActive("orderedList"),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      type: "btn",
      icon: Quote,
      label: "引用",
      active: editor.isActive("blockquote"),
      run: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      type: "btn",
      icon: Code2,
      label: "代码块",
      active: editor.isActive("codeBlock"),
      run: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      type: "btn",
      icon: Table2,
      label: "插入表格",
      active: editor.isActive("table"),
      run: () =>
        editor
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      type: "btn",
      icon: Sigma,
      label: "插入公式",
      active: editor.isActive("inlineMath") || editor.isActive("blockMath"),
      run: () =>
        editor
          .chain()
          .focus()
          .insertContent({ type: "inlineMath", attrs: { latex: "" } })
          .run(),
    },
    ...(showFollowupTools
      ? ([
          { type: "sep" },
          {
            type: "btn",
            icon: MessageSquarePlus,
            label: "指定选中为追问",
            active: false,
            run: () => {
              const { from, to, empty } = editor.state.selection;
              if (empty) {
                onSelectionRequired?.();
                return;
              }
              const content = editor.markdown?.serialize({
                type: "doc",
                content:
                  editor.state.doc.slice(from, to).content.toJSON() ?? [],
              });
              if (content) {
                editor
                  .chain()
                  .focus()
                  .insertContent(markAsFollowup(content), {
                    contentType: "markdown",
                  })
                  .run();
              }
            },
          },
          {
            type: "btn",
            icon: ListPlus,
            label: "插入追问模板",
            active: false,
            run: () =>
              editor
                .chain()
                .focus()
                .insertContent("> [!question] 面试追问\n> Q：\n> A：", {
                  contentType: "markdown",
                })
                .run(),
          },
        ] satisfies ToolItem[])
      : []),
  ];

  return (
    <div className={`editor ${isEmpty ? "is-empty" : ""}`}>
      <div className="editor-toolbar" role="toolbar" aria-label="格式工具栏">
        {groups.map((item, idx) =>
          item.type === "sep" ? (
            <span
              key={`sep-${idx}`}
              className="editor-toolbar-sep"
              aria-hidden="true"
            />
          ) : (
            <Button
              type="button"
              key={item.label}
              variant="ghost"
              size="icon"
              title={item.label}
              aria-label={item.label}
              aria-pressed={item.active}
              className={item.active ? "active" : ""}
              onClick={item.run}
              disabled={disabled || item.canRun === false}
            >
              <item.icon size={15} />
            </Button>
          ),
        )}
        <div className="editor-toolbar-history">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="撤销"
            aria-label="撤销"
            disabled={disabled || !editor.can().undo()}
            onClick={() => editor.chain().focus().undo().run()}
          >
            <Undo2 size={15} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="重做"
            aria-label="重做"
            disabled={disabled || !editor.can().redo()}
            onClick={() => editor.chain().focus().redo().run()}
          >
            <Redo2 size={15} />
          </Button>
        </div>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
