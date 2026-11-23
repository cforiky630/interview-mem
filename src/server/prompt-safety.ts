const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SPOOFED_EDIT_TAG_RE = /<(\s*\/?\s*shiyi-edits?)(?=[\s>/]|$)/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip disallowed control characters (preserving tabs/newlines) and optionally cap length.
 */
export function sanitizeUntrustedText(text: string, maxChars?: number): string {
  const cleaned = text.replace(CONTROL_CHARS_RE, "");
  return maxChars !== undefined ? cleaned.slice(0, maxChars) : cleaned;
}

/**
 * Wrap untrusted user or database content inside XML delimiters while neutralizing
 * closing/opening delimiter breakouts and spoofed `<shiyi-edit*>` blocks.
 */
export function wrapUntrustedTag(
  tag: string,
  rawContent: string,
  maxChars?: number,
): string {
  const cleaned = sanitizeUntrustedText(rawContent, maxChars);
  const tagPattern = new RegExp(
    `<(\\s*/?\\s*${escapeRegExp(tag)})(?=[\\s>/]|$)`,
    "gi",
  );
  const safe = cleaned
    .replace(tagPattern, "&lt;$1")
    .replace(SPOOFED_EDIT_TAG_RE, "&lt;$1");
  return `<${tag}>${safe}</${tag}>`;
}
