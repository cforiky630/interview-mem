import { z } from "zod";
import { deckIdSchema } from "@/server/resource-ids";
import type { ProviderToolCall } from "@/server/ai";
import type { ChatMessageMeta, ChatToolStep } from "@/lib/types";
import type { ToolQuestionRef } from "@/server/ai-tools";

export const TERMINAL_FINISH_REASONS = new Set([
  "stop",
  "end_turn",
  "eos",
  "tool_calls",
  "function_call",
]);

export const chatScopeParamSchema = z.enum(["question", "deck", "workspace"]);

export const chatBodySchema = z.object({
  scope: chatScopeParamSchema.default("question"),
  questionId: z.string().uuid().optional(),
  deckId: deckIdSchema.optional(),
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4000),
  quote: z.string().max(5000).default(""),
  attempt: z.string().max(12_000).default(""),
});

export type ChatBody = z.infer<typeof chatBodySchema>;

export type StreamChunkHandlers = {
  onReasoning: (text: string) => void;
  onContent: (delta: string) => void;
};

/**
 * Consume an OpenAI-compatible SSE stream, collecting reasoning tokens,
 * content deltas, finish reason, and chunked tool calls in arrival order.
 */
export async function readChatSseStream(
  upstream: Response,
  handlers: StreamChunkHandlers,
): Promise<{
  complete: boolean;
  finishReason: string | undefined;
  toolCalls: ProviderToolCall[];
}> {
  if (!upstream.body) throw new Error("Missing provider stream");
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  let complete = false;
  let finishReason: string | undefined;
  const toolCallMap = new Map<number, ProviderToolCall>();

  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (value) bytes += value.byteLength;
      if (bytes > 2_000_000) {
        throw new Error("Provider output limit");
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      if (done && pending) {
        lines.push(pending);
        pending = "";
      }
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          complete = true;
          break;
        }
        const chunk = JSON.parse(payload);
        if (chunk.error) throw new Error("Provider stream error");
        const choice = chunk.choices?.[0];
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const reasoning =
          typeof choice?.delta?.reasoning_content === "string"
            ? choice.delta.reasoning_content
            : typeof choice?.delta?.reasoning === "string"
              ? choice.delta.reasoning
              : "";
        if (reasoning) handlers.onReasoning(reasoning);
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) {
          handlers.onContent(delta);
        }
        const deltaTools = choice?.delta?.tool_calls;
        if (Array.isArray(deltaTools)) {
          for (const rawTc of deltaTools) {
            if (!rawTc || typeof rawTc !== "object") continue;
            const idx = typeof rawTc.index === "number" ? rawTc.index : 0;
            const existing = toolCallMap.get(idx) ?? {
              id: "",
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (typeof rawTc.id === "string" && rawTc.id) {
              existing.id = rawTc.id;
            }
            if (
              typeof rawTc.function?.name === "string" &&
              rawTc.function.name
            ) {
              existing.function.name += rawTc.function.name;
            }
            if (typeof rawTc.function?.arguments === "string") {
              existing.function.arguments += rawTc.function.arguments;
            }
            toolCallMap.set(idx, existing);
          }
        }
      }
      if (complete || done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const toolCalls = Array.from(toolCallMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc)
    .filter((tc) => tc.function.name);

  return { complete, finishReason, toolCalls };
}

export function buildMessageMeta(
  reasoning: string,
  toolSteps: ChatToolStep[],
  refs: Map<string, ToolQuestionRef>,
): ChatMessageMeta | null {
  if (!reasoning && !toolSteps.length && !refs.size) return null;
  return {
    ...(reasoning ? { reasoning } : {}),
    ...(toolSteps.length ? { toolSteps } : {}),
    ...(refs.size ? { references: Array.from(refs.values()) } : {}),
  };
}

export function sseResponse(
  run: (
    send: (event: string, value: unknown) => void,
    isClosed: () => boolean,
  ) => Promise<void>,
  onCleanup: () => void,
  onAbort: () => void,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, value: unknown) => {
        if (!closed) {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
              ),
            );
          } catch {
            closed = true;
            onAbort();
          }
        }
      };
      try {
        await run(send, () => closed);
      } finally {
        onCleanup();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* disconnected client */
          }
        }
      }
    },
    cancel() {
      onAbort();
      onCleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
