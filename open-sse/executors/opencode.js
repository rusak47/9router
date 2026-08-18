import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  transformRequest(model, body) {
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey;    
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key || "public"}`,
      "x-opencode-client": "desktop",
      "Accept": "text/event-stream",
      "User-Agent": "opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14" //required to avoid filtering
    };
  }
}
