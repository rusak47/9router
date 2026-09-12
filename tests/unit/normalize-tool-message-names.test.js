import { describe, it, expect } from "vitest";
import { normalizeToolMessageNames } from "../../open-sse/translator/concerns/toolCall.js";

describe("normalizeToolMessageNames", () => {
  it("backfills missing name from preceding assistant tool_calls", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "tc1", type: "function", function: { name: "get_weather" } }],
        },
        { role: "tool", tool_call_id: "tc1", content: "22°C" },
      ],
    };
    normalizeToolMessageNames(body);
    expect(body.messages[2].name).toBe("get_weather");
  });

  it("preserves existing name", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "tc1", type: "function", function: { name: "get_weather" } }],
        },
        { role: "tool", tool_call_id: "tc1", content: "22°C", name: "existing" },
      ],
    };
    normalizeToolMessageNames(body);
    expect(body.messages[1].name).toBe("existing");
  });

  it("does not fill name when no preceding assistant tool_calls", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "tc1", content: "orphan" },
      ],
    };
    normalizeToolMessageNames(body);
    expect(body.messages[1].name).toBeUndefined();
  });

  it("resets name map on new assistant turn, does not leak from previous", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "tc1", type: "function", function: { name: "old_tool" } }],
        },
        { role: "tool", tool_call_id: "tc1", content: "x" },
        { role: "assistant", tool_calls: [] },
        { role: "tool", tool_call_id: "tc1", content: "y" },
      ],
    };
    normalizeToolMessageNames(body);
    expect(body.messages[1].name).toBe("old_tool");
    expect(body.messages[3].name).toBeUndefined();
  });

  it("returns body unchanged when no messages", () => {
    const body = { messages: null };
    const result = normalizeToolMessageNames(body);
    expect(result).toBe(body);
    expect(result.messages).toBeNull();
  });

  it("does not fill name when tool_call_id not in pending map", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "tc1", type: "function", function: { name: "get_weather" } }],
        },
        { role: "tool", tool_call_id: "other", content: "?" },
      ],
    };
    normalizeToolMessageNames(body);
    expect(body.messages[1].name).toBeUndefined();
  });
});
