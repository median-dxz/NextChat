import type { ChatMessage } from "../store/chat";
import { getMessageImages, getMessageTextContent } from "../utils";

export function getVisibleMessages<T extends ChatMessage>(messages: T[]): T[] {
  return messages.filter((message) => !message.deletedAt);
}

export function mergeEditedMessagesWithTombstones<T extends ChatMessage>(
  originalMessages: T[],
  editedMessages: T[],
): T[] {
  let editedIndex = 0;
  const mergedMessages: T[] = [];

  for (const message of originalMessages) {
    if (message.deletedAt) {
      mergedMessages.push(message);
      continue;
    }

    const editedMessage = editedMessages[editedIndex++];
    if (editedMessage) mergedMessages.push(editedMessage);
  }

  mergedMessages.push(...editedMessages.slice(editedIndex));
  return mergedMessages;
}

function prepareMessagesForResend<T extends ChatMessage>(
  messages: T[],
  targetMessageId: string,
  contextBoundaryAfterMessageId?: string,
) {
  const targetIndex = messages.findIndex(
    (message) => message.id === targetMessageId && !message.deletedAt,
  );
  if (targetIndex < 0) return undefined;

  const target = messages[targetIndex];
  let userMessage: ChatMessage | undefined;
  let turnStartIndex = targetIndex;

  if (target.role === "assistant") {
    const candidate = messages[targetIndex - 1];
    if (!candidate || candidate.deletedAt || candidate.role !== "user") {
      return undefined;
    }
    userMessage = candidate;
    turnStartIndex = targetIndex - 1;
  } else if (target.role === "user") {
    userMessage = target;
  }

  if (!userMessage) return undefined;

  const remainingMessages = messages.slice(0, turnStartIndex);
  const boundaryIndex = contextBoundaryAfterMessageId
    ? messages.findIndex(
        (message) => message.id === contextBoundaryAfterMessageId,
      )
    : -1;
  const nextBoundary =
    boundaryIndex >= turnStartIndex
      ? remainingMessages.at(-1)?.id
      : contextBoundaryAfterMessageId;

  return {
    textContent: getMessageTextContent(userMessage),
    images: getMessageImages(userMessage),
    remainingMessages,
    contextBoundaryAfterMessageId: nextBoundary,
  };
}

export async function runResendTransaction<T extends ChatMessage>({
  messages,
  targetMessageId,
  contextBoundaryAfterMessageId,
  update,
  resend,
}: {
  messages: T[];
  targetMessageId: string;
  contextBoundaryAfterMessageId?: string;
  update: (messages: T[], contextBoundaryAfterMessageId?: string) => void;
  resend: (textContent: string, images: string[]) => Promise<void>;
}) {
  const prepared = prepareMessagesForResend(
    messages,
    targetMessageId,
    contextBoundaryAfterMessageId,
  );
  if (!prepared) return undefined;

  update(prepared.remainingMessages, prepared.contextBoundaryAfterMessageId);
  try {
    await resend(prepared.textContent, prepared.images);
    return prepared;
  } catch (error) {
    update(messages, contextBoundaryAfterMessageId);
    throw error;
  }
}
