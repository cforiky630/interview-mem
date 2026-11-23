/** Derive a compact 1-2 character avatar label from a user's display name. */
export function userInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "U";
  if (/^[\u4e00-\u9fff]/.test(trimmed)) {
    return trimmed.slice(0, 1);
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}
