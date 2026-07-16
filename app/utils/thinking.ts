export type ThinkingContentSegment = {
  isThinking: boolean;
  content: string;
};

export function formatReasoningForExport(
  content: string,
  reasoning: string,
  label: string,
) {
  const quotedReasoning = reasoning
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> **${label}**\n>\n${quotedReasoning}\n\n${content}`;
}

function pendingTagPrefixLength(content: string, tag: string) {
  const maxLength = Math.min(content.length, tag.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (content.endsWith(tag.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

/**
 * Separates provider-native reasoning chunks and textual <think> blocks while
 * retaining partial tags between streamed chunks.
 */
export function createThinkingContentParser() {
  let isTaggedThinking = false;
  let pendingContent = "";

  const parsePending = (flush: boolean): ThinkingContentSegment[] => {
    const segments: ThinkingContentSegment[] = [];

    while (pendingContent.length > 0) {
      const tag = isTaggedThinking ? "</think>" : "<think>";
      const tagIndex = pendingContent.indexOf(tag);

      if (tagIndex >= 0) {
        if (tagIndex > 0) {
          segments.push({
            isThinking: isTaggedThinking,
            content: pendingContent.slice(0, tagIndex),
          });
        }
        pendingContent = pendingContent.slice(tagIndex + tag.length);
        isTaggedThinking = !isTaggedThinking;
        continue;
      }

      const retainedLength = flush
        ? 0
        : pendingTagPrefixLength(pendingContent, tag);
      const safeLength = pendingContent.length - retainedLength;
      if (safeLength > 0) {
        segments.push({
          isThinking: isTaggedThinking,
          content: pendingContent.slice(0, safeLength),
        });
        pendingContent = pendingContent.slice(safeLength);
      }
      break;
    }

    return segments;
  };

  return {
    push(content: string, isThinking: boolean): ThinkingContentSegment[] {
      if (isThinking) {
        return [...parsePending(true), { isThinking: true, content }].filter(
          (segment) => segment.content.length > 0,
        );
      }
      pendingContent += content;
      return parsePending(false);
    },
    finish(): ThinkingContentSegment[] {
      return parsePending(true);
    },
  };
}
