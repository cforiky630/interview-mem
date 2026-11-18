import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { Agent } from "undici";
import {
  AI_PRESETS,
  aiPresetFor,
  normalizeAiBaseUrl,
  sameAiEndpoint,
} from "../src/lib/ai-config";
import {
  isPublicAiAddress,
  resolveAiAddresses,
  pinnedAiLookup,
  aiFetch,
  trustedAiProxyOrigin,
} from "../src/server/ai-transport";
import { providerModels, providerRequest } from "../src/server/ai";

const publicAddress = { address: "93.184.216.34", family: 4 };
test("AI transport: native Node fetch and the pinned dispatcher use a compatible wire interface", async () => {
  const server = createServer((_request, response) =>
    response.end("connected"),
  );
  const dispatcher = new Agent();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      dispatcher,
      signal: AbortSignal.timeout(5000),
    } as RequestInit & { dispatcher: Agent });
    assert.equal(await response.text(), "connected");
  } finally {
    await dispatcher.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test("AI configuration: presets share one protocol, omit preset models and full endpoints normalize", () => {
  assert.equal(AI_PRESETS.length, 3);
  assert.ok(
    AI_PRESETS.every(
      (preset) => preset.model === "" && preset.models.length === 0,
    ),
  );
  assert.equal(aiPresetFor("https://api.deepseek.com/"), "deepseek");
  assert.equal(
    aiPresetFor("https://api.openai.com/v1/chat/completions"),
    "openai",
  );
  assert.equal(
    normalizeAiBaseUrl(
      " https://gateway.example.com/api/v1/chat/completions/ ",
    ),
    "https://gateway.example.com/api/v1",
  );
  assert.ok(
    sameAiEndpoint(
      "https://gateway.example.com/v1/",
      "https://gateway.example.com/v1",
    ),
  );
  assert.ok(
    !sameAiEndpoint(
      "https://gateway.example.com/v1",
      "https://gateway.example.com/v2",
    ),
  );
  for (const value of [
    "http://example.com/v1",
    "file:///etc/passwd",
    "https://user:secret@example.com/v1",
    "https://example.com/v1?key=secret",
    "https://example.com/#x",
    "https://exa\nmple.com/v1",
  ])
    assert.throws(() => normalizeAiBaseUrl(value));
});

test("AI transport: reject local, metadata and reserved IPv4/IPv6 addresses", () => {
  for (const value of [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "192.0.2.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicAiAddress(value), false, value);
  assert.equal(isPublicAiAddress(publicAddress.address), true);
  assert.equal(isPublicAiAddress("2606:4700:4700::1111"), true);
});

test("AI transport: DNS filtering and pinned socket lookup prevent rebinding and mixed private records", async () => {
  const resolver = mock.method(dns, "lookup", async () => [
    publicAddress,
    { address: "127.0.0.1", family: 4 },
  ]);
  try {
    await assert.rejects(
      resolveAiAddresses("gateway.example.com", AbortSignal.timeout(1000)),
      /公网/,
    );
  } finally {
    resolver.mock.restore();
  }
  const publicResolver = mock.method(dns, "lookup", async () => [
    publicAddress,
  ]);
  try {
    const addresses = await resolveAiAddresses(
      "gateway.example.com",
      AbortSignal.timeout(1000),
    );
    const lookup = pinnedAiLookup("gateway.example.com", addresses);
    lookup("gateway.example.com", { all: true }, (error, result) => {
      assert.equal(error, null);
      assert.deepEqual(result, [publicAddress]);
    });
    lookup("other.example.com", {}, (error) => assert.ok(error));
    lookup("gateway.example.com", { family: 6 }, (error) => assert.ok(error));
    assert.equal(publicResolver.mock.callCount(), 1);
  } finally {
    publicResolver.mock.restore();
  }
});

test("AI transport: proxy Fake-IP is scoped to trusted origins and never permits private addresses", async () => {
  const before = process.env.AI_PROXY_TRUSTED_ORIGINS;
  const resolver = mock.method(dns, "lookup", async () => [
    { address: "198.18.0.60", family: 4 },
  ]);
  try {
    assert.equal(
      trustedAiProxyOrigin(
        new URL("https://api.deepseek.com/v1/chat/completions"),
      ),
      true,
    );
    assert.equal(
      trustedAiProxyOrigin(
        new URL("https://arbitrary.example.com/chat/completions"),
      ),
      false,
    );
    await assert.rejects(
      resolveAiAddresses("arbitrary.example.com", AbortSignal.timeout(1000)),
      /公网/,
    );
    assert.equal(
      (
        await resolveAiAddresses(
          "api.deepseek.com",
          AbortSignal.timeout(1000),
          true,
        )
      )[0].address,
      "198.18.0.60",
    );
    process.env.AI_PROXY_TRUSTED_ORIGINS = "https://gateway.example.com";
    assert.equal(
      trustedAiProxyOrigin(
        new URL("https://gateway.example.com/v1/chat/completions"),
      ),
      true,
    );
    assert.equal(
      trustedAiProxyOrigin(
        new URL("https://gateway.example.com:8443/v1/chat/completions"),
      ),
      false,
    );
  } finally {
    resolver.mock.restore();
    if (before === undefined) delete process.env.AI_PROXY_TRUSTED_ORIGINS;
    else process.env.AI_PROXY_TRUSTED_ORIGINS = before;
  }
  const privateResolver = mock.method(dns, "lookup", async () => [
    { address: "10.0.0.1", family: 4 },
  ]);
  try {
    await assert.rejects(
      resolveAiAddresses("api.deepseek.com", AbortSignal.timeout(1000), true),
      /公网/,
    );
  } finally {
    privateResolver.mock.restore();
  }
});

test("AI adapter: custom API paths, streamed calls and OpenAI token parameters share one request path", async () => {
  const resolver = mock.method(dns, "lookup", async () => [publicAddress]);
  const calls: {
    url: string;
    data: Record<string, unknown>;
    init: RequestInit;
  }[] = [];
  const fetcher = mock.method(
    globalThis,
    "fetch",
    async (url: URL | string | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        data: JSON.parse(String(init?.body)),
        init: init!,
      });
      return Response.json({
        choices: [{ message: { role: "assistant", content: "OK" } }],
      });
    },
  );
  try {
    for (const connection of [
      {
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        key: "fake-ds-key",
      },
      {
        baseUrl: "https://gateway.example.com/api/v1/",
        model: "vendor/model",
        key: "fake-gateway-key",
      },
      {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        key: "fake-openai-key",
      },
      {
        baseUrl: "https://gateway.example.com/v1",
        model: "openai/gpt-5",
        key: "fake-reasoning-key",
      },
    ])
      await (
        await providerRequest(
          connection,
          [{ role: "user", content: "test" }],
          true,
        )
      ).json();
    assert.equal(
      calls[1].url,
      "https://gateway.example.com/api/v1/chat/completions",
    );
    assert.equal(calls[0].data.max_tokens, 3000);
    assert.equal(calls[2].data.max_completion_tokens, 3000);
    assert.equal(calls[3].data.max_completion_tokens, 3000);
    assert.ok(
      calls.every(
        (call) => call.data.stream === true && call.init.redirect === "manual",
      ),
    );
    assert.equal(
      (calls[1].init.headers as Record<string, string>).Authorization,
      "Bearer fake-gateway-key",
    );
  } finally {
    fetcher.mock.restore();
    resolver.mock.restore();
  }
});

test("AI adapter: providerModels fetches /models and falls back to /v1/models on 404", async () => {
  const resolver = mock.method(dns, "lookup", async () => [publicAddress]);
  const calls: { url: string; method?: string; auth?: string }[] = [];
  const fetcher = mock.method(
    globalThis,
    "fetch",
    async (url: URL | string | Request, init?: RequestInit) => {
      const urlStr = String(url);
      calls.push({
        url: urlStr,
        method: init?.method,
        auth: (init?.headers as Record<string, string>)?.Authorization,
      });
      if (urlStr === "https://gateway.example.com/models") {
        return new Response("Not Found", { status: 404 });
      }
      if (urlStr === "https://gateway.example.com/v1/models") {
        return Response.json({
          data: [
            { id: "model-a" },
            { id: "model-b" },
            { id: "model-a" },
          ],
        });
      }
      return Response.json({
        data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
      });
    },
  );
  try {
    const direct = await providerModels({
      baseUrl: "https://api.deepseek.com",
      key: "fake-ds-key",
    });
    assert.deepEqual(direct, ["deepseek-chat", "deepseek-reasoner"]);

    const fallback = await providerModels({
      baseUrl: "https://gateway.example.com",
      key: "fake-gw-key",
    });
    assert.deepEqual(fallback, ["model-a", "model-b"]);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].auth, "Bearer fake-ds-key");
    assert.equal(calls[1].url, "https://gateway.example.com/models");
    assert.equal(calls[2].url, "https://gateway.example.com/v1/models");
  } finally {
    fetcher.mock.restore();
    resolver.mock.restore();
  }
});

test("AI transport: do not follow redirects or accept oversized provider bodies", async () => {
  const resolver = mock.method(dns, "lookup", async () => [publicAddress]);
  const redirect = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      }),
  );
  try {
    await assert.rejects(
      aiFetch(new URL("https://gateway.example.com/chat/completions"), {}),
      /重定向/,
    );
    assert.equal(redirect.mock.callCount(), 1);
  } finally {
    redirect.mock.restore();
  }
  const huge = mock.method(
    globalThis,
    "fetch",
    async () => new Response(new Uint8Array(2_000_001)),
  );
  try {
    const response = await aiFetch(
      new URL("https://gateway.example.com/chat/completions"),
      {},
    );
    await assert.rejects(response.text(), /过大/);
  } finally {
    huge.mock.restore();
    resolver.mock.restore();
  }
});
