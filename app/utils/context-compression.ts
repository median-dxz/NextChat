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
}

export interface ContextProjectionEntry extends RequestMessage {
  id: string;
  isError?: boolean;
  streaming?: boolean;
  deletedAt?: number;
}

export interface ContextProjection<
  T extends ContextProjectionEntry = ContextProjectionEntry,
> {
  // Ordered, visible complete turns, optionally preceded by one leading answer.
  entries: T[];
}

interface ContextPlan {
  selectedSummaryIds: string[];
  selectedMessageIds: string[];
  requiresCompaction: boolean;
  overflow: boolean;
}

interface SummaryMaintenancePlan {
  kind: SummaryKind;
  sourceEntryIds: string[];
  sourceDigest: string;
  inputSummaryIds: string[];
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

function getMandatoryInputBudget(
  contextWindowTokens: number,
  configuredMaxOutputTokens: number,
) {
  const minimumOutputReserve = configuredMaxOutputTokens > 0 ? 1 : 0;
  return Math.max(
    0,
    contextWindowTokens -
      getContextSafetyReserve(contextWindowTokens) -
      minimumOutputReserve,
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

function moveToTurnStart(messages: ContextProjectionEntry[], index: number) {
  let start = Math.max(0, index);
  while (start > 0 && messages[start]?.role !== "user") start -= 1;
  return start;
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

function getSummaryStartId(summary: ConversationSummary) {
  return summary.sourceEntryIds[0];
}

function getSummaryEndId(summary: ConversationSummary) {
  return summary.sourceEntryIds.at(-1);
}

function getSummaryTokenCount(summary: ConversationSummary) {
  return estimateTokenLength(summary.content);
}

export function isSummaryCurrent(
  summary: ConversationSummary,
  projection: ContextProjection,
) {
  if (!summary.sourceDigest || summary.sourceEntryIds.length === 0) {
    return false;
  }
  const order = new Map(
    projection.entries.map((message, index) => [message.id, index]),
  );
  const indexes = summary.sourceEntryIds.map((id) => order.get(id));
  if (indexes.some((index) => index === undefined)) return false;
  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index]! !== indexes[index - 1]! + 1) return false;
  }
  const sourceMessages = summary.sourceEntryIds.map(
    (id) => projection.entries[order.get(id)!],
  );
  return createSummarySourceDigest(sourceMessages) === summary.sourceDigest;
}

function getCompleteTurns<T extends ContextProjectionEntry>(
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

export function planConversationContext(args: {
  projection: ContextProjection;
  summaries: ConversationSummary[];
  historyMessageCount: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
  fixedTokenCount: number;
  currentInputTokenCount: number;
}): ContextPlan {
  const inputBudget = getContextInputBudget(
    args.contextWindowTokens,
    args.maxOutputTokens,
  );
  const mandatoryTokens = args.fixedTokenCount + args.currentInputTokenCount;
  const mandatoryInputBudget = getMandatoryInputBudget(
    args.contextWindowTokens,
    args.maxOutputTokens,
  );
  const planningBudget = Math.max(
    inputBudget,
    Math.min(mandatoryTokens, mandatoryInputBudget),
  );
  const projection = args.projection;
  const eligibleMessages = projection.entries;
  const projectionOrder = new Map(
    projection.entries.map((message, index) => [message.id, index]),
  );
  const preferredRecentStart = moveToTurnStart(
    eligibleMessages,
    eligibleMessages.length - Math.max(0, args.historyMessageCount),
  );
  const recentMessages = eligibleMessages.slice(preferredRecentStart);
  const recentTurns = getCompleteTurns(recentMessages, true);
  const activeSummaries = args.summaries.filter((summary) =>
    isSummaryCurrent(summary, projection),
  );

  const findSegmentCover = (
    start: number,
    end: number,
  ): ConversationSummary[] | undefined => {
    const cover: ConversationSummary[] = [];
    let position = start;
    while (position < end) {
      const candidate = activeSummaries
        .filter((summary) => summary.kind === "segment")
        .filter(
          (summary) =>
            projectionOrder.get(getSummaryStartId(summary)) === position,
        )
        .filter((summary) => {
          const last = projectionOrder.get(getSummaryEndId(summary)!);
          return last !== undefined && last < end;
        })
        .sort((a, b) => {
          const coverageDifference =
            projectionOrder.get(getSummaryEndId(b)!)! -
            projectionOrder.get(getSummaryEndId(a)!)!;
          return (
            coverageDifference ||
            getSummaryTokenCount(a) - getSummaryTokenCount(b)
          );
        })[0];
      if (!candidate) return undefined;
      cover.push(candidate);
      position = projectionOrder.get(getSummaryEndId(candidate)!)! + 1;
    }
    return cover;
  };

  const findSummaryCover = (
    end: number,
    tokenBudget: number,
  ): ConversationSummary[] | undefined => {
    if (end === 0) return [];
    const checkpoints = activeSummaries
      .filter((summary) => summary.kind === "checkpoint")
      .filter(
        (summary) => projectionOrder.get(getSummaryStartId(summary)) === 0,
      )
      .filter((summary) => {
        const last = projectionOrder.get(getSummaryEndId(summary)!);
        return last !== undefined && last < end;
      })
      .sort((a, b) => {
        const coverageDifference =
          projectionOrder.get(getSummaryEndId(b)!)! -
          projectionOrder.get(getSummaryEndId(a)!)!;
        return (
          coverageDifference ||
          getSummaryTokenCount(a) - getSummaryTokenCount(b)
        );
      });
    for (const checkpoint of [...checkpoints, undefined]) {
      const start = checkpoint
        ? projectionOrder.get(getSummaryEndId(checkpoint)!)! + 1
        : 0;
      const segments = findSegmentCover(start, end);
      if (!segments) continue;
      const result = checkpoint ? [checkpoint, ...segments] : segments;
      const tokens = result.reduce(
        (sum, item) => sum + getSummaryTokenCount(item),
        0,
      );
      if (tokens <= tokenBudget) return result;
    }
    return undefined;
  };

  let selectedMessages: ContextProjectionEntry[] = [];
  let selectedSummaries: ConversationSummary[] = [];
  const minimumRecentTurns =
    recentTurns.length > 0 && args.historyMessageCount > 0 ? 1 : 0;
  for (
    let turnCount = recentTurns.length;
    turnCount >= minimumRecentTurns;
    turnCount -= 1
  ) {
    const candidateMessages = turnCount
      ? recentTurns.slice(-turnCount).flat()
      : [];
    const recentTokens = candidateMessages.reduce(
      (sum, message) => sum + estimateRequestMessageTokens(message),
      0,
    );
    if (mandatoryTokens + recentTokens > planningBudget) continue;
    const firstRecentIndex = candidateMessages.length
      ? projectionOrder.get(candidateMessages[0].id)!
      : projection.entries.length;
    const summaryCover = findSummaryCover(
      firstRecentIndex,
      planningBudget - mandatoryTokens - recentTokens,
    );
    if (!summaryCover) continue;
    selectedMessages = candidateMessages;
    selectedSummaries = summaryCover;
    break;
  }

  if (selectedMessages.length === 0 && selectedSummaries.length === 0) {
    let fallbackTokens = mandatoryTokens;
    for (let index = recentTurns.length - 1; index >= 0; index -= 1) {
      const turn = recentTurns[index];
      const turnTokens = turn.reduce(
        (sum, message) => sum + estimateRequestMessageTokens(message),
        0,
      );
      if (fallbackTokens + turnTokens > planningBudget) break;
      fallbackTokens += turnTokens;
      selectedMessages.unshift(...turn);
    }
  }

  const selectedMessageIds = selectedMessages.map((message) => message.id);
  const selectedSummaryIds = selectedSummaries.map((summary) => summary.id);
  const selected = new Set(selectedMessageIds);
  const covered = new Set(
    selectedSummaries.flatMap((summary) => summary.sourceEntryIds),
  );
  const excludedMessageIds = eligibleMessages
    .filter((message) => !selected.has(message.id) && !covered.has(message.id))
    .map((message) => message.id);
  const compressibleMessageIds = new Set(
    getCompleteTurns(eligibleMessages).flatMap((turn) =>
      turn.map((message) => message.id),
    ),
  );

  return {
    selectedSummaryIds,
    selectedMessageIds,
    requiresCompaction:
      mandatoryTokens <= inputBudget &&
      excludedMessageIds.some((id) => compressibleMessageIds.has(id)),
    overflow: mandatoryTokens > mandatoryInputBudget,
  };
}

export function estimateRequestMessageTokens(
  message: Pick<RequestMessage, "content">,
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

function selectOldestCompleteTurns<T extends ContextProjectionEntry>(
  messages: T[],
  maxTokens: number,
) {
  const selected: T[] = [];
  let tokens = 0;
  for (const turn of getCompleteTurns(messages)) {
    const turnTokens = turn.reduce(
      (sum, message) => sum + estimateRequestMessageTokens(message),
      0,
    );
    if (tokens + turnTokens > maxTokens) {
      if (selected.length === 0) selected.push(...turn);
      break;
    }
    tokens += turnTokens;
    selected.push(...turn);
  }
  return selected;
}

function getRecentCompleteMessageIds(
  messages: ContextProjectionEntry[],
  historyMessageCount: number,
) {
  if (historyMessageCount <= 0) return new Set<string>();
  const recentStart = moveToTurnStart(
    messages,
    messages.length - historyMessageCount,
  );
  return new Set(
    getCompleteTurns(messages.slice(recentStart), true)
      .flat()
      .map((message) => message.id),
  );
}

export function planSummaryMaintenance(args: {
  projection: ContextProjection;
  summaries: ConversationSummary[];
  historyMessageCount: number;
  inputBudget: number;
  compressionThreshold: number;
  force: boolean;
}): SummaryMaintenancePlan | undefined {
  const projection = args.projection;
  const eligible = projection.entries;
  const order = new Map(eligible.map((message, index) => [message.id, index]));
  const active = args.summaries.filter((summary) =>
    isSummaryCurrent(summary, projection),
  );
  const covered = new Set(active.flatMap((summary) => summary.sourceEntryIds));

  const selectSourceMessages = (recentIds: Set<string>) => {
    const selected = selectOldestCompleteTurns(
      eligible.filter(
        (message) => !covered.has(message.id) && !recentIds.has(message.id),
      ),
      args.inputBudget,
    );
    if (selected.length === 0) return selected;

    const contiguous: ContextProjectionEntry[] = [selected[0]];
    for (const message of selected.slice(1)) {
      const previous = contiguous.at(-1)!;
      if (order.get(message.id) !== order.get(previous.id)! + 1) break;
      contiguous.push(message);
    }
    return contiguous;
  };

  const preferredRecentIds = getRecentCompleteMessageIds(
    eligible,
    args.force
      ? Math.min(2, args.historyMessageCount)
      : args.historyMessageCount,
  );
  let sourceMessages = selectSourceMessages(preferredRecentIds);
  if (args.force && sourceMessages.length < 2) {
    sourceMessages = selectSourceMessages(new Set());
  }
  const sourceTokens = sourceMessages.reduce(
    (sum, message) => sum + estimateRequestMessageTokens(message),
    0,
  );
  const shouldCreateSegment =
    sourceMessages.length >= 2 &&
    (args.force || sourceTokens > args.compressionThreshold);

  const checkpoints = active
    .filter((summary) => summary.kind === "checkpoint")
    .filter((summary) => order.get(getSummaryStartId(summary)) === 0)
    .sort(
      (a, b) =>
        order.get(getSummaryEndId(b)!)! - order.get(getSummaryEndId(a)!)!,
    );
  const baseCheckpoint = checkpoints[0];
  let cursor = baseCheckpoint
    ? order.get(getSummaryEndId(baseCheckpoint)!)! + 1
    : 0;
  const deltaSegments: ConversationSummary[] = [];
  while (cursor < eligible.length) {
    const candidate = active
      .filter((summary) => summary.kind === "segment")
      .filter((summary) => order.get(getSummaryStartId(summary)) === cursor)
      .sort(
        (a, b) =>
          order.get(getSummaryEndId(b)!)! - order.get(getSummaryEndId(a)!)!,
      )[0];
    if (!candidate) break;
    deltaSegments.push(candidate);
    cursor = order.get(getSummaryEndId(candidate)!)! + 1;
  }
  const shouldCreateCheckpoint =
    !shouldCreateSegment &&
    deltaSegments.length > 0 &&
    (args.force || deltaSegments.length >= 4);
  if (!shouldCreateSegment && !shouldCreateCheckpoint) return undefined;

  const inputSummaries = shouldCreateCheckpoint
    ? [baseCheckpoint, ...deltaSegments].filter(
        (summary): summary is ConversationSummary => Boolean(summary),
      )
    : [];
  const sourceEntryIds = shouldCreateSegment
    ? sourceMessages.map((message) => message.id)
    : eligible.slice(0, cursor).map((message) => message.id);
  const sourceDigest = createSummarySourceDigest(
    sourceEntryIds.map((id) => eligible[order.get(id)!]),
  );
  const kind: SummaryKind = shouldCreateSegment ? "segment" : "checkpoint";
  if (
    active.some(
      (summary) =>
        summary.kind === kind && summary.sourceDigest === sourceDigest,
    )
  ) {
    return undefined;
  }

  return {
    kind,
    sourceEntryIds,
    sourceDigest,
    inputSummaryIds: inputSummaries.map((summary) => summary.id),
  };
}
