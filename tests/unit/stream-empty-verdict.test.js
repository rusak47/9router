import { describe, it, expect } from "vitest";
import { createSSEStream } from "open-sse/utils/stream.js";
import { FORMATS } from "open-sse/translator/formats.js";

// Poisoned frame captured 2026-08-24 (x-preview-f-free via OpenRouter free tier)
const POISONED_TERMINAL_FRAME =
  "data: {\"id\":\"2026082422204921e5840ee3ed4778\",\"created\":1787581256,\"model\":\"x-preview-f-free\"," +
  "\"choices\":[{\"index\":0,\"finish_reason\":\"network_error\",\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]," +
  "\"object\":\"chat.completion.chunk\"," +
  "\"usage\":{\"prompt_tokens\":75172,\"completion_tokens\":0,\"total_tokens\":75172,\"estimated\":true}}\n\n";

const ROLE_FRAME = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n";
const CONTENT_FRAME = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hello world\"}}]}\n\n";

async function runPassthrough(chunks) {
  let verdict = null;
  let completedContent = null;
  const stream = createSSEStream({
    mode: "passthrough",
    provider: "openai",
    model: "test-model",
    body: {},
    onStreamComplete: (contentObj, usage, ttftAt, v) => {
      verdict = v;
      completedContent = contentObj;
    },
  });
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  // Start draining reader BEFORE writing to avoid backpressure deadlock
  const reader = stream.readable.getReader();
  const drainPromise = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();
  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  await drainPromise;
  return { verdict, completedContent };
}

describe("empty-stream flush verdict (Mechanism A)", () => {
  it("poisoned terminal frame with network_error and zero content → poisoned", async () => {
    const { verdict } = await runPassthrough([ROLE_FRAME, POISONED_TERMINAL_FRAME]);
    expect(verdict?.poisoned).toBe(true);
    expect(verdict?.finishReason).toBe("network_error");
  });

  it("healthy stream with content → not poisoned", async () => {
    const { verdict } = await runPassthrough([ROLE_FRAME, CONTENT_FRAME,
      "data: {\"choices\":[{\"finish_reason\":\"stop\",\"delta\":{}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\n",
      "data: [DONE]\n\n"]);
    expect(verdict?.poisoned ?? false).toBe(false);
  });

  it("reasoning-only stream then network_error → NOT poisoned (P3 guard)", async () => {
    const { verdict } = await runPassthrough([
      ROLE_FRAME,
      "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"thinking...\"}}]}\n\n",
      POISONED_TERMINAL_FRAME,
      "data: [DONE]\n\n",
    ]);
    expect(verdict?.poisoned ?? false).toBe(false);
  });

  it("tool-call-only stream then network_error → NOT poisoned (P4 guard)", async () => {
    const { verdict } = await runPassthrough([
      ROLE_FRAME,
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"f\",\"arguments\":\"{}\"}}]}}]}\n\n",
      POISONED_TERMINAL_FRAME,
      "data: [DONE]\n\n",
    ]);
    expect(verdict?.poisoned ?? false).toBe(false);
  });

  it("finish_reason=length with zero tokens → NOT poisoned (legit truncation)", async () => {
    const { verdict } = await runPassthrough([
      ROLE_FRAME,
      "data: {\"choices\":[{\"finish_reason\":\"length\",\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]);
    expect(verdict?.poisoned ?? false).toBe(false);
  });

  it("finish_reason=content_filter with zero tokens → NOT poisoned (legit policy block)", async () => {
    const { verdict } = await runPassthrough([
      ROLE_FRAME,
      "data: {\"choices\":[{\"finish_reason\":\"content_filter\",\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
      "data: [DONE]\n\n",
    ]);
    expect(verdict?.poisoned ?? false).toBe(false);
  });

  it("S2 clean-close without any terminal frame and zero output → poisoned", async () => {
    const { verdict } = await runPassthrough([ROLE_FRAME, "data: [DONE]\n\n"]);
    expect(verdict?.poisoned).toBe(true);
    expect(verdict?.finishReason).toBe(null);
  });

  it("keepalive/comment-only stream ending in [DONE] → poisoned (S2)", async () => {
    const { verdict } = await runPassthrough([": keepalive\n\n", "data: [DONE]\n\n"]);
    expect(verdict?.poisoned).toBe(true);
  });
});

async function runTranslate(chunks, targetFormat, sourceFormat) {
  let verdict = null;
  const stream = createSSEStream({
    mode: "translate",
    targetFormat,
    sourceFormat,
    provider: "test",
    model: "test-model",
    body: {},
    onStreamComplete: (_contentObj, _usage, _ttftAt, v) => {
      verdict = v;
    },
  });
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const reader = stream.readable.getReader();
  const drainPromise = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();
  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  await drainPromise;
  return { verdict };
}

describe("empty-stream flush verdict — translate mode", () => {
  it("OpenAI upstream → Claude client: poisoned network_error → verdict.poisoned true", async () => {
    // openai-to-claude translator stores raw finish_reason in state.finishReason
    const { verdict } = await runTranslate(
      [
        ROLE_FRAME,
        POISONED_TERMINAL_FRAME,
        "data: [DONE]\n\n",
      ],
      FORMATS.OPENAI,   // targetFormat = upstream format (provider speaks OpenAI)
      FORMATS.CLAUDE    // sourceFormat = client speaks Claude
    );
    expect(verdict?.poisoned).toBe(true);
    expect(verdict?.finishReason).toBe("network_error");
  });
});
