import { describe, it, expect, beforeEach } from "vitest";
import { deriveSessionId, clearSessionStore } from "../../open-sse/utils/sessionManager.js";

describe("deriveSessionId stability for noauth (#3262)", () => {
  beforeEach(() => {
    clearSessionStore();
  });

  it("returns same sessionId for 'noauth' across consecutive calls", () => {
    const sid1 = deriveSessionId("noauth");
    const sid2 = deriveSessionId("noauth");
    expect(sid1).toBe(sid2);
  });
});
