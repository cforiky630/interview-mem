"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="fatal-error">
      <h1>这一页暂时没能打开</h1>
      <p>请重试。你的资料与已保存的复习记录仍在数据库中。</p>
      <button className="button button-primary" onClick={reset}>
        重新加载
      </button>
    </main>
  );
}
