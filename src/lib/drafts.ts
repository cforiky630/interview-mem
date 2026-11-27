import { createUuid } from "./utils";

export function practiceDraftKey(
  userId: string,
  questionId: string,
  revision: number,
  part = "answer",
) {
  return `shiyi:practice:${userId}:${questionId}:v${revision}:${part}`;
}
export function readPracticeDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
export function savePracticeDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function noteDraftKey(userId: string, questionId: string) {
  return `shiyi:note:${userId}:${questionId}`;
}

export type NoteDraft = {
  key: string;
  stored: string;
  content: string;
  version: number;
  savedAt: number;
  stamp: string;
  previous?: { key: string; stamp: string };
};

export const NOTE_DRAFT_CHANGE_EVENT = "shiyi:note-draft-change";

export function isNoteDraftKey(base: string, key: string) {
  return key === base || key.startsWith(`${base}:draft:`);
}

export function readNoteDraft(key: string): NoteDraft | null {
  const stored = readPracticeDraft(key);
  if (!stored) return null;
  try {
    const draft = JSON.parse(stored) as {
      content?: unknown;
      version?: unknown;
      savedAt?: unknown;
      stamp?: unknown;
      previous?: { key?: unknown; stamp?: unknown } | null;
    } | null;
    if (
      typeof draft?.content === "string" &&
      typeof draft.version === "number" &&
      Number.isInteger(draft.version)
    ) {
      return {
        key,
        stored,
        content: draft.content,
        version: draft.version,
        savedAt: typeof draft.savedAt === "number" ? draft.savedAt : 0,
        stamp: typeof draft.stamp === "string" ? draft.stamp : stored,
        ...(typeof draft.previous?.key === "string" &&
        typeof draft.previous.stamp === "string"
          ? {
              previous: {
                key: draft.previous.key,
                stamp: draft.previous.stamp,
              },
            }
          : {}),
      };
    }
  } catch {
    // Older drafts were saved as plain text.
  }
  return {
    key,
    stored,
    content: stored,
    version: 0,
    savedAt: 0,
    stamp: stored,
  };
}

export function readNoteDrafts(base: string): NoteDraft[] {
  const drafts: NoteDraft[] = [];
  const legacy = readNoteDraft(base);
  if (legacy) drafts.push(legacy);
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || key === base || !isNoteDraftKey(base, key)) continue;
      const draft = readNoteDraft(key);
      if (draft) drafts.push(draft);
    }
  } catch {
    // Storage may be disabled.
  }
  return drafts.sort((a, b) => b.savedAt - a.savedAt);
}

export function selectedNoteDraft(base: string, drafts: readonly NoteDraft[]) {
  try {
    const key = sessionStorage.getItem(base);
    // A cleared selection still belongs to this tab; leave other drafts available to open.
    if (key) return drafts.find((draft) => draft.key === key) ?? null;
  } catch {
    // A single draft can still be opened without session storage.
  }
  const pending = pendingNoteDrafts(drafts);
  return pending.length === 1 ? pending[0] : undefined;
}

export function pendingNoteDrafts(drafts: readonly NoteDraft[]) {
  const prior = new Set(
    drafts.flatMap((draft) =>
      draft.previous ? [`${draft.previous.key}\0${draft.previous.stamp}`] : [],
    ),
  );
  return drafts.filter((draft) => !prior.has(`${draft.key}\0${draft.stamp}`));
}

export function selectNoteDraft(base: string, key: string) {
  try {
    sessionStorage.setItem(base, key);
  } catch {
    // The draft itself is saved independently.
  }
}

export function saveNoteDraft(
  base: string,
  key: string,
  content: string,
  version: number,
  active?: NoteDraft | null,
): NoteDraft | null {
  const savedAt = Date.now();
  const stamp = createUuid();
  let previous = active?.key === key ? active.previous : undefined;
  if (active && active.key !== key) {
    try {
      if (
        active.key === base ||
        sessionStorage.getItem(`${base}:last-edited`) === active.key
      ) {
        previous = { key: active.key, stamp: active.stamp };
      }
    } catch {
      // Keep the previous draft if its editor can't be determined.
    }
  }
  const stored = JSON.stringify({ content, version, savedAt, stamp, previous });
  if (!savePracticeDraft(key, stored)) return null;
  selectNoteDraft(base, key);
  try {
    sessionStorage.setItem(`${base}:last-edited`, key);
  } catch {
    // The durable draft was already written.
  }
  noteDraftChanged(key);
  return { key, stored, content, version, savedAt, stamp, previous };
}

function noteDraftChanged(key: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(NOTE_DRAFT_CHANGE_EVENT, { detail: key }),
    );
  }
}

export function clearMatchingNoteDraft(
  key: string,
  stored: string | undefined,
) {
  if (
    stored !== undefined &&
    readPracticeDraft(key) === stored &&
    savePracticeDraft(key, "")
  ) {
    noteDraftChanged(key);
    return true;
  }
  return false;
}

export function clearNoteDraft(
  base: string,
  draft: NoteDraft | null | undefined,
) {
  while (
    draft &&
    isNoteDraftKey(base, draft.key) &&
    clearMatchingNoteDraft(draft.key, draft.stored)
  ) {
    const prior = draft.previous;
    const parent =
      prior && isNoteDraftKey(base, prior.key)
        ? readNoteDraft(prior.key)
        : null;
    draft = parent && parent.stamp === prior?.stamp ? parent : null;
  }
}

export type NoteUpdated = {
  questionId: string;
  note: string;
  version: number;
  consumedDraft?: NoteDraft;
  switchToNotes?: boolean;
};
