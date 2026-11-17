"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import { useEffect, useRef } from "react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Code2,
  Heading2,
  Quote,
  Undo2,
  MessageSquarePlus,
} from "lucide-react";
import { Button } from "./ui/button";
import { markAsFollowup } from "@/lib/editor-document";
export function Editor({
  value,
  onChange,
  onWholePaste,
  onPartialPaste,
  disabled = false,
  onSelectionRequired,
}: {
  value: string;
  onChange: (value: string) => void;
  onWholePaste?: (value: string) => void;
  onPartialPaste?: () => void;
  disabled?: boolean;
  onSelectionRequired?: () => void;
}) {
  const emitted = useRef(value);
  const editor = useEditor({
    extensions: [StarterKit, TableKit, Markdown],
    immediatelyRender: false,
    content: value,
    contentType: "markdown",
    editorProps: {
      handlePaste(view, event) {
        const value = event.clipboardData?.getData("text/plain");
        const selection = view.state.selection;
        const whole =
          !view.state.doc.textContent.trim() ||
          (selection.from <= 1 &&
            selection.to >= view.state.doc.content.size - 1);
        if (onWholePaste && whole && value && /\n|\r/.test(value)) {
          event.preventDefault();
          onWholePaste(value);
          return true;
        }
        if (value && /\n|\r/.test(value)) onPartialPaste?.();
        return false;
      },
      attributes: {
        class: "prose-content tiptap-content",
        "aria-label": "答案编辑器",
      },
    },
    onUpdate: ({ editor }) => {
      emitted.current = editor.getMarkdown();
      onChange(emitted.current);
    },
  });
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  useEffect(() => {
    if (editor && value !== emitted.current) {
      editor.commands.setContent(value, {
        contentType: "markdown",
        emitUpdate: false,
      });
      emitted.current = value;
    }
  }, [editor, value]);
  if (!editor) return <div className="editor-loading">编辑器加载中…</div>;
  const tools = [
    {
      icon: MessageSquarePlus,
      label: "指定追问",
      active: false,
      run: () => {
        const { from, to, empty } = editor.state.selection;
        if (empty) {
          onSelectionRequired?.();
          return;
        }
        const content = editor.markdown?.serialize({
          type: "doc",
          content: editor.state.doc.slice(from, to).content.toJSON() ?? [],
        });
        if (content)
          editor
            .chain()
            .focus()
            .insertContent(markAsFollowup(content), { contentType: "markdown" })
            .run();
      },
    },
    {
      icon: Bold,
      label: "加粗",
      run: () => editor.chain().focus().toggleBold().run(),
      active: editor.isActive("bold"),
    },
    {
      icon: Italic,
      label: "斜体",
      run: () => editor.chain().focus().toggleItalic().run(),
      active: editor.isActive("italic"),
    },
    {
      icon: Heading2,
      label: "小标题",
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      active: editor.isActive("heading", { level: 2 }),
    },
    {
      icon: List,
      label: "无序列表",
      run: () => editor.chain().focus().toggleBulletList().run(),
      active: editor.isActive("bulletList"),
    },
    {
      icon: ListOrdered,
      label: "有序列表",
      run: () => editor.chain().focus().toggleOrderedList().run(),
      active: editor.isActive("orderedList"),
    },
    {
      icon: Code2,
      label: "代码块",
      run: () => editor.chain().focus().toggleCodeBlock().run(),
      active: editor.isActive("codeBlock"),
    },
    {
      icon: Quote,
      label: "引用",
      run: () => editor.chain().focus().toggleBlockquote().run(),
      active: editor.isActive("blockquote"),
    },
    {
      icon: Undo2,
      label: "撤销",
      run: () => editor.chain().focus().undo().run(),
      active: false,
    },
  ];
  return (
    <div className="editor">
      <div className="editor-toolbar">
        {tools.map(({ icon: Icon, label, run, active }) => (
          <Button
            type="button"
            key={label}
            variant="ghost"
            size="icon"
            title={label}
            aria-label={label}
            className={active ? "active" : ""}
            onClick={run}
            disabled={disabled}
          >
            <Icon size={16} />
          </Button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
