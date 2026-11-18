"use client";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  Clipboard,
  FileText,
  FolderOpen,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  droppedFiles,
  pickedFiles,
  readImportFiles,
  type ImportFile,
} from "@/lib/import-files";
import { IMPORT_LIMITS } from "@/lib/import-material";

export function ImportSourceInput({
  raw,
  onRawChange,
  files,
  onFilesChange,
  fileMode,
  onModeChange,
  onReadingChange,
  questionsOnly,
  disabled,
}: {
  raw: string;
  onRawChange: (raw: string) => void;
  files: ImportFile[];
  onFilesChange: (files: ImportFile[]) => void;
  fileMode: boolean;
  onModeChange: (fileMode: boolean) => void;
  onReadingChange: (reading: boolean) => void;
  questionsOnly: boolean;
  disabled: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const reader = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  const [failures, setFailures] = useState<{ name: string; reason: string }[]>(
    [],
  );
  const locked = disabled || reading;

  useEffect(() => () => reader.current?.abort(), []);

  async function addFiles(
    load: (signal: AbortSignal) => Promise<{
      files: ReturnType<typeof pickedFiles>;
      ignored: number;
    }>,
  ) {
    if (disabled || reader.current) return;
    const controller = new AbortController();
    reader.current = controller;
    setReading(true);
    onReadingChange(true);
    setNotice("");
    setFailures([]);
    try {
      const picked = await load(controller.signal);
      const next = await readImportFiles(
        picked.files,
        files,
        controller.signal,
        picked.ignored,
      );
      controller.signal.throwIfAborted();
      const added = next.files.length - files.length;
      if (added) onFilesChange(next.files);
      if (added || next.duplicates) onModeChange(true);
      setFailures(next.failures);
      setNotice(
        [
          next.ignored ? `跳过 ${next.ignored} 个非 .md 或 .txt 文件` : "",
          next.duplicates ? `${next.duplicates} 个文件已在列表中` : "",
          !added && !next.ignored && !next.duplicates && !next.failures.length
            ? "没有找到可导入的文件"
            : "",
        ]
          .filter(Boolean)
          .join("，"),
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice(
          error instanceof Error ? error.message : "无法读取文件，请重试。",
        );
    } finally {
      reader.current = null;
      if (!controller.signal.aborted) {
        setReading(false);
        onReadingChange(false);
      }
    }
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const entries = event.currentTarget.files;
    if (entries?.length) {
      const files = pickedFiles(entries);
      void addFiles(async () => ({ files, ignored: 0 }));
    }
    event.currentTarget.value = "";
  }

  function drop(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void addFiles((signal) => droppedFiles(event.dataTransfer, signal));
  }

  return (
    <div className="import-material" data-file-mode={fileMode}>
      <input
        ref={picker}
        type="file"
        accept=".md,.txt"
        multiple
        hidden
        disabled={locked}
        aria-label="读取 Markdown 或文本文件"
        onChange={choose}
      />
      <input
        ref={(node) => {
          folderPicker.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        hidden
        disabled={locked}
        aria-label="读取文件夹"
        onChange={choose}
      />
      <div className="import-file-panel">
        {fileMode && (
          <div className="import-source-heading">
            <h2>{files.length} 个待解析文件</h2>
            <div className="import-source-actions">
              <button
                type="button"
                className="import-material-link danger-text"
                disabled={locked}
                onClick={() => {
                  setNotice("");
                  setFailures([]);
                  onFilesChange([]);
                  onModeChange(false);
                }}
              >
                <Trash2 size={14} /> 清空文件
              </button>
              <button
                type="button"
                className="import-material-link"
                disabled={locked}
                onClick={() => onModeChange(false)}
              >
                <Clipboard size={15} /> 粘贴文本
              </button>
            </div>
          </div>
        )}
        <div
          className="import-drop"
          data-dragging={dragging && !locked}
          aria-busy={reading}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = locked ? "none" : "copy";
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (!dragDepth.current) setDragging(false);
          }}
          onDrop={drop}
        >
          <button
            type="button"
            className="import-drop-picker"
            disabled={locked}
            onClick={() => picker.current?.click()}
          >
            <span className="import-drop-icon" aria-hidden="true">
              {reading ? (
                <Loader2 size={20} className="spin" />
              ) : (
                <Upload size={20} />
              )}
            </span>
            <span>
              <strong>
                {reading
                  ? "正在读取文件"
                  : fileMode
                    ? "添加更多文件"
                    : "选择文件"}
              </strong>
              <span className="import-drop-formats">
                支持 .md / .txt · 可批量多选
                <span className="import-drop-drag">或拖入此框</span>
              </span>
            </span>
          </button>
          <button
            type="button"
            className="import-folder-picker"
            disabled={locked}
            onClick={() => {
              const input = folderPicker.current;
              if (input && "webkitdirectory" in input) input.click();
              else
                setNotice("当前浏览器不支持选择文件夹，可以一次选择多个文件。");
            }}
          >
            <FolderOpen size={16} /> 选择文件夹
          </button>
        </div>
        {!fileMode && files.length > 0 && (
          <div className="import-saved-files">
            <button
              type="button"
              className="import-material-link"
              disabled={locked}
              onClick={() => onModeChange(true)}
            >
              <FileText size={15} /> 查看已选文件（{files.length}）
            </button>
            <button
              type="button"
              className="import-material-link danger-text"
              disabled={locked}
              aria-label="清空已选文件"
              onClick={() => {
                setNotice("");
                setFailures([]);
                onFilesChange([]);
              }}
            >
              <Trash2 size={14} /> 清空文件
            </button>
          </div>
        )}
        {fileMode && (
          <ul className="import-file-list">
            {files.map(({ id, name, raw }) => (
              <li key={id}>
                <FileText size={16} aria-hidden="true" />
                <span>{name}</span>
                <small className="import-file-meta">
                  {raw.length.toLocaleString()} 字
                </small>
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`移除文件 ${name}`}
                  onClick={() => {
                    const remaining = files.filter((file) => file.id !== id);
                    setNotice("");
                    setFailures([]);
                    onFilesChange(remaining);
                    if (!remaining.length) onModeChange(false);
                  }}
                >
                  <X size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {notice && (
          <p role="status" className="import-file-notice">
            {notice}
          </p>
        )}
        {failures.length > 0 && (
          <details className="import-file-notice">
            <summary>{failures.length} 个文件未能读取</summary>
            <ul>
              {failures.map(({ name, reason }, index) => (
                <li key={index}>
                  {name}（{reason}）
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {!fileMode && (
        <div className="import-paste-panel">
          <div className="import-source-heading">
            <label htmlFor="import-material">
              {questionsOnly ? "粘贴题目" : "粘贴题目与答案"}
            </label>
            {raw.length > 0 && (
              <div className="import-source-actions">
                <span>
                  {raw.length.toLocaleString()} /{" "}
                  {IMPORT_LIMITS.sourceChars.toLocaleString()}
                </span>
                <button
                  type="button"
                  className="import-clear-text"
                  disabled={locked}
                  onClick={() => onRawChange("")}
                >
                  清空
                </button>
              </div>
            )}
          </div>
          <textarea
            id="import-material"
            aria-label="面试资料"
            value={raw}
            maxLength={IMPORT_LIMITS.sourceChars}
            disabled={locked}
            placeholder={
              questionsOnly
                ? "每行一题，支持直接粘贴面经清单、无序列表或编号：\n1. JavaScript 事件循环是如何调度的？\n2. 为什么 React 渲染列表需要稳定的 key？"
                : "## 主问题标题\n写出核心结论、关键机制或代码示例。\n\n### 面试追问\nQ：常见深挖追问？\nA：补充对应的参考要点。"
            }
            onChange={(event) => onRawChange(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
