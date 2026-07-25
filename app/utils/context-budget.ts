import type { ConversationMessageInput } from "./conversation";
import { estimateTokenLength } from "./token";

function getContextSafetyReserve(contextWindowTokens: number) {
  return Math.min(
    Math.max(512, Math.floor(contextWindowTokens * 0.05)),
    Math.max(64, Math.floor(contextWindowTokens * 0.1)),
  );
}

export function getContextInputBudget(
  contextWindowTokens: number,
  maxOutputTokens: number,
) {
  const safetyReserve = getContextSafetyReserve(contextWindowTokens);
  const outputReserve = Math.min(
    maxOutputTokens,
    Math.max(128, Math.min(4_000, Math.floor(contextWindowTokens * 0.25))),
  );
  return Math.max(0, contextWindowTokens - outputReserve - safetyReserve);
}

export function getEffectiveMaxOutputTokens(
  contextWindowTokens: number,
  configuredMaxOutputTokens: number,
  promptTokenCount: number,
) {
  const available =
    contextWindowTokens -
    getContextSafetyReserve(contextWindowTokens) -
    promptTokenCount;
  return Math.max(1, Math.min(configuredMaxOutputTokens, available));
}

export function estimateRequestMessageTokens(
  message: Pick<ConversationMessageInput, "content">,
) {
  if (!Array.isArray(message.content)) {
    return estimateTokenLength(message.content);
  }
  return message.content.reduce((tokens, part) => {
    if (part.text) return tokens + estimateTokenLength(part.text);
    if (part.image_url?.url) return tokens + 1_024;
    return tokens;
  }, 0);
}
