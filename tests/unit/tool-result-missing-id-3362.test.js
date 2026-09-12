// #3362 — Claude tool-result requests "messages.N.content.0.tool_result.tool_use_id: tool_use_id: Field required"

import { describe, it, expect } from "vitest";
import {
  ensureToolCallIds,
  fixMissingToolResponses,
  getToolCallIds,
  generateToolCallId,
} from "../../open-sse/translator/concerns/toolCall.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function assistantCall(...ids) {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "tool_use", name: "read_it", id, input: {} })),
    tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "read_it", arguments: "{}" } })),
  };
}

describe("tool-result missing id (#3362)", () => {
  it("reporter shape, assistant tool_call to role:tool with no id resolves right id", () => {
    const body = {
      messages: [
        { role: "user", content: "read it" },
        assistantCall("call_abc123"),
        { role: "tool", content: "file contents" },
      ],
    };

    ensureToolCallIds(body);

    expect(body.messages[2].tool_call_id).toBe("call_abc123");
  });

  it("pairs parallel results in order", () => {
    const body = {
      messages: [
        assistantCall("call_one", "call_two"),
        { role: "tool", content: "first" },
        { role: "tool", content: "second" },
      ],
    };

    ensureToolCallIds(body);

    expect(body.messages.slice(1).map((m) => m.tool_call_id)).toEqual(["call_one", "call_two"]);
  });

  // An id already claimed by explicit result must not be handed out again,
  // whichever order results arrive in.
  it("does not hand same id two results (in order)", () => {
    const inOrder = {
      messages: [
        assistantCall("call_one", "call_two"),
        { role: "tool", tool_call_id: "call_one", content: "first" },
        { role: "tool", content: "second, id dropped" },
      ],
    };

    ensureToolCallIds(inOrder);

    expect(inOrder.messages.slice(1).map((m) => m.tool_call_id)).toEqual(["call_one", "call_two"]);
  });

  it("does not hand same id two results (out of order)", () => {
    const outOfOrder = {
      messages: [
        assistantCall("call_one", "call_two"),
        { role: "tool", tool_call_id: "call_two", content: "second arrived first" },
        { role: "tool", content: "the other one" },
      ],
    };

    ensureToolCallIds(outOfOrder);

    expect(outOfOrder.messages.slice(1).map((m) => m.tool_call_id)).toEqual(["call_two", "call_one"]);
  });

  it("repairs Claude shape too (tool_result block in user content)", () => {
    const body = {
      messages: [
        { role: "user", content: "read it" },
        assistantCall("call_xyz"),
        { role: "user", content: "wait" },
        { role: "user", content: [{ type: "tool_result", content: "done" }] },
      ],
    };

    ensureToolCallIds(body);

    expect(body.messages[3].content[0].tool_use_id).toBe("call_xyz");
  });

  it("preserves explicit good id unchanged", () => {
    const body = {
      messages: [
        assistantCall("call:abc/1"),
        { role: "tool", tool_call_id: "call_abc", content: "real" },
      ],
    };

    ensureToolCallIds(body);

    expect(body.messages[0].tool_calls[0].id).toMatch(TOOL_ID_PATTERN);
    expect(body.messages[1].tool_call_id).toBe("call_abc");
  });

  it("malformed explicit id still sanitized still matches its call", () => {
    const body = {
      messages: [
        assistantCall("call:abc/1"),
        { role: "tool", tool_call_id: "call:abc/1", content: "real" },
      ],
    };

    ensureToolCallIds(body);

    const id = body.messages[0].tool_calls[0].id;
    expect(id).toMatch(TOOL_ID_PATTERN);
    expect(body.messages[1].tool_call_id).toBe(id);
  });

  // Nothing to pair still not reason emit an absent field: a
  // well-formed id keeps request shape valid instead of guaranteeing a 400.
  it("never leaves id empty when there no open call", () => {
    const body = { messages: [{ role: "tool", content: "orphan" }] };

    ensureToolCallIds(body);

    expect(body.messages[0].tool_call_id).toBeTruthy();
    expect(body.messages[0].tool_call_id).toMatch(TOOL_ID_PATTERN);
  });

  it("does not reuse ids across assistant turns", () => {
    const body = {
      messages: [
        assistantCall("call_first"),
        { role: "tool", tool_call_id: "call_first", content: "a" },
        assistantCall("call_second"),
        { role: "tool", content: "b" },
      ],
    };

    ensureToolCallIds(body);

    expect(body.messages[3].tool_call_id).toBe("call_second");
  });

  // hasToolResults() matches on id, so before repair result no
  // id looked absent fixMissingToolResponses spliced in an empty duplicate
  it("stops duplicate empty result inserted after it", () => {
    const body = {
      messages: [assistantCall("call_abc"), { role: "tool", content: "real output" }],
    };

    fixMissingToolResponses(ensureToolCallIds(body));

    const results = body.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("real output");
  });

  it("reaches Anthropic tool_use_id, end to end", () => {
    const body = {
      messages: [
        { role: "user", content: "read it" },
        assistantCall("call_abc123"),
        { role: "tool", content: "file contents" },
      ],
    };

    // Run through ensureToolCallIds first (as translator pipeline does)
    ensureToolCallIds(body);
    const claude = openaiToClaudeRequest("claude-sonnet-5", body);
    const results = claude.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []
    );

    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe("call_abc123");
  });
});
