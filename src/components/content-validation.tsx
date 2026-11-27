import { BadgeCheck, Info } from "lucide-react";
import type { ContentValidationView } from "@/lib/content-validation";

function safeHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function ContentValidationPanel({
  review,
  expanded = false,
}: {
  review?: ContentValidationView | null;
  expanded?: boolean;
}) {
  if (!review) return null;
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const labels = {
    error: "概念问题",
    qualification: "适用条件",
    terminology: "术语笔误",
  };
  return (
    <details
      open={expanded || undefined}
      className={`content-validation ${findings.length ? "has-findings" : "checked"}`}
    >
      <summary>
        {findings.length || !review.current ? (
          <Info size={15} />
        ) : (
          <BadgeCheck size={15} />
        )}
        <strong>内容校验</strong>
        <span>
          {!review.current
            ? "原文已有编辑，校验针对导入版本"
            : findings.length
              ? `${findings.length} 条记录`
              : "未发现明确内容错误"}
        </span>
      </summary>
      <div className="validation-body">
        <p>{review.summary}</p>
        <small>
          {review.checkedAt} · {review.sourcePath}
        </small>
        {!review.current && (
          <p className="validation-stale">
            以下结论针对导入时的原文；后续编辑尚未重新核验。
          </p>
        )}
        {findings.map((finding) => (
          <section key={finding.id}>
            <div>
              <span
                className={`validation-severity severity-${finding.severity}`}
              >
                {labels[finding.severity] ?? "内容提示"}
              </span>
              <span>原文第 {finding.line} 行</span>
            </div>
            <h3>{finding.title}</h3>
            <p>{finding.explanation}</p>
            <p className="validation-suggestion">
              建议理解：{finding.suggestion}
            </p>
            <div className="validation-sources">
              {(Array.isArray(finding.sources) ? finding.sources : []).map(
                (source) => {
                  const href = safeHttpUrl(source.url);
                  return href ? (
                    <a
                      key={source.url}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.title} ↗
                    </a>
                  ) : (
                    <span key={`${source.title}-${source.url}`}>
                      {source.title}
                    </span>
                  );
                },
              )}
            </div>
          </section>
        ))}
      </div>
    </details>
  );
}
