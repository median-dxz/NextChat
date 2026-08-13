export interface StreamingContentSegment {
  kind: "reasoning" | "content";
  content: string;
}

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

const openingTag = "<think>";
const closingTag = "</think>";

/**
 * Separates provider-native reasoning chunks and a leading textual <think>
 * block while retaining partial tags between streamed chunks.
 */
export class ThinkingContentParser {
  private mode: "unknown" | "reasoning" | "content" = "unknown";
  private pendingContent = "";

  push({
    isThinking: isReasoning,
    content,
  }: {
    isThinking: boolean;
    content: string | undefined;
  }): StreamingContentSegment[] {
    if (!content) return [];

    if (isReasoning) {
      this.mode = "content";
      return [{ kind: "reasoning", content }];
    }

    if (this.mode === "content") return [{ kind: "content", content }];

    this.pendingContent += content;

    if (this.mode === "unknown") {
      if (this.pendingContent.startsWith(openingTag)) {
        this.pendingContent = this.pendingContent.slice(openingTag.length);
        this.mode = "reasoning";
      } else if (openingTag.startsWith(this.pendingContent)) {
        // 还未接收到完整的 openingTag
        return [];
      } else {
        this.mode = "content";
        return [this.takePending("content")];
      }
    }

    return this.parseReasoning();
  }

  finish(): StreamingContentSegment[] {
    if (this.pendingContent.length === 0) {
      return [];
    }

    return [
      this.takePending(this.mode === "reasoning" ? "reasoning" : "content"),
    ];
  }

  private parseReasoning(): StreamingContentSegment[] {
    const closingTagIndex = this.pendingContent.indexOf(closingTag);
    if (closingTagIndex >= 0) {
      const reasoning = this.pendingContent.slice(0, closingTagIndex);
      const content = this.pendingContent.slice(
        closingTagIndex + closingTag.length,
      );

      this.pendingContent = "";
      this.mode = "content";

      const segments: StreamingContentSegment[] = [
        { kind: "reasoning", content: reasoning },
        { kind: "content", content },
      ];

      return segments.filter(({ content }) => content.length > 0);
    }

    const retainedLength = this.pendingTagPrefixLength();
    const reasoning = this.pendingContent.slice(
      0,
      this.pendingContent.length - retainedLength,
    );
    this.pendingContent = this.pendingContent.slice(reasoning.length);
    return reasoning ? [{ kind: "reasoning", content: reasoning }] : [];
  }

  private takePending(kind: StreamingContentSegment["kind"]) {
    const segment = { kind, content: this.pendingContent };
    this.pendingContent = "";
    return segment;
  }

  private pendingTagPrefixLength() {
    const maxLength = Math.min(
      this.pendingContent.length,
      closingTag.length - 1,
    );
    for (let length = maxLength; length > 0; length -= 1) {
      if (this.pendingContent.endsWith(closingTag.slice(0, length))) {
        return length;
      }
    }
    return 0;
  }
}
