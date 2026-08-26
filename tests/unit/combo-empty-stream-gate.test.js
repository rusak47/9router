import { describe, it, expect } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";
import { rejectEmptyStream } from "open-sse/services/combo.js";

function sse(text) {
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

async function firstSseData(response) {
  const text = await response.text();
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:") && l.slice(5).trim() !== "[DONE]");
  const line = lines[lines.length - 1];
  return JSON.parse(line.slice(5));
}

describe("combo empty-stream gate (Mechanism B, #3463)", () => {
  it("fails over to next model after fast empty SSE (only [DONE])", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { model: "combo", stream: true },
      models: ["first/model", "second/model"],
      comboStrategy: "fallback",
      log: { info() {}, warn() {} },
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return model.startsWith("first")
          ? sse("data: [DONE]\n\n")
          : sse("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
      },
    });

    expect(calls).toEqual(["first/model", "second/model"]);
    expect(result.ok).toBe(true);
    const body = await firstSseData(result);
    expect(body.choices?.[0]?.delta?.content).toBe("ok");
  });

  it("fails over on poisoned terminal frame with network_error", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { model: "combo", stream: true },
      models: ["poisoned/model", "healthy/model"],
      comboStrategy: "fallback",
      log: { info() {}, warn() {} },
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model.startsWith("poisoned")) {
          return sse(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n" +
            "data: {\"choices\":[{\"finish_reason\":\"network_error\",\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n" +
            "data: [DONE]\n\n"
          );
        }
        return sse("data: {\"choices\":[{\"delta\":{\"content\":\"survived\"}}]}\n\ndata: [DONE]\n\n");
      },
    });

    expect(calls).toEqual(["poisoned/model", "healthy/model"]);
    expect(result.ok).toBe(true);
    const body = await firstSseData(result);
    expect(body.choices?.[0]?.delta?.content).toBe("survived");
  });

  it("passes through reasoning-only stream (no false failover)", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { model: "combo", stream: true },
      models: ["reasoning/model", "should/not/be/called"],
      comboStrategy: "fallback",
      log: { info() {}, warn() {} },
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return sse(
          "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n" +
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking...\"}}]}\n\n" +
          "data: [DONE]\n\n"
        );
      },
    });

    expect(calls).toEqual(["reasoning/model"]);
    expect(result.ok).toBe(true);
    const body = await firstSseData(result);
    expect(body.choices?.[0]?.delta?.reasoning_content).toBe("thinking...");
  });

  it("fails over on upstream error frame inside probe window", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { model: "combo", stream: true },
      models: ["error/model", "healthy/model"],
      comboStrategy: "fallback",
      log: { info() {}, warn() {} },
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model.startsWith("error")) {
          return sse("data: {\"error\":{\"message\":\"billing block\"}}\n\n" + "data: [DONE]\n\n");
        }
        return sse("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n");
      },
    });

    expect(calls).toEqual(["error/model", "healthy/model"]);
    expect(result.ok).toBe(true);
    const body = await firstSseData(result);
    expect(body.choices?.[0]?.delta?.content).toBe("ok");
  });

  it("rejectEmptyStream: fast-empty returns synthetic 503 with 'empty stream'", async () => {
    const emptyResponse = sse("data: [DONE]\n\n");
    const { response, rejected, message } = await rejectEmptyStream(emptyResponse);
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/empty stream/);
    expect(message).toMatch(/empty stream/);
  });

  it("rejectEmptyStream: poisoning terminal frame returns synthetic 503 with finish_reason", async () => {
    const poisonResponse = sse(
      "data: {\"choices\":[{\"finish_reason\":\"network_error\",\"delta\":{\"role\":\"assistant\"}}]}\n\n" +
      "data: [DONE]\n\n"
    );
    const { response, rejected, message } = await rejectEmptyStream(poisonResponse);
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/network_error/);
    expect(message).toMatch(/network_error/);
  });

  it("rejectEmptyStream: reasoning content → passes through (not rejected)", async () => {
    const reasoningResponse = sse(
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n" +
      "data: [DONE]\n\n"
    );
    const { response, rejected } = await rejectEmptyStream(reasoningResponse);
    expect(rejected).toBe(false);
    expect(response.ok).toBe(true);
    // Client branch should still flow
    const text = await response.text();
    expect(text).toContain("reasoning_content");
  });

  it("rejectEmptyStream: error frame → 503 with upstream error text", async () => {
    const errorResponse = sse("data: {\"error\":{\"message\":\"service overloaded\"}}\n\n" + "data: [DONE]\n\n");
    const { response, rejected, message } = await rejectEmptyStream(errorResponse);
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/service overloaded/);
    expect(message).toMatch(/upstream error/);
  });

  it("rejectEmptyStream: error frame with empty choices[] + top-level error object → 503 with upstream error text", async () => {
    const errorResponse = new Response(
      'data: {"choices":[],"error":{"code":429,"message":"Provider returned error","metadata":{"error_type":"rate_limit_exceeded"}}}\n\n' +
      "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } }
    );
    const { response, rejected, message } = await rejectEmptyStream(errorResponse);
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/Provider returned error/);
    expect(message).toMatch(/upstream error/);
  });

  it("rejectEmptyStream: timeout → fail open, bytes still flow through", async () => {
    // Stream silent past the 50ms window, then closes with only a [DONE] frame
    const slowClose = new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          }, 150);
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
    const { response, rejected } = await rejectEmptyStream(slowClose, { timeoutMs: 50 });
    expect(rejected).toBe(false);
    const text = await response.text();
    expect(text).toContain("[DONE]");
  });

  it("rejectEmptyStream: healthy stream with delayed first token passes through", async () => {
    let resolveFirstChunk;
    const delayedResponse = new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n"));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          }, 100); // After default 500ms window — but fail-open means it passes
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
    const { response, rejected } = await rejectEmptyStream(delayedResponse);
    expect(rejected).toBe(false);
    // Original response returned (fail-open at timeout)
    const text = await response.text();
    expect(text).toContain("content");
  });

  it("rejectEmptyStream: non-SSE response passed through untouched", async () => {
    const jsonResponse = new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      headers: { "Content-Type": "application/json" },
    });
    const { response, rejected } = await rejectEmptyStream(jsonResponse);
    expect(rejected).toBe(false);
    expect(response).toBe(jsonResponse);
  });
});