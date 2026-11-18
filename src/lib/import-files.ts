import { IMPORT_LIMITS, validImportPath } from "./import-material";

export type ImportFile = { id: string; name: string; raw: string };
type FileEntry = { name: string; file: File };
const isTextFile = (name: string) => /\.(md|txt)$/i.test(name);
const tooManyFiles = "每批最多导入 50 个 .md 或 .txt 文件，请分批添加。";

export function pickedFiles(files: FileList): FileEntry[] {
  return Array.from(files, (file) => ({
    file,
    name: file.webkitRelativePath || file.name,
  }));
}

export async function droppedFiles(data: DataTransfer, signal: AbortSignal) {
  // 拖放事件结束后浏览器会收起访问权限，先同步取到文件和目录的句柄。
  const entries = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => ({
      entry: item.webkitGetAsEntry?.(),
      file: item.getAsFile(),
    }));
  if (!entries.some((item) => item.entry))
    return { files: pickedFiles(data.files), ignored: 0 };

  const files: FileEntry[] = [];
  let ignored = 0;
  let scanned = 0;
  async function visit(entry: FileSystemEntry) {
    signal.throwIfAborted();
    scanned++;
    if (scanned > 10_000)
      throw new Error("文件夹项目过多，请选择子文件夹或单独选择文件。");
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // 浏览器可能分批返回目录内容，直到返回空数组才遍历完毕。
      for (;;) {
        const children = await new Promise<FileSystemEntry[]>(
          (resolve, reject) => reader.readEntries(resolve, reject),
        );
        if (!children.length) break;
        for (const child of children) await visit(child);
      }
    } else if (entry.isFile) {
      if (!isTextFile(entry.name)) {
        ignored++;
        return;
      }
      if (files.length === IMPORT_LIMITS.files) throw new Error(tooManyFiles);
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push({ file, name: entry.fullPath.slice(1) });
    }
  }
  for (const { entry, file } of entries) {
    if (entry) await visit(entry);
    else if (file) files.push({ file, name: file.name });
  }
  return { files, ignored };
}

export async function readImportFiles(
  picked: FileEntry[],
  existing: ImportFile[],
  signal: AbortSignal,
  ignored = 0,
) {
  const textFiles = picked.filter(({ name }) => isTextFile(name));
  ignored += picked.length - textFiles.length;
  if (textFiles.length > IMPORT_LIMITS.files) throw new Error(tooManyFiles);
  const failures: { name: string; reason: string }[] = [];
  const files = [...existing];
  const seen = new Set(files.map(({ name, raw }) => `${name}\0${raw}`));
  let chars = files.reduce((total, entry) => total + entry.raw.length, 0);
  let duplicates = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const { name, file } of textFiles) {
    signal.throwIfAborted();
    let raw: string;
    try {
      if (!validImportPath(name)) throw new Error("文件名或相对路径无效");
      if (file.size > IMPORT_LIMITS.fileBytes) throw new Error("超过 400 KB");
      const bytes = await file.arrayBuffer();
      signal.throwIfAborted();
      raw = decoder.decode(bytes);
      if (!raw.trim() || raw.includes("\0")) throw new Error("没有有效文本");
      if (raw.length > IMPORT_LIMITS.sourceChars)
        throw new Error("超过 10 万字符");
    } catch (error) {
      signal.throwIfAborted();
      failures.push({
        name,
        reason:
          error instanceof TypeError
            ? "文件不是 UTF-8 文本"
            : error instanceof Error
              ? error.message
              : "无法读取",
      });
      continue;
    }
    const key = `${name}\0${raw}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    if (files.length >= IMPORT_LIMITS.files) throw new Error(tooManyFiles);
    chars += raw.length;
    if (chars > IMPORT_LIMITS.batchChars)
      throw new Error("本批原文超过 15 万字符，请分批添加。");
    seen.add(key);
    files.push({ id: crypto.randomUUID(), name, raw });
  }
  return { files, ignored, failures, duplicates };
}
