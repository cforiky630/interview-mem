import { z } from "zod";

// Deck IDs are opaque text keys. Older or imported decks keep their IDs in
// release snapshots and share links, so validate the input without rewriting it.
export const deckIdSchema = z
  .string("题库标识无效。")
  .refine(
    (id) =>
      id.length <= 128 &&
      id.trim().length > 0 &&
      !id.includes("\0") &&
      id.isWellFormed(),
    "题库标识无效。",
  );
