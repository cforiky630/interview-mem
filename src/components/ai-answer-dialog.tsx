"use client";
import { Loader2, PencilLine, RotateCcw, Sparkles, Square } from "lucide-react";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import type { useAiAnswerDraft } from "./use-ai-answer-draft";

export function AiAnswerDialog({
  draft,
}: {
  draft: ReturnType<typeof useAiAnswerDraft>;
}) {
  return (
    <Dialog
      open={!!draft.question}
      onOpenChange={(open) => {
        if (!open) draft.close();
      }}
      title="AI 参考答案"
      className="answer-composer-dialog"
    >
      <h3 className="answer-composer-question">{draft.question?.title}</h3>
      <details className="answer-composer-requirements">
        <summary>补充要求</summary>
        <textarea
          aria-label="答案补充要求"
          placeholder="例如：侧重底层原理并用 Java/TypeScript 举例；按“一句话结论 → 核心机制 → 实战踩坑”三段展开，控制在两分钟口述长度。"
          value={draft.instructions}
          onChange={(e) => draft.changeInstructions(e.target.value)}
          maxLength={1000}
          rows={2}
          disabled={draft.busy || draft.saving}
        />
      </details>
      <div className="answer-composer-tools">
        {draft.busy ? (
          <span role="status">
            <Loader2 size={15} className="spin" />
            正在写参考答案…
          </span>
        ) : (
          <span>参考答案草稿</span>
        )}
        {!!draft.answer && (
          <Button
            size="sm"
            variant="ghost"
            disabled={draft.busy || draft.saving}
            onClick={() => draft.setEditing(!draft.editing)}
          >
            <PencilLine size={14} />
            {draft.editing ? "预览" : "编辑"}
          </Button>
        )}
      </div>
      <div className="answer-composer-body" aria-busy={draft.busy}>
        {draft.editing ? (
          <textarea
            className="answer-composer-editor"
            aria-label="参考答案草稿"
            placeholder="支持 Markdown 格式编写参考答案；若加入「## 面试追问」及 Q：/ A： 问答，保存后会自动切分为追问抽认卡。"
            value={draft.answer}
            onChange={(e) => draft.edit(e.target.value)}
            maxLength={100000}
            disabled={draft.saving}
          />
        ) : draft.answer ? (
          <Markdown>{draft.answer}</Markdown>
        ) : draft.busy ? (
          <div className="answer-composer-skeleton" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
        ) : (
          <p className="quiet-empty">
            尚未生成参考答案草稿。你可以先点开上方「补充要求」写明偏好语言栈或详略程度，再点击下方「生成答案」；生成后可直接编辑或直接入库。
          </p>
        )}
      </div>
      {draft.error && (
        <p className="form-error" role="alert">
          {draft.error}
          {draft.needsKey && (
            <button className="text-button" onClick={draft.configure}>
              去配置 AI
            </button>
          )}
        </p>
      )}
      <div className="dialog-footer answer-composer-footer">
        {draft.busy ? (
          <Button variant="ghost" onClick={draft.stop}>
            <Square size={14} />
            停止生成
          </Button>
        ) : (
          <Button
            variant="ghost"
            disabled={draft.saving}
            onClick={draft.regenerate}
          >
            <RotateCcw size={15} />
            {draft.answer ? "重新生成" : "生成答案"}
          </Button>
        )}
        <Button
          onClick={draft.save}
          disabled={draft.busy || draft.saving || !draft.answer.trim()}
        >
          {draft.saving ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Sparkles size={15} />
          )}
          保存为参考答案
        </Button>
      </div>
    </Dialog>
  );
}
