import { describe, expect, test } from "vitest";
import {
  formatReasoningForExport,
  ThinkingContentParser,
} from "../app/utils/thinking";

function collect(chunks: Array<{ content: string; isThinking: boolean }>) {
  const parser = new ThinkingContentParser();
  const segments = chunks.flatMap((chunk) => parser.push(chunk));
  segments.push(...parser.finish());
  return {
    reasoning: segments
      .filter((segment) => segment.kind === "reasoning")
      .map((segment) => segment.content)
      .join(""),
    content: segments
      .filter((segment) => segment.kind === "content")
      .map((segment) => segment.content)
      .join(""),
  };
}

describe("ThinkingContentParser", () => {
  test("keeps provider-native reasoning separate from final content", () => {
    expect(
      collect([
        { content: "reasoning", isThinking: true },
        { content: "answer", isThinking: false },
      ]),
    ).toEqual({ reasoning: "reasoning", content: "answer" });
  });

  test("separates a complete think block", () => {
    expect(
      collect([
        {
          content: "<think>reasoning</think>answer",
          isThinking: false,
        },
      ]),
    ).toEqual({ reasoning: "reasoning", content: "answer" });
  });

  test("retains think tags split across chunks", () => {
    expect(
      collect([
        { content: "<thi", isThinking: false },
        { content: "nk>step</thi", isThinking: false },
        { content: "nk>answer", isThinking: false },
      ]),
    ).toEqual({ reasoning: "step", content: "answer" });
  });
});

describe("formatReasoningForExport", () => {
  test("adds a labelled reasoning quote before the final answer", () => {
    expect(
      formatReasoningForExport("answer", "step one\nstep two", "Reasoning"),
    ).toBe("> **Reasoning**\n>\n> step one\n> step two\n\nanswer");
  });
});
