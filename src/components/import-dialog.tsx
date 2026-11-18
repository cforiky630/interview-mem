"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  FileText,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/client";
import { readPracticeDraft, savePracticeDraft } from "@/lib/drafts";
import type { ImportType } from "@/lib/importer";
import type { ImportFile } from "@/lib/import-files";
import { IMPORT_LIMITS } from "@/lib/import-material";
import type { ProofreadItemResult } from "@/lib/ai-proofread";
import type { ImportMethod, ImportPreview } from "@/lib/import-preview";
import type { Workspace } from "@/lib/types";
import type { Mutate } from "./dialogs";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ImportPreviewCard, type ImportCandidate } from "./import-preview-card";
import { ImportSourceInput } from "./import-source-input";
import "./import-dialog.css";

export type ImportEditContext = {
  id: string;
  title: string;
  revision: number;
  major: boolean;
  tags: string[];
};
export type ImportSeed = {
  raw: string;
  deckId?: string | null;
  editQuestion?: ImportEditContext;
};
type PreviewSource = {
  batchId: string;
  name: string;
  warning?: string;
  fileId?: string;
};
type SavedDraft = {
  raw: string;
  inputType: ImportType;
  method: ImportMethod;
  deckId: string;
  proofreadEnabled?: boolean;
  sourceName?: string;
  batchId?: string;
  sources?: PreviewSource[];
  files?: ImportFile[];
  fileMode?: boolean;
  step?: "source" | "preview";
  signature: string;
  questions: (Omit<ImportCandidate, "batchId"> & { batchId?: string })[];
  replaceKey?: string;
};

function writeDraft(storage: string, draft: SavedDraft | null) {
  savePracticeDraft(storage, draft?.raw ?? "");
  if (draft) savePracticeDraft(`${storage}:type`, draft.inputType);
  savePracticeDraft(`${storage}:review`, draft ? JSON.stringify(draft) : "");
}

export function ImportDialog({
  open,
  onClose,
  data,
  preferredDeck,
  mutate,
  onView,
  onInbox,
  onSettings,
  seed,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  data: Workspace;
  preferredDeck?: string | null;
  mutate: Mutate;
  onView: (id: string | null) => void;
  onInbox: () => void;
  onSettings: () => void;
  seed?: ImportSeed;
  onImported?: () => void;
}) {
  const own = data.decks.filter((d) => d.isOwner);
  const storage = `shiyi:import:${data.user.id}${seed?.editQuestion ? `:edit:${seed.editQuestion.id}` : ""}`;
  const [raw, setRaw] = useState("");
  const [inputType, setInputType] = useState<ImportType>("qa");
  const [method, setMethod] = useState<ImportMethod>("rules");
  const [deckId, setDeckId] = useState(
    preferredDeck === null ? "" : (preferredDeck ?? own[0]?.id ?? ""),
  );
  const [sourceName, setSourceName] = useState("");
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [fileMode, setFileMode] = useState(false);
  const [reading, setReading] = useState(false);
  const [questions, setQuestions] = useState<ImportCandidate[]>([]);
  const [step, setStep] = useState<"source" | "preview">("source");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [replaceKey, setReplaceKey] = useState("");
  const [undo, setUndo] = useState<{
    questions: ImportCandidate[];
    sources: PreviewSource[];
    files: ImportFile[];
    fileMode: boolean;
    previewSignature: string;
    replaceKey: string;
    expandedKey: string | null;
  } | null>(null);
  const [sources, setSources] = useState<PreviewSource[]>([]);
  const [previewSignature, setPreviewSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [proofreadEnabled, setProofreadEnabled] = useState(false);
  const [proofreading, setProofreading] = useState(false);
  const [proofreadProgress, setProofreadProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    added: number;
    duplicates: number;
    updated: number;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const proofreadController = useRef<AbortController | null>(null);
  const aiPreviews = useRef<{
    options: string;
    items: Map<string, ImportPreview>;
  } | null>(null);
  const committing = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const destination = own.find((deck) => deck.id === deckId)?.title ?? "未分类";
  const signature = useMemo(
    () =>
      JSON.stringify(
        fileMode
          ? ["files", files.map((file) => file.id), inputType, method, deckId]
          : [raw, inputType, method, deckId, sourceName],
      ),
    [raw, inputType, method, deckId, sourceName, fileMode, files],
  );
  const hasPreview = sources.length > 0;
  const canParse = fileMode ? files.length > 0 : !!raw.trim();
  const stale = hasPreview && signature !== previewSignature;
  const selected = questions.filter((q) => q.selected);
  const overBatch =
    selected.reduce((total, q) => total + q.title.length + q.answer.length, 0) >
    IMPORT_LIMITS.batchChars;
  const invalid =
    overBatch ||
    selected.some(
      (q) =>
        !q.title.trim() || q.title.length > 200 || q.answer.length > 100_000,
    ) ||
    (!!replaceKey && !selected.some((q) => q.key === replaceKey));
  useEffect(() => {
    try {
      const saved = JSON.parse(
        readPracticeDraft(`${storage}:review`) || "null",
      ) as SavedDraft | null;
      if (
        saved &&
        (!seed || saved.raw === seed.raw) &&
        typeof saved.raw === "string" &&
        saved.raw.length <= IMPORT_LIMITS.sourceChars &&
        ["qa", "questions"].includes(saved.inputType) &&
        ["rules", "ai", "whole"].includes(saved.method) &&
        Array.isArray(saved.questions) &&
        saved.questions.length <= IMPORT_LIMITS.questions &&
        saved.questions.every(
          (q) =>
            typeof q.key === "string" &&
            typeof q.title === "string" &&
            typeof q.answer === "string" &&
            Array.isArray(q.tags),
        )
      ) {
        setRaw(saved.raw);
        setInputType(saved.inputType);
        setMethod(saved.method);
        setProofreadEnabled(!!saved.proofreadEnabled);
        setSourceName(saved.sourceName || "");
        if (!saved.deckId || own.some((d) => d.id === saved.deckId))
          setDeckId(saved.deckId);
        const previousFiles = Array.isArray(saved.files)
          ? saved.files
              .filter(
                (file) =>
                  typeof file?.id === "string" &&
                  typeof file.name === "string" &&
                  typeof file.raw === "string",
              )
              .slice(0, IMPORT_LIMITS.files)
          : [];
        const rawSources =
          (Array.isArray(saved.sources) ? saved.sources : undefined) ??
          (saved.batchId
            ? [
                {
                  batchId: saved.batchId,
                  name: saved.sourceName ?? "",
                },
              ]
            : []);
        const previousSources = rawSources.map((source, index) => {
          const matchedByIndex =
            rawSources.length === previousFiles.length &&
            previousFiles[index]?.name === source.name
              ? previousFiles[index]?.id
              : undefined;
          const matchedByName = source.name
            ? previousFiles.find((file) => file.name === source.name)?.id
            : undefined;
          return {
            ...source,
            ...(source.fileId || matchedByIndex || matchedByName
              ? { fileId: source.fileId ?? matchedByIndex ?? matchedByName }
              : {}),
          };
        });
        setSources(previousSources);
        setFiles(previousFiles);
        setFileMode(!!saved.fileMode && previousFiles.length > 0);
        setPreviewSignature(saved.signature);
        // 兼容此前只记录一个 batchId 的草稿，逐题补齐来源。
        setQuestions(
          saved.questions.flatMap(
            ({
              key,
              title,
              answer,
              tags,
              selected,
              batchId,
              proofreadStatus,
              corrections,
            }) => {
              const id = batchId ?? saved.batchId;
              return id &&
                previousSources.some((source) => source.batchId === id)
                ? [
                    {
                      key,
                      title,
                      answer,
                      tags,
                      selected,
                      batchId: id,
                      ...(proofreadStatus && proofreadStatus !== "checking"
                        ? { proofreadStatus }
                        : {}),
                      ...(Array.isArray(corrections) ? { corrections } : {}),
                    },
                  ]
                : [];
            },
          ),
        );
        setReplaceKey(saved.replaceKey ?? "");
        if (previousSources.length && saved.step !== "source") {
          setStep("preview");
          setExpandedKey(
            saved.questions[0]?.answer.trim() ? saved.questions[0].key : null,
          );
        }
      } else if (seed) {
        setRaw(seed.raw);
        setInputType("qa");
        setMethod("rules");
      } else {
        setRaw(readPracticeDraft(storage));
        setInputType(
          readPracticeDraft(`${storage}:type`) === "questions"
            ? "questions"
            : "qa",
        );
      }
    } catch {
      setRaw(readPracticeDraft(storage));
    }
    setLoaded(true);
    return () => {
      controller.current?.abort();
      controller.current = null;
      proofreadController.current?.abort();
      proofreadController.current = null;
    };
  }, [storage]);
  useEffect(() => {
    if (!loaded || result) return;
    writeDraft(storage, {
      raw,
      inputType,
      method,
      deckId,
      proofreadEnabled,
      sourceName,
      sources,
      files,
      fileMode,
      step,
      signature: previewSignature,
      questions,
      replaceKey,
    });
  }, [
    loaded,
    raw,
    inputType,
    method,
    deckId,
    proofreadEnabled,
    sourceName,
    sources,
    files,
    fileMode,
    step,
    previewSignature,
    questions,
    replaceKey,
    result,
    storage,
  ]);
  useEffect(() => {
    if (loaded && seed && !hasPreview && !fileMode && method === "rules") {
      const timer = setTimeout(() => void parse(), 0);
      return () => clearTimeout(timer);
    }
  }, [loaded, storage]);
  useEffect(() => {
    if (step === "preview")
      previewHeading.current?.focus({ preventScroll: true });
  }, [step]);
  function abortProofread() {
    const old = proofreadController.current;
    proofreadController.current = null;
    old?.abort();
    setProofreading(false);
    setProofreadProgress(null);
    setQuestions((items) =>
      items.map((q) =>
        q.proofreadStatus === "checking"
          ? { ...q, proofreadStatus: undefined }
          : q,
      ),
    );
  }
  function stop() {
    const old = controller.current;
    controller.current = null;
    old?.abort();
    setBusy(false);
    setProgress(0);
    abortProofread();
  }
  function close() {
    if (committing.current) return;
    stop();
    onClose();
  }
  async function runProofread(targets: ImportCandidate[]) {
    if (!data.settings.hasKey) {
      onSettings();
      return;
    }
    const eligible = targets.filter(
      (q) =>
        q.title.trim() &&
        q.title.length <= 200 &&
        q.title.length + q.answer.length <= IMPORT_LIMITS.aiChars,
    );
    if (!eligible.length) {
      setError("当前题目为空或超过单题 25000 字符的 AI 纠错上限。");
      return;
    }
    proofreadController.current?.abort();
    const next = new AbortController();
    proofreadController.current = next;
    const chunks: ImportCandidate[][] = [];
    let batch: ImportCandidate[] = [];
    let chars = 0;
    for (const item of eligible) {
      const len = item.title.length + item.answer.length;
      if (batch.length >= 6 || (batch.length > 0 && chars + len > 14_000)) {
        chunks.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(item);
      chars += len;
    }
    if (batch.length) chunks.push(batch);

    const eligibleKeys = new Set(eligible.map((q) => q.key));
    setQuestions((items) =>
      items.map((q) =>
        eligibleKeys.has(q.key)
          ? { ...q, proofreadStatus: "checking", corrections: undefined }
          : q,
      ),
    );
    setProofreading(true);
    setProofreadProgress({ current: 0, total: chunks.length });
    setError("");
    let openedIssueCard = false;
    try {
      for (const [index, chunk] of chunks.entries()) {
        next.signal.throwIfAborted();
        const response = await api<{ items: ProofreadItemResult[] }>(
          "/api/import/proofread",
          {
            questions: chunk.map(({ key, title, answer }) => ({
              key,
              title,
              answer,
            })),
          },
          { userId: data.user.id, signal: next.signal },
        );
        if (proofreadController.current !== next) return;
        const resultMap = new Map(
          response.items.map((item) => [item.key, item.corrections] as const),
        );
        let firstIssueKey: string | null = null;
        setQuestions((items) =>
          items.map((q) => {
            const found = resultMap.get(q.key);
            if (!found) return q;
            if (!firstIssueKey && found.length > 0) firstIssueKey = q.key;
            return {
              ...q,
              corrections: found,
              proofreadStatus: found.length > 0 ? "has_issues" : "clean",
            };
          }),
        );
        if (firstIssueKey && !openedIssueCard) {
          openedIssueCard = true;
          setExpandedKey(firstIssueKey);
        }
        setProofreadProgress({ current: index + 1, total: chunks.length });
      }
    } catch (e) {
      if (proofreadController.current === next && !next.signal.aborted) {
        setError(
          e instanceof Error
            ? e.message
            : "AI 纠错未能完成，已保留全部原文。",
        );
        setQuestions((items) =>
          items.map((q) =>
            q.proofreadStatus === "checking"
              ? { ...q, proofreadStatus: undefined }
              : q,
          ),
        );
      }
    } finally {
      if (proofreadController.current === next) {
        proofreadController.current = null;
        setProofreading(false);
        setProofreadProgress(null);
      }
    }
  }
  async function parse() {
    if (
      controller.current ||
      proofreadController.current ||
      !canParse ||
      reading ||
      committing.current
    )
      return;
    if ((method === "ai" || proofreadEnabled) && !data.settings.hasKey) {
      onSettings();
      return;
    }
    const materials = fileMode ? files : [{ id: "", name: sourceName, raw }];
    if (method === "ai") {
      const large = materials.find(
        (file) => file.raw.length > IMPORT_LIMITS.aiChars,
      );
      if (large) {
        setError(
          `${large.name ? `「${large.name}」` : "原文"}超过 AI 解析的 25000 字符上限，可改用自动切分。`,
        );
        return;
      }
    }
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setError("");
    setResult(null);
    let parsedCandidates: ImportCandidate[] | null = null;
    try {
      const options = { deckId: deckId || null, inputType, method };
      const request = { userId: data.user.id, signal: next.signal };
      const inputs = materials.map((material) => ({
        batchId: crypto.randomUUID(),
        raw: material.raw,
        ...(material.name ? { sourceName: material.name } : {}),
      }));
      let previews: ImportPreview[];
      if (inputs.length > 1 && method !== "ai") {
        ({ previews } = await api<{ previews: ImportPreview[] }>(
          "/api/import/preview",
          { ...options, sources: inputs },
          request,
        ));
      } else {
        previews = [];
        const aiOptions = JSON.stringify(options);
        for (const [index, input] of inputs.entries()) {
          next.signal.throwIfAborted();
          setProgress(index + 1);
          const id = materials[index].id;
          // 多文件 AI 按顺序调用。中途失败或取消后可复用本次已完成的文件。
          if (
            method === "ai" &&
            id &&
            aiPreviews.current?.options !== aiOptions
          )
            aiPreviews.current = { options: aiOptions, items: new Map() };
          const cache =
            method === "ai" && id ? aiPreviews.current?.items : undefined;
          let preview = cache?.get(id);
          if (!preview) {
            try {
              preview = await api<ImportPreview>(
                "/api/import/preview",
                { ...options, ...input },
                request,
              );
              cache?.set(id, preview);
            } catch (error) {
              if (input.sourceName && error instanceof Error)
                throw new Error(`「${input.sourceName}」：${error.message}`);
              throw error;
            }
          }
          previews.push(preview);
          if (
            previews.reduce((total, item) => total + item.questions.length, 0) >
            IMPORT_LIMITS.questions
          )
            throw new Error("本批超过 200 道题，请分批导入。");
        }
      }
      if (controller.current !== next) return;
      const candidates = previews.flatMap(({ batchId, questions }) =>
        questions.map(({ key, title, answer, tags }) => ({
          key,
          title,
          answer,
          tags,
          batchId,
          selected: true,
        })),
      );
      setQuestions(candidates);
      if (seed?.editQuestion) {
        const matches = candidates.filter(
          (q) =>
            q.title.trim().replace(/\s+/g, " ").replace(/？/g, "?") ===
            seed
              .editQuestion!.title.trim()
              .replace(/\s+/g, " ")
              .replace(/？/g, "?"),
        );
        setReplaceKey(matches.length === 1 ? matches[0].key : "");
      }
      setSources(
        previews.map((preview, index) => ({
          batchId: preview.batchId,
          name: materials[index].name,
          warning: preview.warning,
          ...(materials[index].id ? { fileId: materials[index].id } : {}),
        })),
      );
      setPreviewSignature(signature);
      setUndo(null);
      setExpandedKey(candidates[0]?.answer.trim() ? candidates[0].key : null);
      aiPreviews.current = null;
      setStep("preview");
      parsedCandidates = candidates;
    } catch (e) {
      if (controller.current === next && !next.signal.aborted)
        setError(e instanceof Error ? e.message : "解析失败，请重试。");
    } finally {
      if (controller.current === next) {
        controller.current = null;
        setBusy(false);
        setProgress(0);
      }
    }
    if (parsedCandidates && proofreadEnabled) {
      void runProofread(parsedCandidates);
    }
  }
  async function commit() {
    if (
      !hasPreview ||
      stale ||
      !selected.length ||
      invalid ||
      proofreading ||
      committing.current
    )
      return;
    committing.current = true;
    setSaving(true);
    setError("");
    try {
      const batches = sources
        .map(({ batchId }) => ({
          batchId,
          questions: selected
            .filter((q) => q.batchId === batchId)
            .map(({ key, title, answer, tags }) => ({
              key,
              title,
              answer,
              // 更新当前题时沿用编辑页的标签。
              tags:
                key === replaceKey && seed?.editQuestion
                  ? seed.editQuestion.tags
                  : tags,
            })),
        }))
        .filter((batch) => batch.questions.length);
      const saved = await mutate("/api/import/commit", {
        ...(batches.length === 1 ? batches[0] : { batches }),
        ...(replaceKey && seed?.editQuestion
          ? {
              replace: {
                id: seed.editQuestion.id,
                key: replaceKey,
                expectedRevision: seed.editQuestion.revision,
                major: seed.editQuestion.major,
              },
            }
          : {}),
      });
      if (saved) {
        setResult({
          added: Number(saved.added),
          duplicates: Number(saved.duplicates),
          updated: Number(saved.updated ?? 0),
        });
        // 只清理这次入库的来源。切到文件模式前粘贴的正文仍是另一份草稿。
        const remainingText = fileMode ? raw : "";
        const remainingFiles = fileMode ? [] : files;
        writeDraft(
          storage,
          remainingText.trim() || remainingFiles.length
            ? {
                raw: remainingText,
                files: remainingFiles,
                fileMode: !!remainingFiles.length,
                sourceName: fileMode ? sourceName : "",
                inputType,
                method,
                deckId,
                step: "source",
                signature: "",
                questions: [],
              }
            : null,
        );
        onImported?.();
      } else {
        setError("本次未能保存，预览和草稿已保留。");
      }
    } finally {
      committing.current = false;
      setSaving(false);
    }
  }
  function change(key: string, patch: Partial<ImportCandidate>) {
    if (patch.selected === false && key === replaceKey) setReplaceKey("");
    setQuestions((items) =>
      items.map((q) => (q.key === key ? { ...q, ...patch } : q)),
    );
  }
  function rememberPreview() {
    setUndo({
      questions,
      sources,
      files,
      fileMode,
      previewSignature,
      replaceKey,
      expandedKey,
    });
  }
  function resetPreview() {
    setSources([]);
    setQuestions([]);
    setPreviewSignature("");
    setUndo(null);
    setExpandedKey(null);
    setReplaceKey("");
    setStep("source");
  }
  function discardPreview() {
    if (fileMode || sources.some((s) => s.fileId || s.name)) {
      setFiles([]);
      setFileMode(false);
    } else {
      setRaw("");
      setSourceName("");
    }
    resetPreview();
  }
  function matchesOptions(sig: string) {
    try {
      const parsed = JSON.parse(sig) as unknown[];
      return (
        Array.isArray(parsed) &&
        parsed[0] === "files" &&
        parsed[2] === inputType &&
        parsed[3] === method &&
        parsed[4] === deckId
      );
    } catch {
      return false;
    }
  }
  function removeSource(batchId: string) {
    const target = sources.find((s) => s.batchId === batchId);
    if (!target) return;
    rememberPreview();
    const remainingSources = sources.filter((s) => s.batchId !== batchId);
    const remainingQuestions = questions.filter((q) => q.batchId !== batchId);
    const remainingFiles = files.filter(
      (f) => f.id !== target.fileId && (!target.name || f.name !== target.name),
    );
    if (replaceKey && !remainingQuestions.some((q) => q.key === replaceKey))
      setReplaceKey("");
    if (expandedKey && !remainingQuestions.some((q) => q.key === expandedKey))
      setExpandedKey(remainingQuestions[0]?.key ?? null);
    setSources(remainingSources);
    setQuestions(remainingQuestions);
    setFiles(remainingFiles);
    if (!remainingFiles.length) setFileMode(false);
    if (!remainingSources.length) {
      setPreviewSignature("");
    } else if (
      fileMode &&
      matchesOptions(previewSignature) &&
      remainingFiles.every((f) =>
        remainingSources.some(
          (s) => s.fileId === f.id || (s.name && s.name === f.name),
        ),
      )
    ) {
      setPreviewSignature(
        JSON.stringify([
          "files",
          remainingFiles.map((file) => file.id),
          inputType,
          method,
          deckId,
        ]),
      );
    }
  }
  function remove(index: number) {
    const removed = questions[index];
    if (!removed) return;
    if (removed.key === replaceKey) setReplaceKey("");
    rememberPreview();
    const remaining = questions.filter((_, i) => i !== index);
    if (removed.key === expandedKey)
      setExpandedKey(
        remaining[Math.min(index, remaining.length - 1)]?.key ?? null,
      );
    setQuestions(remaining);
    const hasMoreInBatch = remaining.some((q) => q.batchId === removed.batchId);
    if (!hasMoreInBatch) {
      const target = sources.find((s) => s.batchId === removed.batchId);
      if (target && (target.fileId || target.name)) {
        const remainingSources = sources.filter(
          (s) => s.batchId !== removed.batchId,
        );
        const remainingFiles = files.filter(
          (f) =>
            f.id !== target.fileId && (!target.name || f.name !== target.name),
        );
        setSources(remainingSources);
        setFiles(remainingFiles);
        if (!remainingFiles.length) setFileMode(false);
        if (!remainingSources.length) {
          setPreviewSignature("");
        } else if (
          fileMode &&
          matchesOptions(previewSignature) &&
          remainingFiles.every((f) =>
            remainingSources.some(
              (s) => s.fileId === f.id || (s.name && s.name === f.name),
            ),
          )
        ) {
          setPreviewSignature(
            JSON.stringify([
              "files",
              remainingFiles.map((file) => file.id),
              inputType,
              method,
              deckId,
            ]),
          );
        }
      }
    }
  }
  function merge(index: number) {
    if (index < 1) return;
    const previous = questions[index - 1],
      current = questions[index];
    if (previous.batchId !== current.batchId) return;
    const title =
      inputType === "questions" && !previous.answer && !current.answer
        ? `${previous.title}；${current.title}`
        : previous.title;
    if (title.length > 200) {
      setError("合并后的题目超过 200 字，请先调整标题。");
      return;
    }
    if (current.key === replaceKey) setReplaceKey(previous.key);
    rememberPreview();
    if (expandedKey === current.key) setExpandedKey(previous.key);
    setQuestions((items) =>
      items.flatMap((q, i) =>
        i === index
          ? []
          : i === index - 1
            ? [
                {
                  ...q,
                  title,
                  selected: q.selected || current.selected,
                  answer:
                    inputType === "questions" &&
                    !previous.answer &&
                    !current.answer
                      ? ""
                      : `${q.answer}\n\n## ${current.title}\n\n${current.answer}`,
                },
              ]
            : [q],
      ),
    );
  }
  function addQuestion() {
    const source =
      questions.find((q) => q.key === expandedKey)?.batchId ??
      sources.at(-1)?.batchId;
    if (!source) return;
    rememberPreview();
    const key = crypto.randomUUID();
    const sourcePosition = sources.findIndex((item) => item.batchId === source);
    const laterSources = new Set(
      sources.slice(sourcePosition + 1).map((item) => item.batchId),
    );
    const nextGroup = questions.findIndex((item) =>
      laterSources.has(item.batchId),
    );
    const index = nextGroup < 0 ? questions.length : nextGroup;
    setQuestions([
      ...questions.slice(0, index),
      { key, title: "", answer: "", tags: [], selected: true, batchId: source },
      ...questions.slice(index),
    ]);
    setExpandedKey(key);
    requestAnimationFrame(() => {
      document
        .getElementById(`import-card-${key}`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }
  const locked = busy || proofreading || reading || saving || !!result;
  const parseLabel = hasPreview ? "重新解析" : "解析并预览";
  const toInbox = selected.every((q) => !q.answer.trim());
  const allSelected =
    questions.length > 0 && selected.length === questions.length;
  const proofreadPendingTotal = questions.reduce(
    (sum, q) =>
      sum + (q.corrections?.filter((c) => c.status === "pending").length ?? 0),
    0,
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
      title={seed?.editQuestion ? "预览题目切分" : "导入面试题"}
      className="import-workflow"
    >
      <div className="import-step-bar">
        <div className="import-steps" role="group" aria-label="导入步骤">
          <button
            type="button"
            aria-pressed={step === "source"}
            disabled={locked}
            onClick={() => setStep("source")}
          >
            <FileText size={16} /> 原文资料
          </button>
          <button
            type="button"
            aria-pressed={step === "preview"}
            disabled={!hasPreview || locked}
            onClick={() => setStep("preview")}
          >
            <ListChecks size={16} /> 解析预览
          </button>
        </div>
        {step === "preview" && (
          <p className="import-destination">
            保存到 <strong title={destination}>{destination}</strong>
          </p>
        )}
      </div>
      {step === "source" ? (
        <section
          className="import-stage import-source-stage"
          aria-label="原文资料"
        >
          <div className="import-source-options">
            <div className="import-choice" role="tablist" aria-label="资料内容">
              {(
                [
                  ["qa", "题目与答案"],
                  ["questions", "只有题目"],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={inputType === id}
                  key={id}
                  disabled={locked}
                  onClick={() => {
                    setInputType(id);
                    if (id === "questions" && method === "whole")
                      setMethod("rules");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="import-choice" role="group" aria-label="解析方式">
              {(
                [
                  ["rules", "自动切分"],
                  ["ai", "AI 解析"],
                  ...(inputType === "qa" ? [["whole", "整篇保留"]] : []),
                ] as [ImportMethod, string][]
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={method === id}
                  disabled={locked}
                  onClick={() => setMethod(id)}
                >
                  {id === "ai" && <Sparkles size={14} />} {label}
                </button>
              ))}
            </div>
            <label
              className="import-proofread-switch"
              title="开启后由 AI 仅检查客观错别字、术语与概念硬伤，不直接修改原文，以 Diff 对照形式交由你决定"
            >
              <input
                type="checkbox"
                role="switch"
                {...({ switch: "" } as Record<string, string>)}
                aria-label="AI 纠错"
                checked={proofreadEnabled}
                disabled={locked}
                onChange={(event) => setProofreadEnabled(event.target.checked)}
              />
              <span>
                <Sparkles size={14} aria-hidden="true" />
                AI 纠错
              </span>
            </label>
            <label className="field import-destination-field">
              保存到题库
              <select
                aria-label="保存到题库"
                value={deckId}
                disabled={locked}
                onChange={(event) => setDeckId(event.target.value)}
              >
                <option value="">未分类</option>
                {own.map((deck) => (
                  <option key={deck.id} value={deck.id}>
                    {deck.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ImportSourceInput
            raw={raw}
            onRawChange={(value) => {
              setRaw(value);
              setSourceName("");
              setError("");
              if (!value.trim() && !files.length && hasPreview) resetPreview();
            }}
            files={files}
            onFilesChange={(nextFiles) => {
              setError("");
              if (!nextFiles.length) {
                setFiles([]);
                if (fileMode) setFileMode(false);
                if (
                  hasPreview &&
                  (sources.some((s) => s.fileId || s.name) || !raw.trim())
                )
                  resetPreview();
                return;
              }
              if (hasPreview && nextFiles.length < files.length) {
                const nextIds = new Set(nextFiles.map((file) => file.id));
                const nextNames = new Set(nextFiles.map((file) => file.name));
                const matchedSources = sources.filter(
                  (source) =>
                    (source.fileId && nextIds.has(source.fileId)) ||
                    (source.name && nextNames.has(source.name)),
                );
                const allRemainingParsed = nextFiles.every((file) =>
                  matchedSources.some(
                    (source) =>
                      source.fileId === file.id ||
                      (source.name && source.name === file.name),
                  ),
                );
                if (allRemainingParsed && matchedSources.length) {
                  const keptBatchIds = new Set(
                    matchedSources.map((source) => source.batchId),
                  );
                  const remainingQuestions = questions.filter((q) =>
                    keptBatchIds.has(q.batchId),
                  );
                  setSources(matchedSources);
                  setQuestions(remainingQuestions);
                  if (
                    replaceKey &&
                    !remainingQuestions.some((q) => q.key === replaceKey)
                  )
                    setReplaceKey("");
                  if (
                    expandedKey &&
                    !remainingQuestions.some((q) => q.key === expandedKey)
                  )
                    setExpandedKey(remainingQuestions[0]?.key ?? null);
                  setUndo(null);
                  if (fileMode && matchesOptions(previewSignature)) {
                    setPreviewSignature(
                      JSON.stringify([
                        "files",
                        nextFiles.map((file) => file.id),
                        inputType,
                        method,
                        deckId,
                      ]),
                    );
                  }
                }
              }
              setFiles(nextFiles);
            }}
            fileMode={fileMode}
            onModeChange={(value) => {
              setFileMode(value);
              setError("");
            }}
            onReadingChange={setReading}
            questionsOnly={inputType === "questions"}
            disabled={locked}
          />
          {fileMode &&
            method === "ai" &&
            files.length > 1 &&
            data.settings.hasKey && (
              <p className="import-file-notice">
                AI 将逐个解析 {files.length} 个文件。
              </p>
            )}
        </section>
      ) : (
        <section
          className="import-stage import-preview-stage"
          aria-label="解析结果"
          aria-busy={busy || proofreading || saving}
        >
          <div className="import-review-header">
            <h2 ref={previewHeading} tabIndex={-1}>
              {questions.length} 道主问题
              {proofreadPendingTotal > 0 && (
                <small className="import-review-proofread-badge">
                  · {proofreadPendingTotal} 处待确认纠错
                </small>
              )}
            </h2>
            <div>
              {!result && hasPreview && questions.length > 0 && !stale && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || saving || proofreading}
                  onClick={() => void runProofread(questions)}
                >
                  <Sparkles size={14} /> AI 纠错核查
                </Button>
              )}
              {undo && !result && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || saving}
                  onClick={() => {
                    setQuestions(undo.questions);
                    setSources(undo.sources);
                    setFiles(undo.files);
                    setFileMode(undo.fileMode);
                    setPreviewSignature(undo.previewSignature);
                    setReplaceKey(undo.replaceKey);
                    setExpandedKey(undo.expandedKey);
                    setUndo(null);
                  }}
                >
                  <RotateCcw size={14} /> 撤销
                </Button>
              )}
              {!result && questions.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || saving}
                  onClick={() => {
                    const nextSelected = !allSelected;
                    if (!nextSelected && replaceKey) setReplaceKey("");
                    setQuestions((items) =>
                      items.map((q) => ({ ...q, selected: nextSelected })),
                    );
                  }}
                >
                  {allSelected ? "取消全选" : "全选"}
                </Button>
              )}
              {hasPreview &&
                !result &&
                questions.length < IMPORT_LIMITS.questions && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || saving || stale}
                    onClick={addQuestion}
                  >
                    <Plus size={15} /> 添加题目
                  </Button>
                )}
              {!result && hasPreview && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="danger-text"
                  disabled={busy || saving}
                  onClick={discardPreview}
                >
                  <Trash2 size={14} /> 清空预览
                </Button>
              )}
            </div>
          </div>
          {stale && (
            <p className="import-notice">
              <span>原文或解析方式已改变，请重新解析后保存。</span>
              <button
                type="button"
                className="text-button danger-text"
                disabled={locked}
                onClick={discardPreview}
              >
                清空未保存内容
              </button>
            </p>
          )}
          {!stale && overBatch && (
            <p className="import-notice">
              选中的题目超过 15 万字符，请减少本次确认的题目。
            </p>
          )}
          {seed?.editQuestion && !!questions.length && !result && (
            <label className="field import-replace-field">
              当前题的处理
              <select
                aria-label="当前题的处理"
                value={replaceKey}
                disabled={busy || saving || stale}
                onChange={(e) => {
                  setReplaceKey(e.target.value);
                  if (e.target.value)
                    change(e.target.value, { selected: true });
                }}
              >
                <option value="">保留当前题，全部新增</option>
                {questions.map((q, i) => (
                  <option key={q.key} value={q.key}>
                    用第 {i + 1} 题更新当前题：{q.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!questions.length && (
            <p className="import-list-empty">
              <span>
                暂无可入库题目：未检测到标题格式或已全部移除，可返回调整原文或切换解析方式。
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => setStep("source")}
              >
                返回原文资料
              </button>
            </p>
          )}
          {sources.map((source) => {
            const items = questions.flatMap((q, index) =>
              q.batchId === source.batchId ? [{ q, index }] : [],
            );
            if (!items.length) return null;
            return (
              <section
                className="import-review-group"
                key={source.batchId}
                aria-label={source.name || undefined}
              >
                {source.name && (
                  <h3>
                    <FileText size={15} aria-hidden="true" />
                    <span>{source.name}</span>
                    <span>{items.length} 道</span>
                    {!result && (
                      <button
                        type="button"
                        className="text-button import-remove-source danger-text"
                        disabled={locked}
                        aria-label={`移除文件 ${source.name}`}
                        onClick={() => removeSource(source.batchId)}
                      >
                        移除此文件
                      </button>
                    )}
                  </h3>
                )}
                {source.warning && (
                  <p className="import-notice">{source.warning}</p>
                )}
                <div className="import-review-list">
                  {items.map(({ q, index }) => (
                    <ImportPreviewCard
                      key={q.key}
                      item={q}
                      index={index}
                      expanded={expandedKey === q.key}
                      replacing={replaceKey === q.key}
                      disabled={locked}
                      onToggle={() =>
                        setExpandedKey(expandedKey === q.key ? null : q.key)
                      }
                      onChange={(patch) => change(q.key, patch)}
                      onMerge={
                        questions[index - 1]?.batchId === q.batchId
                          ? () => merge(index)
                          : undefined
                      }
                      onRemove={() => remove(index)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </section>
      )}
      {error && (
        <p className="form-error import-error" role="alert">
          {error}
        </p>
      )}
      {step === "source" &&
        (method === "ai" || proofreadEnabled) &&
        !data.settings.hasKey && (
        <p className="import-notice">
          先配置自己的 AI 连接。
          <button className="text-button" onClick={onSettings}>
            去配置
          </button>
        </p>
      )}
      <div className="dialog-footer import-footer">
        {result ? (
          <>
            <p className="import-receipt" role="status">
              <Check size={17} />
              <span>
                {result.updated
                  ? `已更新 ${result.updated} 道，新增 ${result.added} 道题`
                  : `已入库 ${result.added} 道题`}
                {result.duplicates
                  ? `，跳过 ${result.duplicates} 道重复内容`
                  : ""}
              </span>
            </p>
            <Button
              onClick={() => {
                close();
                if (toInbox) onInbox();
                else onView(deckId || null);
              }}
            >
              {toInbox ? "去补答案" : "去题库看看"} <ArrowRight size={15} />
            </Button>
          </>
        ) : (
          <>
            {(busy || proofreading) && (
              <span className="import-progress" role="status">
                <Loader2 size={15} className="spin" />
                {proofreading
                  ? `正在 AI 纠错${proofreadProgress && proofreadProgress.total > 1 ? ` ${proofreadProgress.current} / ${proofreadProgress.total}` : ""}`
                  : `正在解析${fileMode && method === "ai" && files.length > 1 && progress > 0 ? ` ${progress} / ${files.length}` : ""}`}
              </span>
            )}
            {busy ? (
              <Button variant="outline" onClick={stop}>
                停止解析
              </Button>
            ) : proofreading ? (
              <Button variant="outline" onClick={abortProofread}>
                停止纠错
              </Button>
            ) : (
              (step === "source" || stale) && (
                <Button
                  variant={step === "source" ? "default" : "outline"}
                  disabled={!canParse || saving || reading}
                  onClick={() => void parse()}
                >
                  {method === "ai" ? (
                    <Sparkles size={15} />
                  ) : (
                    <ListChecks size={15} />
                  )}{" "}
                  {parseLabel}
                </Button>
              )
            )}
            {step === "preview" && (
              <Button
                disabled={
                  !hasPreview ||
                  stale ||
                  !selected.length ||
                  invalid ||
                  busy ||
                  proofreading ||
                  saving
                }
                onClick={() => void commit()}
              >
                {saving ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}
                {replaceKey ? "确认保存" : "确认入库"} {selected.length} 道
              </Button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
