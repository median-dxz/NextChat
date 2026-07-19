import { describe, expect, test } from "vitest";
import type { ConversationNode } from "../app/utils/conversation-graph";
import {
  createNodeSummaryRuntimeCache,
  createNodeSummarySourceDigest,
  evaluateNodeSummary,
  partitionProjectionIntoOutlineChains,
  planSegmentMaintenance,
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

  test("creates contiguous segments on either source threshold", () => {
    const firstBlock = [
      node("a", 1, undefined, "user", "question"),
      node("b", 1, "a", "assistant", "answer"),
    ];
    const first = planSegmentMaintenance({
      projection: firstBlock,
      targetId: "b",
      sourceTokenTarget: 0.5,
      maxSourceNodes: 16,
      inputBudget: 10_000,
    })!;
    expect(first.sourceNodeIds).toEqual(["a", "b"]);

    firstBlock[1].nodeSummaries = {
      segment: {
        content: "first segment",
        sourceNodeIds: first.sourceNodeIds,
        sourceDigest: first.sourceDigest,
        provenance: "generated",
      },
    };
    const projection = [
      ...firstBlock,
      node("c", 1, "b", "user"),
      node("d", 1, "c", "assistant"),
    ];
    const second = planSegmentMaintenance({
      projection,
      targetId: "d",
      sourceTokenTarget: 100_000,
      maxSourceNodes: 2,
      inputBudget: 10_000,
    })!;
    expect(second.sourceNodeIds).toEqual(["c", "d"]);
  });

  test("waits for an assistant boundary and refuses incomplete oversized sources", () => {
    const projection = [
      node("a", 1, undefined, "user", "x".repeat(10_000)),
      node("b", 1, "a", "assistant", "answer"),
    ];
    expect(
      planSegmentMaintenance({
        projection: [projection[0]],
        targetId: "a",
        sourceTokenTarget: 1,
        maxSourceNodes: 1,
        inputBudget: 10_000,
      }),
    ).toBeUndefined();
    expect(
      planSegmentMaintenance({
        projection,
        targetId: "b",
        sourceTokenTarget: 1,
        maxSourceNodes: 16,
        inputBudget: 1,
      }),
    ).toBeUndefined();
  });

  test("refreshes generated stale segments but never overwrites user-edited ones", () => {
    const original = [
      node("a", 1, undefined, "user", "old"),
      node("b", 1, "a", "assistant", "answer"),
    ];
    const digest = createNodeSummarySourceDigest(original);
    const edited = [{ ...original[0], content: "new" }, original[1]];
    edited[1].nodeSummaries = {
      segment: {
        content: "generated summary",
        sourceNodeIds: ["a", "b"],
        sourceDigest: digest,
        provenance: "generated",
      },
    };
    expect(
      planSegmentMaintenance({
        projection: edited,
        targetId: "b",
        sourceTokenTarget: 100_000,
        maxSourceNodes: 16,
        inputBudget: 10_000,
      }),
    ).toEqual(expect.objectContaining({ action: "refresh", ownerNodeId: "b" }));

    edited[1].nodeSummaries!.segment!.provenance = "user-edited";
    expect(
      planSegmentMaintenance({
        projection: edited,
        targetId: "b",
        sourceTokenTarget: 100_000,
        maxSourceNodes: 16,
        inputBudget: 10_000,
      }),
    ).toBeUndefined();
  });

  test("allows deep segments to read shallow raw background only", () => {
    const projection = [
      node("1A", 1, undefined, "user", "shallow context"),
      node("2A", 2, "1A", "user", "branch question"),
      node("2B", 2, "2A", "assistant", "branch answer"),
      node("1B", 1, "1A", "assistant", "shallow answer"),
    ];
    const deep = planSegmentMaintenance({
      projection: projection.slice(0, 3),
      targetId: "2B",
      sourceTokenTarget: 1,
      maxSourceNodes: 16,
      inputBudget: 10_000,
    })!;
    expect(deep.background.map((item) => item.endpointNodeId)).toEqual(["1A"]);
    expect(deep.sourceNodeIds).toEqual(["2A", "2B"]);

    const shallow = planSegmentMaintenance({
      projection,
      targetId: "1B",
      sourceTokenTarget: 1,
      maxSourceNodes: 16,
      inputBudget: 10_000,
    })!;
    expect(shallow.background).toEqual([]);
    expect(shallow.sourceNodeIds).toEqual(["1A", "1B"]);
  });

  test("excludes stale summaries from generation background", () => {
    const first = node("a", 1, undefined, "user", "edited source");
    const firstOwner = node("b", 1, "a", "assistant", "answer");
    firstOwner.nodeSummaries = {
      segment: {
        content: "manual context",
        sourceNodeIds: ["a", "b"],
        sourceDigest: createNodeSummarySourceDigest([
          { ...first, content: "old source" },
          firstOwner,
        ]),
        provenance: "user-edited",
      },
    };
    const projection = [
      first,
      firstOwner,
      node("c", 1, "b", "user"),
      node("d", 1, "c", "assistant"),
    ];
    const plan = planSegmentMaintenance({
      projection,
      targetId: "d",
      sourceTokenTarget: 0.5,
      maxSourceNodes: 16,
      inputBudget: 10_000,
    })!;
    expect(plan.sourceNodeIds).toEqual(["c", "d"]);
    expect(plan.background.filter((item) => item.kind === "segment")).toEqual(
      [],
    );
  });
});
