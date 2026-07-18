import type { RequestMessage } from "../client/api";
import { hash } from "./hmac";
import { estimateTokenLength } from "./token";

type SummaryKind = "segment" | "checkpoint";

export interface ConversationSummary {
  id: string;
  kind: SummaryKind;
  content: string;
  sourceEntryIds: string[];
  sourceDigest: string;
  inputSummaryIds: string[];
  stable?: boolean;
}

export interface ContextProjectionEntry extends RequestMessage {
  id: string;
  isError?: boolean;
  streaming?: boolean;
  deletedAt?: number;
  hidden?: boolean;
}

export interface ContextProjection<
  T extends ContextProjectionEntry = ContextProjectionEntry,
> {
  // Ordered, visible complete turns, optionally preceded by one leading answer.
  entries: T[];
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

function getContextSafetyReserve(contextWindowTokens: number) {
  return Math.min(
    Math.max(512, Math.floor(contextWindowTokens * 0.05)),
    Math.max(64, Math.floor(contextWindowTokens * 0.1)),
  );
}

function findBoundaryStart(
  messages: ContextProjectionEntry[],
  boundaryAfterMessageId?: string,
) {
  if (!boundaryAfterMessageId) return 0;
  const index = messages.findIndex(
    (message) => message.id === boundaryAfterMessageId,
  );
  return index < 0 ? 0 : index + 1;
}

function isAvailableMessage(message: ContextProjectionEntry) {
  return !message.isError && !message.streaming && !message.deletedAt;
}

function messageDigestValue(message: ContextProjectionEntry) {
  return [message.id, message.role, message.content];
}

export function createSummarySourceDigest(
  messages: ContextProjectionEntry[],
): string {
  return hash(JSON.stringify(messages.map(messageDigestValue)));
}

export function createContextProjection<T extends ContextProjectionEntry>(
  messages: T[],
  boundaryAfterMessageId?: string,
): ContextProjection<T> {
  const boundaryStart = findBoundaryStart(messages, boundaryAfterMessageId);
  const entries = getCompleteTurns(messages.slice(boundaryStart), true).flat();
  return { entries };
}

export function isSummaryCurrent(
  summary: ConversationSummary,
  projection: ContextProjection,
) {
  if (summary.sourceEntryIds.length === 0) {
    return false;
  }
  const order = new Map(
    projection.entries.map((message, index) => [message.id, index]),
  );
  const indexes = summary.sourceEntryIds.map((id) => order.get(id));
  if (indexes.some((index) => index === undefined)) return false;
  if (summary.stable) {
    return indexes.every(
      (index, position) => position === 0 || index! > indexes[position - 1]!,
    );
  }
  if (!summary.sourceDigest) return false;
  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index]! !== indexes[index - 1]! + 1) return false;
  }
  const sourceMessages = summary.sourceEntryIds.map(
    (id) => projection.entries[order.get(id)!],
  );
  return createSummarySourceDigest(sourceMessages) === summary.sourceDigest;
}

export function getCompleteTurns<T extends ContextProjectionEntry>(
  messages: T[],
  includeLeadingAssistant = false,
) {
  const turns: T[][] = [];
  let currentTurn: T[] = [];
  let sawUserOrInvalidMessage = false;
  for (const message of messages) {
    if (!isAvailableMessage(message)) {
      currentTurn = [];
      sawUserOrInvalidMessage = true;
      continue;
    }
    if (message.role === "user") {
      currentTurn = [message];
      sawUserOrInvalidMessage = true;
      continue;
    }
    if (message.role === "assistant" && currentTurn.length > 0) {
      currentTurn.push(message);
      turns.push(currentTurn);
      currentTurn = [];
    } else if (
      includeLeadingAssistant &&
      message.role === "assistant" &&
      !sawUserOrInvalidMessage
    ) {
      turns.push([message]);
    }
  }
  return turns;
}

export function estimateRequestMessageTokens(
  message: Pick<RequestMessage, "content"> & { hidden?: boolean },
) {
  if (message.hidden) return 0;
  if (!Array.isArray(message.content)) {
    return estimateTokenLength(message.content);
  }
  return message.content.reduce((tokens, part) => {
    if (part.text) return tokens + estimateTokenLength(part.text);
    if (part.image_url?.url) return tokens + 1_024;
    return tokens;
  }, 0);
}
