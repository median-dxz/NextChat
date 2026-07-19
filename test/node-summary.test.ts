import { describe, expect, test } from "vitest";
import type { ConversationNode } from "../app/utils/conversation-node";
import {
  type ChainContextState,
  type NodeSummaryRuntimeCache,
  type OutlineChainContextFrontier,
  combineChainContextFrontiers,
  compareChainContextStates,
  createNodeSummaryRuntimeCache,
  createSourceDigest,
  evaluateNodeSummary,
  materializeContextRepresentations,
  partitionProjectionIntoOutlineChains,
  planChainContextFrontiers,
  planCheckpointMaintenance,
  planOutlineChainContext,
  planNodeConversationContext,
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

function fixedTokenCache(): NodeSummaryRuntimeCache {
  return {
    stats: {
      nodeTokenHits: 0,
      nodeTokenMisses: 0,
      summaryTokenHits: 0,
      summaryTokenMisses: 0,
      digestHits: 0,
      digestMisses: 0,
    },
    getNodeTokens: (item) => Number(item.content),
    getSummaryTokens: (content) => Number(content),
    getSourceDigest: createSourceDigest,
    clear() {},
  };
}

function state(override: Partial<ChainContextState> = {}): ChainContextState {
  return {
    tokens: 0,
    coveredNodeCount: 0,
    freshCoveredNodeCount: 0,
    rawCoveredNodeCount: 0,
    segmentCoveredNodeCount: 0,
    checkpointCoveredNodeCount: 0,
    selectedRepresentations: [],
    ...override,
  };
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
      sourceDigest: createSourceDigest(sources),
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
    expect(createSourceDigest(roleChangedSources)).not.toBe(
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
      sourceDigest: createSourceDigest(partialSources),
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

    cache.getNodeTokens(first);
    cache.getNodeTokens(first);
    cache.getNodeTokens(second);
    cache.getNodeTokens({ ...second, content: "changed" });
    cache.getNodeTokens({ ...second, role: "user" });
    cache.getSummaryTokens("summary");
    cache.getSummaryTokens("summary");
    cache.getSourceDigest([first, second]);
    cache.getSourceDigest([first, second]);
    cache.getSourceDigest([first, { ...second, role: "user" }]);

    expect(cache.stats).toEqual({
      nodeTokenHits: 1,
      nodeTokenMisses: 4,
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
    const digest = createSourceDigest(original);
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
        sourceDigest: createSourceDigest([
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

  test("creates the first checkpoint from fresh segments with full-prefix coverage", () => {
    const projection = [
      node("a", 1, undefined, "user"),
      node("b", 1, "a", "assistant"),
      node("c", 1, "b", "user"),
      node("d", 1, "c", "assistant"),
    ];
    projection[1].nodeSummaries = {
      segment: {
        content: "segment one",
        sourceNodeIds: ["a", "b"],
        sourceDigest: createSourceDigest(projection.slice(0, 2)),
        provenance: "generated",
      },
    };
    projection[3].nodeSummaries = {
      segment: {
        content: "segment two",
        sourceNodeIds: ["c", "d"],
        sourceDigest: createSourceDigest(projection.slice(2, 4)),
        provenance: "generated",
      },
    };

    const plan = planCheckpointMaintenance({
      projection,
      targetId: "d",
      targetSegments: 2,
      mergeTokenTarget: 100_000,
      inputBudget: 10_000,
    })!;

    expect(plan.ownerNodeId).toBe("d");
    expect(plan.sourceNodeIds).toEqual(["a", "b", "c", "d"]);
    expect(plan.inputs.map((input) => [input.kind, input.ownerNodeId])).toEqual(
      [
        ["segment", "b"],
        ["segment", "d"],
      ],
    );
  });

  test("extends the latest fresh checkpoint with only later fresh segments", () => {
    const projection = [
      node("a", 1, undefined, "user"),
      node("b", 1, "a", "assistant"),
      node("c", 1, "b", "user"),
      node("d", 1, "c", "assistant"),
      node("e", 1, "d", "user"),
      node("f", 1, "e", "assistant"),
    ];
    for (const [start, end] of [
      [0, 1],
      [2, 3],
      [4, 5],
    ]) {
      projection[end].nodeSummaries = {
        segment: {
          content: `segment ${end}`,
          sourceNodeIds: projection
            .slice(start, end + 1)
            .map((item) => item.id),
          sourceDigest: createSourceDigest(
            projection.slice(start, end + 1),
          ),
          provenance: "generated",
        },
      };
    }
    projection[3].nodeSummaries!.checkpoint = {
      content: "checkpoint through d",
      sourceNodeIds: ["a", "b", "c", "d"],
      sourceDigest: createSourceDigest(projection.slice(0, 4)),
      provenance: "generated",
    };

    const plan = planCheckpointMaintenance({
      projection,
      targetId: "f",
      targetSegments: 1,
      mergeTokenTarget: 100_000,
      inputBudget: 10_000,
    })!;

    expect(plan.sourceNodeIds).toEqual(projection.map((item) => item.id));
    expect(plan.inputs.map((input) => [input.kind, input.ownerNodeId])).toEqual(
      [
        ["checkpoint", "d"],
        ["segment", "f"],
      ],
    );
  });

  test("triggers checkpoint maintenance on either merge threshold", () => {
    const projection = [
      node("a", 1, undefined, "user"),
      node("b", 1, "a", "assistant"),
    ];
    projection[1].nodeSummaries = {
      segment: {
        content: "segment input",
        sourceNodeIds: ["a", "b"],
        sourceDigest: createSourceDigest(projection),
        provenance: "generated",
      },
    };
    const base = {
      projection,
      targetId: "b",
      inputBudget: 10_000,
    };

    expect(
      planCheckpointMaintenance({
        ...base,
        targetSegments: 1,
        mergeTokenTarget: 100_000,
      }),
    ).toBeDefined();
    expect(
      planCheckpointMaintenance({
        ...base,
        targetSegments: 100,
        mergeTokenTarget: 0,
      }),
    ).toBeDefined();
    expect(
      planCheckpointMaintenance({
        ...base,
        targetSegments: 100,
        mergeTokenTarget: 100_000,
      }),
    ).toBeUndefined();
  });

  test("rejects stale, structurally invalid, gapped, and oversized checkpoint inputs", () => {
    const projection = [
      node("a", 1, undefined, "user"),
      node("b", 1, "a", "assistant"),
      node("c", 1, "b", "user"),
      node("d", 1, "c", "assistant"),
    ];
    projection[1].nodeSummaries = {
      segment: {
        content: "stale segment",
        sourceNodeIds: ["a", "b"],
        sourceDigest: "stale",
        provenance: "generated",
      },
    };
    projection[3].nodeSummaries = {
      segment: {
        content: "fresh segment",
        sourceNodeIds: ["c", "d"],
        sourceDigest: createSourceDigest(projection.slice(2)),
        provenance: "generated",
      },
    };
    const args = {
      projection,
      targetId: "d",
      targetSegments: 1,
      mergeTokenTarget: 0,
      inputBudget: 10_000,
    };
    expect(planCheckpointMaintenance(args)).toBeUndefined();

    projection[1].nodeSummaries!.segment = {
      content: "invalid segment",
      sourceNodeIds: ["a", "d"],
      sourceDigest: createSourceDigest([
        projection[0],
        projection[3],
      ]),
      provenance: "generated",
    };
    expect(planCheckpointMaintenance(args)).toBeUndefined();

    projection[1].nodeSummaries!.segment = {
      content: "fresh segment",
      sourceNodeIds: ["a", "b"],
      sourceDigest: createSourceDigest(projection.slice(0, 2)),
      provenance: "generated",
    };
    expect(
      planCheckpointMaintenance({ ...args, inputBudget: 1 }),
    ).toBeUndefined();
  });

  test("refreshes stale generated checkpoints and protects user edits", () => {
    const projection = [
      node("a", 1, undefined, "user", "new source"),
      node("b", 1, "a", "assistant"),
    ];
    projection[1].nodeSummaries = {
      segment: {
        content: "fresh segment",
        sourceNodeIds: ["a", "b"],
        sourceDigest: createSourceDigest(projection),
        provenance: "generated",
      },
      checkpoint: {
        content: "old checkpoint",
        sourceNodeIds: ["a", "b"],
        sourceDigest: "stale",
        provenance: "generated",
      },
    };
    const args = {
      projection,
      targetId: "b",
      targetSegments: 100,
      mergeTokenTarget: 100_000,
      inputBudget: 10_000,
    };
    expect(planCheckpointMaintenance(args)).toEqual(
      expect.objectContaining({ action: "refresh", ownerNodeId: "b" }),
    );

    projection[1].nodeSummaries!.checkpoint!.provenance = "user-edited";
    expect(planCheckpointMaintenance(args)).toBeUndefined();
    expect(planCheckpointMaintenance({ ...args, force: true })).toEqual(
      expect.objectContaining({ action: "refresh", ownerNodeId: "b" }),
    );
  });

  test("ignores an older stale checkpoint when building a new automatic one", () => {
    const projection = [
      node("a", 1, undefined, "user", "edited root"),
      node("b", 1, "a", "assistant"),
      node("c", 1, "b", "user"),
      node("d", 1, "c", "assistant"),
      node("e", 1, "d", "user"),
      node("f", 1, "e", "assistant"),
    ];
    for (const [start, end] of [
      [0, 1],
      [2, 3],
      [4, 5],
    ]) {
      projection[end].nodeSummaries = {
        segment: {
          content: `fresh segment ${end}`,
          sourceNodeIds: projection
            .slice(start, end + 1)
            .map((item) => item.id),
          sourceDigest: createSourceDigest(
            projection.slice(start, end + 1),
          ),
          provenance: "generated",
        },
      };
    }
    projection[1].nodeSummaries!.checkpoint = {
      content: "stale manual checkpoint",
      sourceNodeIds: ["a", "b"],
      sourceDigest: "stale",
      provenance: "user-edited",
    };

    const plan = planCheckpointMaintenance({
      projection,
      targetId: "f",
      targetSegments: 2,
      mergeTokenTarget: 100_000,
      inputBudget: 10_000,
    })!;

    expect(plan.ownerNodeId).toBe("f");
    expect(plan.sourceNodeIds).toEqual(projection.map((item) => item.id));
    expect(plan.inputs.every((input) => input.kind === "segment")).toBe(true);
  });

  test("keeps a global recent raw suffix and only shortens it from the old end", () => {
    const projection = [
      node("1A", 1, undefined, "user", "3"),
      node("2A", 2, "1A", "user", "4"),
      node("2B", 2, "2A", "assistant", "5"),
      node("1B", 1, "1A", "assistant", "6"),
    ];

    const plan = planChainContextFrontiers({
      projection,
      recentRawNodeCount: 3,
      availableTokens: 11,
      cache: fixedTokenCache(),
    });

    expect(plan.recentRaw.nodeIds).toEqual(["2B", "1B"]);
    expect(plan.optionalNodeIds).toEqual(["1A", "2A"]);
    const fullChains = partitionProjectionIntoOutlineChains(projection);
    for (const chain of fullChains) {
      const recentInChain = chain.nodes
        .filter((item) => plan.recentRaw.nodeIds.includes(item.id))
        .map((item) => item.id);
      expect(recentInChain).toEqual(
        chain.nodes
          .slice(chain.nodes.length - recentInChain.length)
          .map((item) => item.id),
      );
    }
  });

  test("builds only continuous non-overlapping mixed paths to a chain tail", () => {
    const projection = [
      node("a", 1, undefined, "user", "4"),
      node("b", 1, "a", "assistant", "4"),
      node("c", 1, "b", "user", "4"),
      node("d", 1, "c", "assistant", "4"),
      node("e", 1, "d", "user", "4"),
      node("f", 1, "e", "assistant", "4"),
    ];
    projection[1].nodeSummaries = {
      segment: {
        content: "2",
        sourceNodeIds: ["a", "b"],
        sourceDigest: createSourceDigest(projection.slice(0, 2)),
        provenance: "generated",
      },
    };
    projection[3].nodeSummaries = {
      checkpoint: {
        content: "3",
        sourceNodeIds: ["a", "b", "c", "d"],
        sourceDigest: createSourceDigest(projection.slice(0, 4)),
        provenance: "generated",
      },
    };
    projection[5].nodeSummaries = {
      segment: {
        content: "2",
        sourceNodeIds: ["e", "f"],
        sourceDigest: createSourceDigest(projection.slice(4)),
        provenance: "generated",
      },
    };
    const chains = partitionProjectionIntoOutlineChains(projection);
    const frontier = planOutlineChainContext(
      chains[0],
      chains,
      projection.length,
      24,
      fixedTokenCache(),
    );

    expect(
      frontier.states.some(
        (candidate) =>
          candidate.selectedRepresentations[0]?.kind === "checkpoint" &&
          candidate.selectedRepresentations[1]?.kind === "segment",
      ),
    ).toBe(true);
    for (const candidate of frontier.states) {
      const coveredIds = candidate.selectedRepresentations.flatMap(
        (representation) =>
          representation.kind === "raw"
            ? [representation.nodeId]
            : representation.sourceNodeIds,
      );
      expect(coveredIds).toEqual(
        projection
          .slice(projection.length - coveredIds.length)
          .map((item) => item.id),
      );
      expect(new Set(coveredIds).size).toBe(coveredIds.length);
    }
  });

  test("excludes invalid summaries and ranks fresh coverage ahead of stale", () => {
    const projection = [
      node("a", 1, undefined, "user", "4"),
      node("b", 1, "a", "assistant", "4"),
    ];
    projection[1].nodeSummaries = {
      segment: {
        content: "1",
        sourceNodeIds: ["a", "b"],
        sourceDigest: createSourceDigest(projection),
        provenance: "generated",
      },
      checkpoint: {
        content: "1",
        sourceNodeIds: ["a", "b"],
        sourceDigest: "stale",
        provenance: "generated",
      },
    };
    const chains = partitionProjectionIntoOutlineChains(projection);
    const frontier = planOutlineChainContext(
      chains[0],
      chains,
      2,
      1,
      fixedTokenCache(),
    );
    expect(
      frontier.states.some((candidate) =>
        candidate.selectedRepresentations.some(
          (representation) => representation.kind === "segment",
        ),
      ),
    ).toBe(true);
    expect(
      frontier.states.some((candidate) =>
        candidate.selectedRepresentations.some(
          (representation) => representation.kind === "checkpoint",
        ),
      ),
    ).toBe(false);

    projection[1].nodeSummaries!.segment!.sourceNodeIds = ["b"];
    const invalidFrontier = planOutlineChainContext(
      chains[0],
      partitionProjectionIntoOutlineChains(projection),
      2,
      1,
      fixedTokenCache(),
    );
    expect(
      invalidFrontier.states.every((candidate) =>
        candidate.selectedRepresentations.every(
          (representation) => representation.kind !== "segment",
        ),
      ),
    ).toBe(true);
  });

  test("uses all six strict lexicographic comparison layers in order", () => {
    expect(
      compareChainContextStates(
        state({ coveredNodeCount: 2 }),
        state({ coveredNodeCount: 1, freshCoveredNodeCount: 100 }),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareChainContextStates(
        state({ coveredNodeCount: 2, freshCoveredNodeCount: 2 }),
        state({
          coveredNodeCount: 2,
          freshCoveredNodeCount: 1,
          rawCoveredNodeCount: 100,
        }),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareChainContextStates(
        state({
          coveredNodeCount: 2,
          freshCoveredNodeCount: 2,
          rawCoveredNodeCount: 2,
        }),
        state({
          coveredNodeCount: 2,
          freshCoveredNodeCount: 2,
          segmentCoveredNodeCount: 100,
        }),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareChainContextStates(
        state({
          coveredNodeCount: 2,
          freshCoveredNodeCount: 2,
          segmentCoveredNodeCount: 2,
        }),
        state({
          coveredNodeCount: 2,
          freshCoveredNodeCount: 2,
          checkpointCoveredNodeCount: 100,
        }),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareChainContextStates(
        state({
          coveredNodeCount: 2,
          freshCoveredNodeCount: 2,
          checkpointCoveredNodeCount: 2,
        }),
        state({ coveredNodeCount: 2, freshCoveredNodeCount: 2 }),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareChainContextStates(
        state({ coveredNodeCount: 2, tokens: 1 }),
        state({ coveredNodeCount: 2, tokens: 2 }),
      ),
    ).toBeGreaterThan(0);
  });

  test("matches an exhaustive small-chain path oracle", () => {
    const projection = [
      node("a", 1, undefined, "user", "3"),
      node("b", 1, "a", "assistant", "3"),
      node("c", 1, "b", "user", "3"),
      node("d", 1, "c", "assistant", "3"),
    ];
    projection[1].nodeSummaries = {
      segment: {
        content: "2",
        sourceNodeIds: ["a", "b"],
        sourceDigest: createSourceDigest(projection.slice(0, 2)),
        provenance: "generated",
      },
      checkpoint: {
        content: "1",
        sourceNodeIds: ["a", "b"],
        sourceDigest: "stale",
        provenance: "generated",
      },
    };
    projection[3].nodeSummaries = {
      segment: {
        content: "2",
        sourceNodeIds: ["c", "d"],
        sourceDigest: createSourceDigest(projection.slice(2)),
        provenance: "generated",
      },
    };
    const chains = partitionProjectionIntoOutlineChains(projection);
    const actual = planOutlineChainContext(
      chains[0],
      chains,
      4,
      8,
      fixedTokenCache(),
    ).states;
    type OracleEdge = {
      end: number;
      tokens: number;
      covered: number;
      fresh: number;
      raw: number;
      segment: number;
      checkpoint: number;
    };
    const edges: OracleEdge[][] = [
      [
        {
          end: 1,
          tokens: 3,
          covered: 1,
          fresh: 1,
          raw: 1,
          segment: 0,
          checkpoint: 0,
        },
        {
          end: 2,
          tokens: 2,
          covered: 2,
          fresh: 2,
          raw: 0,
          segment: 2,
          checkpoint: 0,
        },
        {
          end: 2,
          tokens: 1,
          covered: 2,
          fresh: 0,
          raw: 0,
          segment: 0,
          checkpoint: 2,
        },
      ],
      [
        {
          end: 2,
          tokens: 3,
          covered: 1,
          fresh: 1,
          raw: 1,
          segment: 0,
          checkpoint: 0,
        },
      ],
      [
        {
          end: 3,
          tokens: 3,
          covered: 1,
          fresh: 1,
          raw: 1,
          segment: 0,
          checkpoint: 0,
        },
        {
          end: 4,
          tokens: 2,
          covered: 2,
          fresh: 2,
          raw: 0,
          segment: 2,
          checkpoint: 0,
        },
      ],
      [
        {
          end: 4,
          tokens: 3,
          covered: 1,
          fresh: 1,
          raw: 1,
          segment: 0,
          checkpoint: 0,
        },
      ],
    ];
    const enumerated: ChainContextState[] = [];
    const visit = (position: number, current: ChainContextState) => {
      if (position === 4) {
        enumerated.push(current);
        return;
      }
      for (const edge of edges[position]) {
        const next = state({
          tokens: current.tokens + edge.tokens,
          coveredNodeCount: current.coveredNodeCount + edge.covered,
          freshCoveredNodeCount: current.freshCoveredNodeCount + edge.fresh,
          rawCoveredNodeCount: current.rawCoveredNodeCount + edge.raw,
          segmentCoveredNodeCount:
            current.segmentCoveredNodeCount + edge.segment,
          checkpointCoveredNodeCount:
            current.checkpointCoveredNodeCount + edge.checkpoint,
        });
        if (next.tokens <= 8) visit(edge.end, next);
      }
    };
    for (let cutoff = 0; cutoff <= 4; cutoff += 1) {
      visit(cutoff, state());
    }
    const signature = (candidate: ChainContextState) =>
      JSON.stringify([
        candidate.tokens,
        candidate.coveredNodeCount,
        candidate.freshCoveredNodeCount,
        candidate.rawCoveredNodeCount,
        candidate.segmentCoveredNodeCount,
        candidate.checkpointCoveredNodeCount,
      ]);
    const unique = [
      ...new Map(enumerated.map((item) => [signature(item), item])).values(),
    ];
    const oracle = unique.filter(
      (candidate, index) =>
        !unique.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.tokens <= candidate.tokens &&
            compareChainContextStates(other, candidate) > 0,
        ),
    );

    expect(new Set(actual.map(signature))).toEqual(
      new Set(oracle.map(signature)),
    );
  });

  test("combines interleaved chains under one global token budget", () => {
    const projection = [
      node("a", 1, undefined, "user", "3"),
      node("b", 2, "a", "user", "3"),
      node("c", 2, "b", "assistant", "3"),
      node("d", 1, "a", "assistant", "3"),
    ];
    projection[2].nodeSummaries = {
      segment: {
        content: "1",
        sourceNodeIds: ["b", "c"],
        sourceDigest: createSourceDigest(projection.slice(1, 3)),
        provenance: "generated",
      },
    };
    projection[3].nodeSummaries = {
      segment: {
        content: "2",
        sourceNodeIds: ["a", "d"],
        sourceDigest: createSourceDigest([
          projection[0],
          projection[3],
        ]),
        provenance: "generated",
      },
    };

    const plan = planNodeConversationContext({
      projection,
      recentRawNodeCount: 0,
      availableTokens: 3,
      cache: fixedTokenCache(),
    });

    expect(plan.state.coveredNodeCount).toBe(4);
    expect(plan.tokens).toBe(3);
    expect(
      plan.representations.map((representation) => representation.kind),
    ).toEqual(["segment", "segment"]);
  });

  test("materializes summaries as historical assistant output in projection order", () => {
    const projection = [
      node("a", 1, undefined, "user", "raw a"),
      node("b", 2, "a", "user", "raw b"),
      node("c", 2, "b", "assistant", "raw c"),
      node("d", 1, "a", "assistant", "raw d"),
    ];

    expect(
      materializeContextRepresentations(projection, [
        { kind: "raw", nodeId: "d" },
        {
          kind: "segment",
          ownerNodeId: "c",
          sourceNodeIds: ["b", "c"],
          content: "segment b-c",
          freshness: "fresh",
        },
        { kind: "raw", nodeId: "a" },
      ]),
    ).toEqual([
      { role: "user", content: "raw a" },
      { role: "assistant", content: "segment b-c" },
      { role: "assistant", content: "raw d" },
    ]);
  });

  test("matches an exhaustive small multi-chain combination oracle", () => {
    const frontier = (
      root: string,
      states: ChainContextState[],
    ): OutlineChainContextFrontier => ({
      chainRootId: root,
      outlineLevel: 1,
      nodeIds: [root],
      states,
      approximated: false,
    });
    const chains = [
      frontier("a", [state(), state({ tokens: 2, coveredNodeCount: 1 })]),
      frontier("b", [
        state(),
        state({
          tokens: 3,
          coveredNodeCount: 2,
          freshCoveredNodeCount: 2,
        }),
      ]),
      frontier("c", [state(), state({ tokens: 4, coveredNodeCount: 3 })]),
    ];
    const actual = combineChainContextFrontiers(chains, 6, {
      frontierLimit: 100,
    }).states;
    const enumerated = chains.reduce(
      (current, chain) =>
        current.flatMap((left) =>
          chain.states.flatMap((right) => {
            const combined = state({
              tokens: left.tokens + right.tokens,
              coveredNodeCount:
                left.coveredNodeCount + right.coveredNodeCount,
              freshCoveredNodeCount:
                left.freshCoveredNodeCount + right.freshCoveredNodeCount,
            });
            return combined.tokens <= 6 ? [combined] : [];
          }),
        ),
      [state()],
    );
    const best = (states: ChainContextState[]) =>
      states.reduce((winner, candidate) =>
        compareChainContextStates(candidate, winner) > 0
          ? candidate
          : winner,
      );

    expect(best(actual)).toEqual(best(enumerated));
  });

  test("bounded approximation retains the required frontier extremes", () => {
    const empty = state();
    const highestFidelity = state({
      tokens: 5,
      coveredNodeCount: 1,
      freshCoveredNodeCount: 1,
    });
    const highestCoverage = state({ tokens: 8, coveredNodeCount: 4 });
    const chain: OutlineChainContextFrontier = {
      chainRootId: "a",
      outlineLevel: 1,
      nodeIds: ["a"],
      states: [
        empty,
        highestFidelity,
        state({ tokens: 6, coveredNodeCount: 2 }),
        state({ tokens: 7, coveredNodeCount: 3 }),
        highestCoverage,
      ],
      approximated: false,
    };

    const result = combineChainContextFrontiers([chain], 8, {
      frontierLimit: 3,
      tokenBucketSize: 1,
    });

    expect(result.diagnostics.approximated).toBe(true);
    expect(result.states).toHaveLength(3);
    expect(result.states).toContainEqual(empty);
    expect(result.states).toContainEqual(highestCoverage);
    expect(result.states).toContainEqual(highestFidelity);
    expect(result.states.every((candidate) => candidate.tokens <= 8)).toBe(
      true,
    );
  });

  test("keeps a 250-node adversarial plan bounded", () => {
    const projection = Array.from({ length: 250 }, (_, index) =>
      node(
        `n${index}`,
        index % 10 === 0 ? 2 : 1,
        index === 0 ? undefined : `n${index - 1}`,
        index % 2 === 0 ? "user" : "assistant",
        "2",
      ),
    );
    const chains = partitionProjectionIntoOutlineChains(projection);
    for (const chain of chains) {
      for (let index = 1; index < chain.nodes.length; index += 2) {
        const owner = chain.nodes[index];
        if (owner.role !== "assistant") continue;
        const sources = chain.nodes.slice(Math.max(0, index - 1), index + 1);
        owner.nodeSummaries = {
          segment: {
            content: "1",
            sourceNodeIds: sources.map((source) => source.id),
            sourceDigest: createSourceDigest(sources),
            provenance: "generated",
          },
        };
      }
    }

    const startedAt = performance.now();
    const plan = planNodeConversationContext({
      projection,
      recentRawNodeCount: 8,
      availableTokens: 300,
      cache: fixedTokenCache(),
      frontierLimit: 64,
      tokenBucketSize: 8,
    });
    const duration = performance.now() - startedAt;

    expect(plan.tokens).toBeLessThanOrEqual(300);
    expect(plan.diagnostics.finalFrontierSize).toBeLessThanOrEqual(64);
    expect(new Set(plan.recentRaw.nodeIds).size).toBe(
      plan.recentRaw.nodeIds.length,
    );
    expect(duration).toBeLessThan(1_000);
  });
});
