import dns from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import ipaddr from "ipaddr.js";
import { AppError } from "./errors";
import { AI_PRESETS } from "@/lib/ai-config";

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_AI_AGENTS = 64;
const AI_DNS_TTL_MS = 45_000;

type DnsRecord = { address: string; family: number };
type DnsCacheEntry = { records: DnsRecord[]; expiresAt: number };
type AgentCacheEntry = { agent: Agent; expiresAt: number };

const transportState = globalThis as unknown as {
  interviewAiDnsCache?: Map<string, DnsCacheEntry>;
  interviewAiAgentCache?: Map<string, AgentCacheEntry>;
};

export function clearAiTransportCaches() {
  transportState.interviewAiDnsCache?.clear();
  if (transportState.interviewAiAgentCache) {
    for (const entry of transportState.interviewAiAgentCache.values()) {
      void entry.agent.destroy().catch(() => {});
    }
    transportState.interviewAiAgentCache.clear();
  }
}

export function isPublicAiAddress(address: string) {
  try {
    const parsed = ipaddr.process(address);
    if (
      parsed.kind() === "ipv6" &&
      parsed.match(ipaddr.parseCIDR("::/96"))
    ) {
      return false;
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
function isProxyAiAddress(address: string) {
  try {
    const parsed = ipaddr.process(address);
    return (
      parsed.kind() === "ipv4" &&
      parsed.match(ipaddr.parseCIDR("198.18.0.0/15"))
    );
  } catch {
    return false;
  }
}
export function trustedAiProxyOrigin(url: URL) {
  const origins: string[] = AI_PRESETS.filter((preset) => preset.baseUrl).map(
    (preset) => new URL(preset.baseUrl).origin,
  );
  for (const value of (process.env.AI_PROXY_TRUSTED_ORIGINS ?? "").split(",")) {
    try {
      const parsed = new URL(value.trim());
      if (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash &&
        parsed.pathname === "/"
      )
        origins.push(parsed.origin);
    } catch {
      /* Ignore malformed operator configuration. */
    }
  }
  return origins.includes(url.origin);
}
function hostnameValue(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}
export function assertAiHostname(hostname: string) {
  const host = hostnameValue(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (isIP(host) && !isPublicAiAddress(host))
  ) {
    throw new AppError(
      400,
      "模型服务地址需要指向公网 HTTPS 接口。",
      "INVALID_AI_HOST",
    );
  }
}

export async function resolveAiAddresses(
  hostname: string,
  signal: AbortSignal,
  trustProxy = false,
) {
  const host = hostnameValue(hostname);
  assertAiHostname(host);
  signal.throwIfAborted();
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  let abort: (() => void) | undefined;
  try {
    const addresses = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    if (
      !addresses.length ||
      addresses.some(
        (record) =>
          !isPublicAiAddress(record.address) &&
          !(trustProxy && isProxyAiAddress(record.address)),
      )
    )
      throw new AppError(
        400,
        "模型服务地址需要指向公网 HTTPS 接口。",
        "INVALID_AI_HOST",
      );
    return addresses;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Supply only the checked DNS results to the actual socket; preserve TLS hostname verification. */
export function pinnedAiLookup(
  hostname: string,
  addresses: { address: string; family: number }[],
): LookupFunction {
  const expected = hostnameValue(hostname);
  return (host, options, callback) => {
    if (hostnameValue(host) !== expected || !addresses.length) {
      callback(new Error("Unexpected AI connection hostname"), "");
      return;
    }
    const records = options.family
      ? addresses.filter((record) => record.family === options.family)
      : addresses;
    if (!records.length) {
      callback(new Error("No matching AI address family"), "");
      return;
    }
    if (options.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  };
}

async function resolveAiAddressesCached(
  hostname: string,
  signal: AbortSignal,
  trustProxy: boolean,
) {
  const host = hostnameValue(hostname);
  if (process.env.NODE_ENV === "test") {
    return resolveAiAddresses(host, signal, trustProxy);
  }
  transportState.interviewAiDnsCache ??= new Map();
  const cacheKey = `${host}|${trustProxy ? "1" : "0"}`;
  const now = Date.now();
  const cached = transportState.interviewAiDnsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.records;
  }
  const records = await resolveAiAddresses(host, signal, trustProxy);
  if (transportState.interviewAiDnsCache.size >= MAX_AI_AGENTS * 2) {
    const oldest = transportState.interviewAiDnsCache.keys().next().value;
    if (oldest) transportState.interviewAiDnsCache.delete(oldest);
  }
  transportState.interviewAiDnsCache.set(cacheKey, {
    records,
    expiresAt: now + AI_DNS_TTL_MS,
  });
  return records;
}

function getPooledAgent(
  origin: string,
  hostname: string,
  addresses: DnsRecord[],
): { key: string; agent: Agent } {
  transportState.interviewAiAgentCache ??= new Map();
  const addrSig = addresses
    .map((r) => `${r.family}:${r.address}`)
    .sort()
    .join(",");
  const key = `${origin}|${addrSig}`;
  const now = Date.now();
  const existing = transportState.interviewAiAgentCache.get(key);
  if (existing && existing.expiresAt > now) {
    // Refresh LRU order
    transportState.interviewAiAgentCache.delete(key);
    transportState.interviewAiAgentCache.set(key, existing);
    return { key, agent: existing.agent };
  }
  if (existing) {
    transportState.interviewAiAgentCache.delete(key);
    void existing.agent.destroy().catch(() => {});
  }
  while (transportState.interviewAiAgentCache.size >= MAX_AI_AGENTS) {
    const oldestKey = transportState.interviewAiAgentCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = transportState.interviewAiAgentCache.get(oldestKey);
    transportState.interviewAiAgentCache.delete(oldestKey);
    if (oldest) void oldest.agent.destroy().catch(() => {});
  }
  const agent = new Agent({
    connect: {
      lookup: pinnedAiLookup(hostname, addresses),
      timeout: 10_000,
    },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    headersTimeout: 120_000,
    bodyTimeout: 120_000,
  });
  transportState.interviewAiAgentCache.set(key, {
    agent,
    expiresAt: now + AI_DNS_TTL_MS,
  });
  return { key, agent };
}

function evictPooledAgent(key: string, host: string) {
  const entry = transportState.interviewAiAgentCache?.get(key);
  if (entry) {
    transportState.interviewAiAgentCache?.delete(key);
    void entry.agent.destroy().catch(() => {});
  }
  transportState.interviewAiDnsCache?.delete(`${host}|0`);
  transportState.interviewAiDnsCache?.delete(`${host}|1`);
}

/** Bounded per-origin pinned dispatcher pool: preserves SSRF/DNS-rebinding guarantees while reusing TLS sessions. */
export async function aiFetch(url: URL, init: RequestInit) {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError(400, "模型服务需要有效的 HTTPS 接口地址。");
  const signal = init.signal ?? AbortSignal.timeout(120_000);
  const trustProxy = trustedAiProxyOrigin(url);
  const addresses = await resolveAiAddressesCached(
    url.hostname,
    AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    trustProxy,
  );
  const host = hostnameValue(url.hostname);
  const { key: agentKey, agent: dispatcher } = getPooledAgent(
    url.origin,
    url.hostname,
    addresses,
  );
  try {
    const response = await fetch(url, {
      ...init,
      signal,
      redirect: "manual",
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AppError(
        400,
        "接口地址发生重定向，请填写最终的 API 地址。",
        "AI_REDIRECT",
      );
    }
    if (!response.body) {
      return response;
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new AppError(502, "模型服务返回的内容过大。");
          }
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    evictPooledAgent(agentKey, host);
    throw error;
  }
}
