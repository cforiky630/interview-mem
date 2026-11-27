import { z } from "zod";

export const authorIdSchema = z
  .string()
  .trim()
  .min(1, "缺少创作者标识。")
  .max(128)
  .refine((id) => !id.includes("\0") && id.isWellFormed(), "创作者标识无效。");

// Deck IDs are opaque text keys. Older or imported decks keep their IDs in
// release snapshots and share links, so validate the input without rewriting it.
export const deckIdSchema = z
  .string("文件夹标识无效。")
  .refine(
    (id) =>
      id.length <= 128 &&
      id.trim().length > 0 &&
      !id.includes("\0") &&
      id.isWellFormed(),
    "文件夹标识无效。",
  );
