"use client";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, RequestError } from "@/lib/client";
import type { QuestionView, Workspace } from "@/lib/types";
import {
  practiceDraftKey,
  readPracticeDraft,
  savePracticeDraft,
} from "@/lib/drafts";
import type { Mutate } from "./dialogs";

export function useAiAnswerDraft(
  data: Workspace | null,
  mutate: Mutate,
  onSettings: () => void,
) {
  const [question, setQuestion] = useState<QuestionView | null>(null);
  const [answer, setAnswer] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const request = useRef<AbortController | null>(null);
  const saveInFlight = useRef(false);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [],
  );

  function key(q: QuestionView) {
    return practiceDraftKey(data!.user.id, q.id, q.revision, "ai-reference");
  }
  function persist(q: QuestionView, value: string, requirements: string) {
    savePracticeDraft(
      key(q),
      JSON.stringify({ answer: value, instructions: requirements }),
    );
  }
  function stop() {
    const controller = request.current;
    request.current = null;
    controller?.abort();
    setBusy(false);
  }
  function close() {
    if (saveInFlight.current) return;
    stop();
    setQuestion(null);
    setError("");
  }
  async function generate(q: QuestionView, requirements: string) {
    if (!data || request.current || saveInFlight.current) return;
    if (!data.settings.hasKey) {
      close();
      onSettings();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setEditing(false);
    setError("");
    setNeedsKey(false);
    try {
      const result = await api<{ answer: string; questionRevision: number }>(
        "/api/questions/answer",
        {
          questionId: q.id,
          expectedRevision: q.revision,
          instructions: requirements,
        },
        { userId: data.user.id, signal: controller.signal },
      );
      if (request.current !== controller) return;
      if (result.questionRevision !== q.revision)
        throw new Error("题目版本已变化，请重新打开题目。");
      setAnswer(result.answer);
      persist(q, result.answer, requirements);
    } catch (e) {
      if (request.current !== controller || controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : "答案未能生成，请重试。");
      setNeedsKey(e instanceof RequestError && e.code === "KEY_REQUIRED");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  function open(q: QuestionView) {
    if (!data || !q.isOwner || q.archived || q.answer.trim()) return;
    if (!data.settings.hasKey) {
      onSettings();
      return;
    }
    stop();
    let saved = { answer: "", instructions: "" };
    try {
      const value = JSON.parse(readPracticeDraft(key(q)) || "null");
      if (
        typeof value?.answer === "string" &&
        value.answer.length <= 100_000 &&
        typeof value.instructions === "string" &&
        value.instructions.length <= 1000
      )
        saved = value;
    } catch {
      /* Ignore a damaged browser draft. */
    }
    setQuestion(q);
    setAnswer(saved.answer);
    setInstructions(saved.instructions);
    setEditing(false);
    setError("");
    setNeedsKey(false);
    if (!saved.answer) void generate(q, saved.instructions);
  }
  function edit(value: string) {
    setAnswer(value);
    if (question) persist(question, value, instructions);
  }
  function changeInstructions(value: string) {
    setInstructions(value);
    if (question) persist(question, answer, value);
  }
  async function save() {
    if (!question || !answer.trim() || busy || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await mutate("/api/questions", {
        action: "edit",
        id: question.id,
        expectedRevision: question.revision,
        title: question.title,
        answer,
        tags: question.tags,
        major: false,
      });
      if (!result) {
        setError("未能保存，答案草稿已保留，可编辑或复制后重试。");
        return;
      }
      savePracticeDraft(key(question), "");
      setQuestion(null);
      toast.success("参考答案已保存。");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }
  return {
    question,
    answer,
    instructions,
    busy,
    saving,
    editing,
    error,
    needsKey,
    open,
    close,
    stop,
    edit,
    changeInstructions,
    setEditing,
    regenerate: () => {
      if (question) void generate(question, instructions);
    },
    save: () => void save(),
    configure: () => {
      close();
      onSettings();
    },
  };
}
