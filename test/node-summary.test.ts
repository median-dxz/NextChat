import { describe, expect, test } from "vitest";
import type { ConversationNode } from "../app/utils/conversation-graph";
import { createContextProjection } from "../app/utils/context-compression";
import {
  createNodeSummaryRuntimeCache,
  createNodeSummarySourceDigest,
  evaluateNodeSummary,
  materializeNodeSummaries,
  partitionProjectionIntoOutlineChains,
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
  test("partitions an interleaved projection into unique maximal outline chains", () => {
    const projection = [
      node("1A", 1),
      node("2A", 2, "1A"),
      node("2B", 2, "2A", "assistant"),
      node("1B", 1, "1A", "assistant"),
    ];

    expect(
      partitionProjectionIntoOutlineChains(projection).map((chain) =>
        chain.nodes.map((item) => item.id),
      ),
    ).toEqual([
      ["1A", "1B"],
      ["2A", "2B"],
    ]);
  });

  test("evaluates structural eligibility separately from digest freshness", () => {
    const projection = [
      node("1A", 1),
      node("2A", 2, "1A"),
      node("2B", 2, "2A", "assistant"),
      node("1B", 1, "1A", "assistant"),
    ];
    const chains = partitionProjectionIntoOutlineChains(projection);
    const sources = projection.slice(1, 3);
    const summary = {
      content: "segment",
      sourceNodeIds: sources.map((item) => item.id),
      sourceDigest: createNodeSummarySourceDigest(sources),
      provenance: "generated" as const,
    };

    expect(
      evaluateNodeSummary(projection[2], "segment", summary, chains),
    ).toEqual(
      expect.objectContaining({
        structurallyEligible: true,
        freshness: "fresh",
      }),
    );
    expect(
      evaluateNodeSummary(
        { ...projection[2], content: "edited" },
        "segment",
        summary,
        partitionProjectionIntoOutlineChains([
          projection[0],
          projection[1],
          { ...projection[2], content: "edited" },
          projection[3],
        ]),
      ),
    ).toEqual(
      expect.objectContaining({
        structurallyEligible: true,
        freshness: "stale",
      }),
    );
    const roleChangedSources = [
      sources[0],
      { ...sources[1], role: "user" as const },
    ];
    expect(createNodeSummarySourceDigest(roleChangedSources)).not.toBe(
      summary.sourceDigest,
    );
    expect(
      evaluateNodeSummary(projection[2], "checkpoint", summary, chains)
        .structurallyEligible,
    ).toBe(true);
    expect(
      evaluateNodeSummary(
        projection[3],
        "segment",
        { ...summary, sourceNodeIds: ["1A", "2B", "1B"] },
        chains,
      ).structurallyEligible,
    ).toBe(false);
  });

  test("requires checkpoint coverage to start at its chain root", () => {
    const projection = [
      node("a", 1),
      node("b", 1, "a"),
      node("c", 1, "b", "assistant"),
    ];
    const chains = partitionProjectionIntoOutlineChains(projection);
    const partialSources = projection.slice(1);
    const summary = {
      content: "checkpoint",
      sourceNodeIds: partialSources.map((item) => item.id),
      sourceDigest: createNodeSummarySourceDigest(partialSources),
      provenance: "generated" as const,
    };

    expect(
      evaluateNodeSummary(projection[2], "segment", summary, chains)
        .structurallyEligible,
    ).toBe(true);
    expect(
      evaluateNodeSummary(projection[2], "checkpoint", summary, chains)
        .structurallyEligible,
    ).toBe(false);
  });

  test("caches derived tokens and digests by their content snapshots", () => {
    const cache = createNodeSummaryRuntimeCache();
    const first = node("a", 1, undefined, "user", "same content");
    const second = node("b", 1, undefined, "assistant", "same content");

    expect(cache.getNodeTokens(first)).toBe(cache.getNodeTokens(second));
    cache.getNodeTokens({ ...second, content: "changed" });
    cache.getSummaryTokens("summary");
    cache.getSummaryTokens("summary");
    cache.getSourceDigest([first, second]);
    cache.getSourceDigest([first, second]);
    cache.getSourceDigest([first, { ...second, role: "user" }]);

    expect(cache.stats).toEqual({
      nodeTokenHits: 1,
      nodeTokenMisses: 2,
      summaryTokenHits: 1,
      summaryTokenMisses: 1,
      digestHits: 1,
      digestMisses: 2,
    });
    cache.clear();
    expect(Object.values(cache.stats).every((value) => value === 0)).toBe(true);
  });

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
          sourceDigest: "digest",
          provenance: "generated" as const,
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
