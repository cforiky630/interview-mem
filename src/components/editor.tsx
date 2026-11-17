"use client";
import { useEditor, EditorContent } from "@tiptap/react";
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
} from "lucide-react";
import { Button } from "./ui/button";
export function Editor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit, TableKit, Markdown],
    immediatelyRender: false,
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "prose-content tiptap-content",
        "aria-label": "答案编辑器",
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
  });
  if (!editor) return <div className="editor-loading">编辑器加载中…</div>;
  const tools = [
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
          >
            <Icon size={16} />
          </Button>
        ))}
        <span>支持 Markdown 粘贴</span>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
