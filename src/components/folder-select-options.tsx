"use client";

import { useMemo } from "react";
import type { DeckView } from "@/lib/types";
import { buildFolderIndex, ROOT_FOLDER_LABEL } from "@/lib/folders";

/**
 * Renders owned folders as flat indented <option> entries with full path
 * disambiguation whenever two folders share the same title.
 */
export function FolderSelectOptions({
  decks,
  includeRoot = false,
  rootLabel = ROOT_FOLDER_LABEL,
  excludeIds,
}: {
  decks: readonly DeckView[];
  includeRoot?: boolean;
  rootLabel?: string;
  excludeIds?: ReadonlySet<string>;
}) {
  const options = useMemo(() => {
    const index = buildFolderIndex(decks);
    const titleCounts = new Map<string, number>();
    for (const item of index.flatOwned) {
      const key = item.folder.title.trim().toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    return index.flatOwned
      .filter((item) => !excludeIds?.has(item.folder.id))
      .map((item) => {
        const prefix = item.depth > 1 ? `${"　".repeat(item.depth - 1)}└ ` : "";
        const duplicateTitle =
          (titleCounts.get(item.folder.title.trim().toLowerCase()) ?? 0) > 1;
        const label = duplicateTitle
          ? `${prefix}${item.folder.title}（${item.path}）`
          : `${prefix}${item.folder.title}`;
        return { id: item.folder.id, label };
      });
  }, [decks, excludeIds]);

  return (
    <>
      {includeRoot && <option value="">{rootLabel}</option>}
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.label}
        </option>
      ))}
    </>
  );
}
