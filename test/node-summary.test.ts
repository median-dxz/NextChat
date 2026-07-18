import { describe, expect, test } from "vitest";
import type { ConversationNode } from "../app/utils/conversation-graph";
import { createContextProjection } from "../app/utils/context-compression";
import {
  materializeNodeSummaries,
  planNodeConversationContext,
  planNodeSummarySource,
} from "../app/utils/node-summary";

function node(
  id: string,
  outlineLevel: number,
  parentId?: string,
  role: ConversationNode["role"] = "user",
  content = id,
): ConversationNode {
  return { id, date: "", role, content, outlineLevel, parentId };
}

describe("node summary planning", () => {
  test("a summary never reads nodes deeper than its assistant", () => {
    const projection = [
      node("root", 1),
      node("branch", 2, "root"),
      node("deep", 3, "branch"),
      node("answer", 2, "branch", "assistant"),
    ];

    const plan = planNodeSummarySource(projection, "answer", 10_000, 1_000)!;

    expect(plan.inputNodes.map((item) => item.id)).toEqual([
      "root",
      "branch",
      "answer",
    ]);
    expect(plan.sourceNodeIds).toEqual(["branch", "answer"]);
  });

  test("does not materialize a summary that could reveal a hidden source", () => {
    const source = {
      ...node("answer", 1, undefined, "assistant"),
      hidden: true,
      nodeSummaries: {
        segment: {
          content: "remembered details",
          sourceNodeIds: ["answer"],
          tokenCount: 3,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    };

    expect(materializeNodeSummaries([source])).toEqual([]);
  });

  test("prefers raw fidelity when it fits and summary coverage when it does not", () => {
    const entries = [
      node("a", 1, undefined, "user", "a".repeat(400)),
      node("b", 1, "a", "assistant", "b".repeat(400)),
      node("recent-user", 1, "b", "user", "recent"),
      node("recent-answer", 1, "recent-user", "assistant", "answer"),
    ];
    const projection = createContextProjection(entries);
    const summary = {
      id: "summary",
      kind: "segment" as const,
      content: "compact",
      sourceEntryIds: ["a", "b"],
      sourceDigest: "",
      inputSummaryIds: [],
      stable: true,
    };

    const roomy = planNodeConversationContext({
      projection,
      summaries: [summary],
      historyMessageCount: 2,
      contextWindowTokens: 8_000,
      maxOutputTokens: 128,
      fixedTokenCount: 0,
      currentInputTokenCount: 0,
    });
    expect(roomy.selectedMessageIds).toEqual([
      "a",
      "b",
      "recent-user",
      "recent-answer",
    ]);
    expect(roomy.selectedSummaryIds).toEqual([]);

    const constrained = planNodeConversationContext({
      projection,
      summaries: [summary],
      historyMessageCount: 2,
      contextWindowTokens: 250,
      maxOutputTokens: 128,
      fixedTokenCount: 0,
      currentInputTokenCount: 0,
    });
    expect(constrained.selectedSummaryIds).toEqual(["summary"]);
    expect(constrained.selectedMessageIds).toEqual([
      "recent-user",
      "recent-answer",
    ]);
  });

  test("keeps oversized recent history within the actual input budget", () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      node(
        `m${index}`,
        1,
        index ? `m${index - 1}` : undefined,
        index % 2 ? "assistant" : "user",
        "x".repeat(8_000),
      ),
    );

    const plan = planNodeConversationContext({
      projection: createContextProjection(entries),
      summaries: [],
      historyMessageCount: 12,
      contextWindowTokens: 1_024,
      maxOutputTokens: 128,
      fixedTokenCount: 0,
      currentInputTokenCount: 0,
    });

    expect(plan.selectedMessageIds.length).toBeLessThan(entries.length);
    expect(plan.overflow).toBe(false);
  });

  test("rejects summaries with missing or hidden source nodes", () => {
    const entries = [
      {
        ...node("m2", 1, undefined, "assistant", "x".repeat(4_000)),
        hidden: true,
      },
      node("m3", 1, "m2", "user", "recent"),
    ];
    const staleSummary = {
      id: "stale",
      kind: "segment" as const,
      content: "hidden m1 content",
      sourceEntryIds: ["m1", "m2"],
      sourceDigest: "",
      inputSummaryIds: [],
      stable: true,
    };

    const plan = planNodeConversationContext({
      projection: createContextProjection(entries),
      summaries: [
        staleSummary,
        {
          ...staleSummary,
          id: "hidden",
          sourceEntryIds: ["m2"],
        },
      ],
      historyMessageCount: 1,
      contextWindowTokens: 1_024,
      maxOutputTokens: 128,
      fixedTokenCount: 0,
      currentInputTokenCount: 0,
    });

    expect(plan.selectedSummaryIds).toEqual([]);
  });
});
