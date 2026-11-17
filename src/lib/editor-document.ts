import { isFollowupSection } from "./followups";

/** Textareas normalize CRLF; translate their selection offsets before changing source. */
export function sourceSelection(source: string, from: number, to: number) {
  const offset = (target: number) => {
    let normalized = 0,
      index = 0;
    while (index < source.length && normalized < target) {
      if (source[index] === "\r" && source[index + 1] === "\n") index++;
      index++;
      normalized++;
    }
    return index;
  };
  return { from: offset(from), to: offset(to) };
}

export function replaceWithBlock(
  source: string,
  from: number,
  to: number,
  block: string,
) {
  const before = source.slice(0, from),
    after = source.slice(to),
    newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailing = before.replace(/\r\n?/g, "\n").match(/\n*$/)![0].length;
  const leading = after.replace(/\r\n?/g, "\n").match(/^\n*/)![0].length;
  return (
    before +
    (before ? newline.repeat(Math.max(0, 2 - trailing)) : "") +
    block +
    (after ? newline.repeat(Math.max(0, 2 - leading)) : "") +
    after
  );
}

export function markAsFollowup(selection: string) {
  const newline = selection.includes("\r\n") ? "\r\n" : "\n";
  const lines = selection.trim().split(/\r\n?|\n/);
  const section = lines[0]?.replace(/^#{1,6}\s+/, "");
  if (section && isFollowupSection(section)) lines.shift();
  if (/^>\s*\\?\[!question\\?\]/i.test(lines[0] ?? "")) return selection.trim();
  const hasQuestion =
    /^(?:\s*(?:[-*+]\s+|\d+[.)、]\s+)?)?(?:\*\*|__)?(?:Q(?:uestion)?|问(?:题)?|追问)\s*\d*(?:\*\*|__)?\s*[：:]/im.test(
      selection,
    );
  const explicit =
    /^(?:\s*(?:[-*+]\s+|\d+[.)、]\s+)?)?(?:\*\*|__)?(?:A(?:nswer)?|答(?:案)?|回答|解答)(?:\*\*|__)?\s*[：:]/im.test(
      selection,
    );
  const heading = /^#{1,6}\s+.+[?？]\s*$/.test(lines[0] ?? "");
  const content =
    (explicit && hasQuestion) || heading
      ? lines
      : explicit
        ? [
            `Q：${(lines[0] ?? "").replace(/^#{1,6}\s+/, "")}`,
            ...lines.slice(1),
          ]
        : [
            `Q：${(lines[0] ?? "").replace(/^#{1,6}\s+/, "").replace(/^(?:Q|问(?:题)?|追问)\s*\d*\s*[：:]\s*/i, "")}`,
            `A：${lines.slice(1).join(newline).trimStart()}`,
          ];
  return `> [!question] 面试追问${newline}${content.map((line) => `> ${line}`).join(newline)}`;
}
