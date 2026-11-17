import { History, ArrowUpRight, RotateCcw, Check } from "lucide-react";
import type { Workspace, QuestionView } from "@/lib/types";
import { Activity } from "./dashboard";
export function HistoryView({
  data,
  onQuestion,
}: {
  data: Workspace;
  onQuestion: (q: QuestionView) => void;
}) {
  const labels = ["", "忘了", "困难", "记得", "轻松"];
  return (
    <div className="page history-page">
      <div className="page-heading">
        <div>
          <h1>回顾记录</h1>
          <p className="muted">{data.stats.totalReviews} 次复习</p>
        </div>
      </div>
      <section className="history-activity">
        <div className="section-heading">
          <h2>最近半年的积累</h2>
          <span>连续学习 {data.stats.streak} 天</span>
        </div>
        <Activity data={data} days={182} />
      </section>
      <div className="question-list-panel">
        <div className="list-toolbar">
          <h2>最近 30 次复习</h2>
        </div>
        {data.recentReviews.length ? (
          data.recentReviews.map((r) => (
            <div className="history-row" key={r.id}>
              <span
                className={`history-icon rating-${r.rating === 1 ? "again" : "good"}`}
              >
                {r.rating === 1 ? <RotateCcw size={16} /> : <Check size={16} />}
              </span>
              <div>
                <button
                  onClick={() => {
                    const question = data.questions.find(
                      (q) => q.id === r.questionId,
                    );
                    if (question) onQuestion(question);
                  }}
                >
                  {r.title}
                  <ArrowUpRight size={13} />
                </button>
                <p>
                  {new Intl.DateTimeFormat("zh-CN", {
                    timeZone: data.settings.timeZone,
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(r.createdAt))}
                </p>
                {r.answer && (
                  <details className="past-answer">
                    <summary>我的作答</summary>
                    <p>{r.answer}</p>
                  </details>
                )}
              </div>
              <span className="tag">{labels[r.rating]}</span>
            </div>
          ))
        ) : (
          <div className="empty-state">
            <History size={32} />
            <h3>还没有复习记录</h3>
          </div>
        )}
      </div>
    </div>
  );
}
