"use client";
import { useState } from "react";
import { Check, KeyRound, Loader2, Trash2 } from "lucide-react";
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
  settings,
  mutate,
}: {
  settings: Workspace["settings"];
  mutate: Mutate;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [tested, setTested] = useState(false);
  const presetId = aiPresetFor(baseUrl);
  const preset = AI_PRESETS.find((item) => item.id === presetId)!;
  const canKeepKey =
    settings.hasKey && sameAiEndpoint(baseUrl, settings.baseUrl);
  let validUrl = false;
  try {
    normalizeAiBaseUrl(baseUrl);
    validUrl = true;
  } catch {
    /* Incomplete input while editing. */
  }
  const canConnect = validUrl && !!model.trim() && (!!key.trim() || canKeepKey);
  const changed =
    !!key.trim() ||
    !sameAiEndpoint(baseUrl, settings.baseUrl) ||
    model.trim() !== settings.model;
  function choosePreset(id: string) {
    const value = AI_PRESETS.find((item) => item.id === id);
    if (!value) return;
    setBaseUrl(value.baseUrl);
    setModel(value.model);
    setKey("");
    setTested(false);
  }
  async function submit(action: "saveConnection" | "testConnection") {
    if (!canConnect || busy) return;
    setBusy(action === "saveConnection" ? "save" : "test");
    try {
      const result = await mutate("/api/settings", {
        action,
        baseUrl,
        model,
        ...(key.trim() ? { key: key.trim() } : {}),
      });
      if (!result) {
        setTested(false);
        return;
      }
      if (action === "saveConnection") {
        setBaseUrl(normalizeAiBaseUrl(baseUrl));
        setModel(model.trim());
        setKey("");
      } else {
        setTested(true);
      }
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
              : "Chat Completions"}
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
          placeholder="https://api.example.com/v1"
          disabled={!!busy}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setKey("");
            setTested(false);
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
          placeholder={canKeepKey ? "留空保留已保存的 Key" : "此服务的 API Key"}
          onChange={(event) => {
            setKey(event.target.value);
            setTested(false);
          }}
        />
      </label>
      <label className="field">
        模型
        <input
          aria-label="模型"
          value={model}
          autoComplete="off"
          spellCheck={false}
          list="ai-model-options"
          maxLength={160}
          placeholder="模型 ID"
          disabled={!!busy}
          onChange={(event) => {
            setModel(event.target.value);
            setTested(false);
          }}
        />
        <datalist id="ai-model-options">
          {preset.models.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </label>
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
        {settings.hasKey && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="删除 API Key"
            disabled={!!busy}
            onClick={async () => {
              if (!confirm("删除保存的 API Key？")) return;
              setBusy("delete");
              try {
                const result = await mutate("/api/settings", {
                  action: "deleteKey",
                });
                if (result) {
                  setKey("");
                  setTested(false);
                }
              } finally {
                setBusy(null);
              }
            }}
          >
            <Trash2 size={16} />
          </Button>
        )}
      </div>
      <p className="muted small">
        测试会发送一条短请求，费用计入对应的模型服务账号。
      </p>
    </>
  );
}
