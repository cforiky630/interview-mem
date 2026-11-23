export type DiffLine = {
  type: "equal" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type LineDiffResult = {
  lines: DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
};

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Compute a line-oriented unified diff with 1-based line numbers.
 */
export function computeLineDiff(before: string, after: string): LineDiffResult {
  const a = splitLines(before);
  const b = splitLines(after);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (let i = 0; i < prefix; i++) {
    lines.push({
      type: "equal",
      text: a[i],
      oldLine: i + 1,
      newLine: i + 1,
    });
    unchanged++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const m = midA.length;
  const n = midB.length;

  let oldCursor = prefix + 1;
  let newCursor = prefix + 1;

  if (m === 0 && n > 0) {
    for (const line of midB) {
      lines.push({ type: "add", text: line, newLine: newCursor++ });
      added++;
    }
  } else if (n === 0 && m > 0) {
    for (const line of midA) {
      lines.push({ type: "remove", text: line, oldLine: oldCursor++ });
      removed++;
    }
  } else if (m * n > 40_000) {
    for (const line of midA) {
      lines.push({ type: "remove", text: line, oldLine: oldCursor++ });
      removed++;
    }
    for (const line of midB) {
      lines.push({ type: "add", text: line, newLine: newCursor++ });
      added++;
    }
  } else if (m > 0 && n > 0) {
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array<number>(n + 1).fill(0),
    );
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] =
          midA[i] === midB[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        lines.push({
          type: "equal",
          text: midA[i],
          oldLine: oldCursor++,
          newLine: newCursor++,
        });
        unchanged++;
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({ type: "remove", text: midA[i], oldLine: oldCursor++ });
        removed++;
        i++;
      } else {
        lines.push({ type: "add", text: midB[j], newLine: newCursor++ });
        added++;
        j++;
      }
    }
    while (i < m) {
      lines.push({ type: "remove", text: midA[i++], oldLine: oldCursor++ });
      removed++;
    }
    while (j < n) {
      lines.push({ type: "add", text: midB[j++], newLine: newCursor++ });
      added++;
    }
  }

  const tailStartA = a.length - suffix;
  const tailStartB = b.length - suffix;
  for (let k = 0; k < suffix; k++) {
    lines.push({
      type: "equal",
      text: a[tailStartA + k],
      oldLine: tailStartA + k + 1,
      newLine: tailStartB + k + 1,
    });
    unchanged++;
  }

  return { lines, added, removed, unchanged };
}
