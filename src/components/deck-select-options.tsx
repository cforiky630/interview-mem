"use client";
import type { DeckGroupView, DeckView } from "@/lib/types";
import {
  OTHER_DECKS_LABEL,
  UNGROUPED_LABEL,
  clusterDeckGroupsByCategory,
  groupDecksByName,
} from "@/lib/grouping";

/**
 * Render `<option>` elements for a deck `<select>`, automatically grouping into
 * `<optgroup>` buckets when at least one deck has a `groupName`.
 */
export function DeckSelectOptions({
  decks,
}: {
  decks: readonly Pick<DeckView, "id" | "title" | "groupName">[];
}) {
  const { hasGroups, buckets } = groupDecksByName(decks);
  if (!hasGroups) {
    return (
      <>
        {decks.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      {buckets.map((bucket) => (
        <optgroup
          key={bucket.groupName || "__ungrouped__"}
          label={bucket.groupName || OTHER_DECKS_LABEL}
        >
          {bucket.decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/**
 * Render `<option>` elements for an intra-deck group `<select>`, clustering by
 * optional `category` (e.g. company name) when categories are present.
 */
export function GroupSelectOptions({
  groups,
  ungroupedLabel = "不分组",
  includeUngrouped = true,
}: {
  groups: readonly DeckGroupView[];
  ungroupedLabel?: string;
  includeUngrouped?: boolean;
}) {
  const { hasCategories, categories } = clusterDeckGroupsByCategory(groups);
  return (
    <>
      {includeUngrouped && <option value="">{ungroupedLabel}</option>}
      {!hasCategories
        ? (categories[0]?.groups ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))
        : categories.map((cluster) => (
            <optgroup
              key={cluster.category || "__uncategorized__"}
              label={cluster.category || UNGROUPED_LABEL}
            >
              {cluster.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </optgroup>
          ))}
    </>
  );
}
