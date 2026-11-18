export const IMPORT_LIMITS = {
  files: 50,
  fileBytes: 400_000,
  sourceChars: 100_000,
  batchChars: 150_000,
  questions: 200,
  aiChars: 25_000,
  pathChars: 512,
} as const;

export function validImportPath(path: string) {
  // 仅作为资料来源展示。相对路径保留目录层级，不接受本机路径或跳转路径。
  return (
    path.length <= IMPORT_LIMITS.pathChars &&
    !/^[a-z]:|\\|\p{Cc}/iu.test(path) &&
    path
      .split("/")
      .every((part) => part.trim() && part !== "." && part !== "..")
  );
}
