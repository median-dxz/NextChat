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

  test("materializes manually edited summaries without invalidating hidden sources", () => {
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

    expect(materializeNodeSummaries([source])).toEqual([
      expect.objectContaining({
        id: "node-summary:answer:segment",
        content: "remembered details",
        stable: true,
      }),
    ]);
  });

  test("prefers raw fidelity when it fits and summary coverage when it does not", () => {
    const entries = [
      node("a", 1, undefined, "user", "a".repeat(400)),
      node("b", 1, "a", "assistant", "b".repeat(400)),
      node("recent", 1, "b", "user", "recent"),
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
      historyMessageCount: 1,
      contextWindowTokens: 8_000,
      maxOutputTokens: 128,
      fixedTokenCount: 0,
      currentInputTokenCount: 0,
    });
    expect(roomy.selectedMessageIds).toEqual(["a", "b", "recent"]);
    expect(roomy.selectedSummaryIds).toEqual([]);

    const constrained = planNodeConversationContext({
      projection,
      summaries: [summary],
      historyMessageCount: 1,
      contextWindowTokens: 250,
      maxOutputTokens: 128,
      fixedTokenCount: 0,
      currentInputTokenCount: 0,
    });
    expect(constrained.selectedSummaryIds).toEqual(["summary"]);
    expect(constrained.selectedMessageIds).toEqual(["recent"]);
  });

  test("plans 240 long nodes within the capped frontier", () => {
    const entries = Array.from({ length: 240 }, (_, index) =>
      node(
        `n${index}`,
        1,
        index ? `n${index - 1}` : undefined,
        index % 2 ? "assistant" : "user",
        "x".repeat(1_500),
      ),
    );
    const startedAt = performance.now();
    const plan = planNodeConversationContext({
      projection: createContextProjection(entries),
      summaries: [],
      historyMessageCount: 12,
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      fixedTokenCount: 500,
      currentInputTokenCount: 500,
    });

    expect(plan.selectedMessageIds.length).toBeGreaterThan(0);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
