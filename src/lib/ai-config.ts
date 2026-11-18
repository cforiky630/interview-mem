export const AI_PROTOCOL = "openai-compatible";
export const AI_PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "",
    models: [] as readonly string[],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    models: [] as readonly string[],
  },
  {
    id: "custom",
    name: "自定义",
    baseUrl: "",
    model: "",
    models: [] as readonly string[],
  },
] as const;
export const DEFAULT_AI = AI_PRESETS[0];

/** Base URL is the service API root; accept a pasted Chat Completions URL too. */
export function normalizeAiBaseUrl(value: string) {
  if (/[\x00-\x20\x7f]/.test(value.trim()))
    throw new Error("Base URL 不能包含空格或控制字符。");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请填写有效的 Base URL。");
  }
  if (url.protocol !== "https:")
    throw new Error("Base URL 请使用 HTTPS 地址。");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Base URL 不能包含账号、密码、查询参数或片段。");
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

export function aiPresetFor(baseUrl: string) {
  try {
    const normalized = normalizeAiBaseUrl(baseUrl);
    return (
      AI_PRESETS.find(
        (preset) =>
          preset.baseUrl && normalizeAiBaseUrl(preset.baseUrl) === normalized,
      )?.id ?? "custom"
    );
  } catch {
    return "custom";
  }
}

export function sameAiEndpoint(a: string, b: string) {
  try {
    return normalizeAiBaseUrl(a) === normalizeAiBaseUrl(b);
  } catch {
    return false;
  }
}
