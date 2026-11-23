"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import type { Workspace } from "@/lib/types";
import {
  AI_PRESETS,
  aiPresetFor,
  normalizeAiBaseUrl,
  sameAiEndpoint,
} from "@/lib/ai-config";
import { Button } from "./ui/button";
import type { Mutate } from "./dialogs";

export function AiConnectionForm({
  userId,
  settings,
  mutate,
}: {
  userId: string;
  settings: Workspace["settings"];
  mutate: Mutate;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelFeedback, setModelFeedback] = useState<{
    type: "ok" | "error";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tested, setTested] = useState(false);
  const [manualModelInput, setManualModelInput] = useState(false);
  const modelRequest = useRef<AbortController | null>(null);
  const presetId = aiPresetFor(baseUrl);
  const canKeepKey =
    settings.hasKey && sameAiEndpoint(baseUrl, settings.baseUrl);
  let validUrl = false;
  try {
    normalizeAiBaseUrl(baseUrl);
    validUrl = true;
  } catch {
    /* Incomplete input while editing. */
  }
  const canFetchModels = validUrl && (!!key.trim() || canKeepKey);
  const canConnect = canFetchModels && !!model.trim();
  const modelOptions = Array.from(
    new Set([...(model.trim() ? [model.trim()] : []), ...models]),
  );
  const showManualInput =
    manualModelInput || (modelOptions.length === 0 && !loadingModels);
  const changed =
    !!key.trim() ||
    !sameAiEndpoint(baseUrl, settings.baseUrl) ||
    model.trim() !== settings.model;

  const cancelModelRequest = useCallback(() => {
    modelRequest.current?.abort();
    modelRequest.current = null;
    setLoadingModels(false);
  }, []);

  const fetchModels = useCallback(
    async (silent = false) => {
      if (!canFetchModels) return;
      modelRequest.current?.abort();
      const controller = new AbortController();
      modelRequest.current = controller;
      let timedOut = false;
      const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15_000);
      setLoadingModels(true);
      if (!silent) setModelFeedback(null);
      try {
        const result = await api<{ ok: boolean; models?: string[] }>(
          "/api/settings",
          {
            action: "listModels",
            baseUrl,
            ...(key.trim() ? { key: key.trim() } : {}),
          },
          { userId, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const list = Array.isArray(result.models) ? result.models : [];
        setModels(list);
        if (list.length > 0) {
          setModel((current) => (current.trim() ? current : list[0]));
        }
        if (!silent) {
          setModelFeedback(
            list.length
              ? { type: "ok", text: `已获取 ${list.length} 个可用模型` }
              : { type: "error", text: "接口未返回模型列表，请检查接口配置。" },
          );
        }
      } catch (error) {
        if (controller.signal.aborted && !timedOut) return;
        if (!silent || timedOut) {
          setModelFeedback({
            type: "error",
            text: timedOut
              ? "获取模型列表超时，请检查接口地址或网络。"
              : error instanceof Error
                ? error.message
                : "获取模型列表失败。",
          });
        }
      } finally {
        window.clearTimeout(timer);
        if (modelRequest.current === controller) {
          modelRequest.current = null;
          setLoadingModels(false);
        }
      }
    },
    [baseUrl, canFetchModels, key, userId],
  );

  useEffect(() => {
    if (settings.hasKey) {
      void fetchModels(true);
    }
    return () => {
      cancelModelRequest();
    };
  }, []);

  function choosePreset(id: string) {
    const value = AI_PRESETS.find((item) => item.id === id);
    if (!value) return;
    cancelModelRequest();
    setBaseUrl(value.baseUrl);
    setModel("");
    setModels([]);
    setKey("");
    setTested(false);
    setModelFeedback(null);
  }

  async function submit(action: "saveConnection" | "testConnection") {
    if (!canConnect || busy) return;
    setBusy(action === "saveConnection" ? "save" : "test");
    try {
      const payload = {
        action,
        baseUrl,
        model,
        ...(key.trim() ? { key: key.trim() } : {}),
      };
      if (action === "testConnection") {
        await api("/api/settings", payload, { userId });
        setTested(true);
        toast.success("模型连接测试通过。");
        return;
      }
      const result = await mutate("/api/settings", payload);
      if (!result) {
        setTested(false);
        return;
      }
      setBaseUrl(normalizeAiBaseUrl(baseUrl));
      setModel(model.trim());
      setKey("");
      toast.success("模型连接配置已保存。");
    } catch (error) {
      setTested(false);
      toast.error(
        error instanceof Error ? error.message : "请求未完成，请稍后重试。",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="key-status">
        <span
          className={`key-status-icon ${settings.hasKey ? "connected" : ""}`}
        >
          <KeyRound size={21} />
        </span>
        <div>
          <strong>OpenAI 兼容</strong>
          <p>
            {settings.hasKey
              ? `已保存 · •••• ${settings.keyHint}`
              : "支持兼容 Chat Completions 与 /models 的服务"}
          </p>
        </div>
      </div>
      <label className="field">
        预设
        <select
          aria-label="服务预设"
          value={presetId}
          disabled={!!busy}
          onChange={(event) => choosePreset(event.target.value)}
        >
          {AI_PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Base URL
        <input
          aria-label="Base URL"
          type="url"
          value={baseUrl}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          maxLength={2048}
          placeholder="例如 https://api.deepseek.com 或 https://api.openai.com/v1"
          disabled={!!busy}
          onChange={(event) => {
            cancelModelRequest();
            setBaseUrl(event.target.value);
            setKey("");
            setModels([]);
            setTested(false);
            setModelFeedback(null);
          }}
        />
      </label>
      <label className="field">
        API Key
        <input
          aria-label="API Key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          maxLength={4096}
          disabled={!!busy}
          placeholder={
            canKeepKey ? "留空则继续沿用已保存的 Key" : "输入对应服务的 API Key"
          }
          onChange={(event) => {
            setKey(event.target.value);
            setTested(false);
            setModelFeedback(null);
          }}
        />
      </label>
      <div className="field">
        <div className="ai-model-label-row">
          <label htmlFor="ai-model-select">模型</label>
          <div className="ai-model-actions">
            {modelOptions.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!!busy || loadingModels}
                onClick={() => setManualModelInput((v) => !v)}
              >
                {manualModelInput ? "列表选择" : "手动输入"}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canFetchModels || loadingModels || !!busy}
              onClick={() => void fetchModels(false)}
            >
              {loadingModels ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              {loadingModels ? "获取中…" : "获取模型"}
            </Button>
          </div>
        </div>
        {showManualInput ? (
          <input
            id="ai-model-select"
            type="text"
            aria-label="模型"
            value={model}
            maxLength={160}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            disabled={!!busy}
            placeholder="例如 deepseek-chat、deepseek-reasoner 或 gpt-4.1-mini"
            onChange={(event) => {
              setModel(event.target.value);
              setTested(false);
            }}
          />
        ) : (
          <select
            id="ai-model-select"
            aria-label="模型"
            value={model}
            disabled={!!busy || loadingModels || modelOptions.length === 0}
            onChange={(event) => {
              setModel(event.target.value);
              setTested(false);
            }}
          >
            <option
              value=""
              disabled
              hidden={modelOptions.length > 0 && !!model}
            >
              {loadingModels
                ? "正在获取模型列表…"
                : `请选择模型（共 ${modelOptions.length} 个）`}
            </option>
            {modelOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        )}
        {modelFeedback ? (
          <small
            className={
              modelFeedback.type === "error" ? "form-error-inline" : "muted"
            }
            role={modelFeedback.type === "error" ? "alert" : "status"}
          >
            {modelFeedback.text}
          </small>
        ) : (
          <small className="muted">
            {showManualInput
              ? "可直接输入任意模型 ID，或点击「获取模型」从接口拉取列表。"
              : "填好地址与 Key 后点击「获取模型」可从 /models 拉取可用列表。"}
          </small>
        )}
      </div>
      <div className="settings-key-actions">
        <Button
          disabled={!!busy || !canConnect || !changed}
          onClick={() => void submit("saveConnection")}
        >
          {busy === "save" ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}{" "}
          保存连接
        </Button>
        <Button
          variant="outline"
          disabled={!!busy || !canConnect}
          onClick={() => void submit("testConnection")}
        >
          {busy === "test" && <Loader2 size={15} className="spin" />}
          {tested ? "连接正常" : "测试连接"}
        </Button>
        {settings.hasKey &&
          (confirmDelete ? (
            <div className="ai-delete-confirm" role="group" aria-label="确认删除 API Key">
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={!!busy}
                onClick={async () => {
                  setBusy("delete");
                  try {
                    const result = await mutate("/api/settings", {
                      action: "deleteKey",
                    });
                    if (result) {
                      setKey("");
                      setModel("");
                      setModels([]);
                      setManualModelInput(false);
                      setTested(false);
                      setModelFeedback(null);
                      setConfirmDelete(false);
                    }
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "delete" && <Loader2 size={14} className="spin" />}
                删除
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!!busy}
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label="删除 API Key"
              disabled={!!busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={16} />
            </Button>
          ))}
      </div>
      <p className="muted small">
        Key 仅加密保存在服务端；「测试连接」会发送极短探测请求以验证可用性。
      </p>
    </>
  );
}
