import { describe, expect, test } from "vitest";
import {
  createThinkingContentParser,
  formatReasoningForExport,
} from "../app/utils/thinking";

function collect(chunks: Array<{ content: string; isThinking: boolean }>) {
  const parser = createThinkingContentParser();
  const segments = chunks.flatMap((chunk) =>
    parser.push(chunk.content, chunk.isThinking),
  );
  segments.push(...parser.finish());
  return {
    reasoning: segments
      .filter((segment) => segment.isThinking)
      .map((segment) => segment.content)
      .join(""),
    content: segments
      .filter((segment) => !segment.isThinking)
      .map((segment) => segment.content)
      .join(""),
  };
}

describe("createThinkingContentParser", () => {
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
          content: "before<think>reasoning</think>after",
          isThinking: false,
        },
      ]),
    ).toEqual({ reasoning: "reasoning", content: "beforeafter" });
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

  test("supports multiple reasoning blocks and reasoning-only replies", () => {
    expect(
      collect([
        { content: "<think>one</think>", isThinking: false },
        { content: "<think>two</think>", isThinking: false },
      ]),
    ).toEqual({ reasoning: "onetwo", content: "" });
  });
});

describe("formatReasoningForExport", () => {
  test("adds a labelled reasoning quote before the final answer", () => {
    expect(
      formatReasoningForExport("answer", "step one\nstep two", "Reasoning"),
    ).toBe("> **Reasoning**\n>\n> step one\n> step two\n\nanswer");
  });
});
