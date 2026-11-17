import { BadgeCheck, Info } from "lucide-react";
import type { ContentValidationView } from "@/lib/content-validation";

export function ContentValidationPanel({
  review,
  expanded = false,
}: {
  review?: ContentValidationView | null;
  expanded?: boolean;
}) {
  if (!review) return null;
  const labels = {
    error: "概念问题",
    qualification: "适用条件",
    terminology: "术语笔误",
  };
  return (
    <details
      open={expanded || undefined}
      className={`content-validation ${review.findings.length ? "has-findings" : "checked"}`}
    >
      <summary>
        {review.findings.length || !review.current ? (
          <Info size={15} />
        ) : (
          <BadgeCheck size={15} />
        )}
        <strong>内容校验</strong>
        <span>
          {!review.current
            ? "原文已有编辑，校验针对导入版本"
            : review.findings.length
              ? `${review.findings.length} 条记录`
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
        {review.findings.map((finding) => (
          <section key={finding.id}>
            <div>
              <span
                className={`validation-severity severity-${finding.severity}`}
              >
                {labels[finding.severity]}
              </span>
              <span>原文第 {finding.line} 行</span>
            </div>
            <h3>{finding.title}</h3>
            <p>{finding.explanation}</p>
            <p className="validation-suggestion">
              建议理解：{finding.suggestion}
            </p>
            <div className="validation-sources">
              {finding.sources.map((source) => (
                <a
                  key={source.url}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {source.title} ↗
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>
    </details>
  );
}
