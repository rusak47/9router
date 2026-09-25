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

  it("rejectEmptyStream: reasoning-only stream with pre-content error → rejects with synthesized 503 (silence-based gate)", async () => {
    // Simulates: many reasoning frames (delta.content="", delta.reasoning+reasoning_details present)
    // arriving over > silence window, then a pre-content error frame, then [DONE].
    // Under current elapsed-time gate: 500ms timeout fires open → passThrough → rejected=false (FAIL).
    // Under silence-based gate: each reasoning frame resets silence timer, error caught → rejected=true (PASS).
    const reasoningFrames = Array.from({ length: 8 }, (_, i) =>
      `data: {"id":"gen-${Date.now()}-${i}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"token ${i}","reasoning_details":[{"type":"reasoning.text","text":"token ${i}","format":"unknown","index":0}]},"finish_reason":null}]}\n\n`
    ).join("");
    const errorFrame = 'data: {"error":{"code":503,"message":"The upstream provider timed out","type":"timeout"}}\n\n';
    const doneFrame = "data: [DONE]\n\n";

    let frameIndex = 0;
    const allFrames = [...reasoningFrames.split("\n\n").filter(Boolean), errorFrame, doneFrame];

    const slowReasoningThenError = new Response(
      new ReadableStream({
        async start(controller) {
          for (const frame of allFrames) {
            controller.enqueue(new TextEncoder().encode(frame + "\n\n"));
            // Space frames ~30ms apart; silence window 100ms means timer resets on each frame
            await new Promise(r => setTimeout(r, 30));
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );

    const { response, rejected, message } = await rejectEmptyStream(slowReasoningThenError, { timeoutMs: 100 });
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/empty stream.*upstream error/);
    expect(message).toMatch(/upstream error/);
  });

  it("rejectEmptyStream: non-SSE response with actual JSON content → passes through", async () => {
    const jsonResponse = new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      headers: { "Content-Type": "application/json" },
    });
    const { response, rejected } = await rejectEmptyStream(jsonResponse);
    expect(rejected).toBe(false);
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body.choices?.[0]?.message?.content).toBe("ok");
  });

  it("rejectEmptyStream: non-SSE response (application/json) with no content bytes → rejected 503 empty stream", async () => {
    const emptyJsonResponse = new Response("", {
      headers: { "Content-Type": "application/json" },
    });
    const { response, rejected, message } = await rejectEmptyStream(emptyJsonResponse, { timeoutMs: 100 });
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/empty stream/);
    expect(message).toMatch(/empty stream/);
  });

  it("rejectEmptyStream: non-SSE response (application/json) with keep-alive frames only (:ka) → rejected 503 empty stream", async () => {
    // Simulates upstream sending Content-Type: application/json but body is :ka comments
    const kaFrames = Array.from({ length: 10 }, () => ": ka\n").join("");
    const kaResponse = new Response(kaFrames, {
      headers: { "Content-Type": "application/json" },
    });
    const { response, rejected, message } = await rejectEmptyStream(kaResponse, { timeoutMs: 100 });
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/empty stream/);
    expect(message).toMatch(/empty stream/);
  });

  it("rejectEmptyStream: SSE response with keep-alive frames only (:ka) → rejected 503 empty stream", async () => {
    // SSE with only :ka comments (no data: frames)
    const kaFrames = Array.from({ length: 10 }, () => ": ka\n").join("");
    const sseKaResponse = new Response(kaFrames, {
      headers: { "Content-Type": "text/event-stream" },
    });
    const { response, rejected, message } = await rejectEmptyStream(sseKaResponse, { timeoutMs: 100 });
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/empty stream/);
    expect(message).toMatch(/empty stream/);
  });

  it("handleComboChat: fails over when upstream sends non-SSE :ka keep-alive frames (silent :ka bug, #99)", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { model: "combo", stream: true },
      models: ["broken/model", "healthy/model"],
      comboStrategy: "fallback",
      log: { info() {}, warn() {} },
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model.startsWith("broken")) {
          return new Response(": ka\n: ka\n: ka\n", {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }
        return new Response('{"choices":[{"message":{"content":"ok"}}]}', {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
    });

    expect(calls).toEqual(["broken/model", "healthy/model"]);
    expect(result.ok).toBe(true);
    const body = await result.clone().json();
    expect(body.choices?.[0]?.message?.content).toBe("ok");
  });

  it("rejectEmptyStream: mid-stream transport abort → rejected 503 (fail-closed on read error)", async () => {
    // Simulates mid-stream transport abort where Fetch.onAborted triggers TypeError: terminated.
    // The first frame is a role-only chunk (empty). The stream then errors while the probe
    // is waiting for the next chunk — this is the moment the probeTask catch fires.
    let errorFn;
    const abortStream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
          errorFn = () => controller.error(new TypeError("terminated: operation aborted"));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
    // Fire the abort while the probe is idle waiting for the next chunk.
    setTimeout(errorFn, 10);
    const { response, rejected } = await rejectEmptyStream(abortStream, { timeoutMs: 50 });
    expect(rejected).toBe(true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toMatch(/empty stream/);
    expect(body.error.message).toMatch(/upstream error/);
  });
});