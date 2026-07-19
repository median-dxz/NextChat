import { describe, expect, test } from "vitest";

import { Conversation } from "../app/utils/conversation";
import {
  conversationNode,
  conversationState,
  generatedSummary,
  linearConversation,
} from "./fixtures/conversation";

const segmentOptions = {
  sourceTokenTarget: 0,
  maxSourceNodes: 16,
  inputBudget: 10_000,
};

const checkpointOptions = {
  targetSegments: 1,
  mergeTokenTarget: 100_000,
  inputBudget: 10_000,
};

describe("conversation summary", () => {
  test("creates contiguous segments after either threshold", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "question" },
      { id: "b", role: "assistant", content: "answer" },
      { id: "c", role: "user" },
      { id: "d", role: "assistant" },
    ]);
    const first = Conversation(graph).planning("b").segment(segmentOptions)!;
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages.slice(0, 2), "first"),
    };
    const second = Conversation(graph).planning("d").segment({
      ...segmentOptions,
      sourceTokenTarget: 100_000,
      maxSourceNodes: 2,
    })!;

    expect(first.sourceNodeIds).toEqual(["a", "b"]);
    expect(second.sourceNodeIds).toEqual(["c", "d"]);
  });

  test("waits for an assistant and refuses an oversized complete source", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "x".repeat(10_000) },
      { id: "b", role: "assistant" },
    ]);

    expect(
      Conversation(graph).planning("a").segment(segmentOptions),
    ).toBeUndefined();
    expect(
      Conversation(graph).planning("b").segment({
        ...segmentOptions,
        inputBudget: 1,
      }),
    ).toBeUndefined();
  });

  test("refreshes generated stale segments and protects user edits", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "old" },
      { id: "b", role: "assistant" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages, "generated"),
    };
    graph.messages[0].content = "edited";

    expect(
      Conversation(graph).planning("b").segment({
        ...segmentOptions,
        sourceTokenTarget: 100_000,
      }),
    ).toEqual(expect.objectContaining({ action: "refresh", ownerNodeId: "b" }));

    graph.messages[1].nodeSummaries.segment!.provenance = "user-edited";
    expect(
      Conversation(graph).planning("b").segment({
        ...segmentOptions,
        sourceTokenTarget: 100_000,
      }),
    ).toBeUndefined();
  });

  test("keeps Coverage inside one Outline Chain and uses only fresh background", () => {
    const root = conversationNode({ id: "1A", role: "user" });
    const branchUser = conversationNode({
      id: "2A",
      role: "user",
      parentId: root.id,
      outlineLevel: 2,
    });
    const branchAssistant = conversationNode({
      id: "2B",
      role: "assistant",
      parentId: branchUser.id,
      outlineLevel: 2,
    });
    root.activeBranchRootId = branchUser.id;
    const rootAssistant = conversationNode({
      id: "1B",
      role: "assistant",
      parentId: root.id,
    });
    const graph = conversationState(
      [root, branchUser, branchAssistant, rootAssistant],
      { activeCursorId: rootAssistant.id },
    );

    const deep = Conversation(graph)
      .planning(branchAssistant.id)
      .segment(segmentOptions)!;
    const shallow = Conversation(graph)
      .planning(rootAssistant.id)
      .segment(segmentOptions)!;

    expect(deep.sourceNodeIds).toEqual(["2A", "2B"]);
    expect(deep.background.map((item) => item.endpointNodeId)).toEqual(["1A"]);
    expect(shallow.sourceNodeIds).toEqual(["1A", "1B"]);
    expect(shallow.background).toEqual([]);
  });

  test("creates and extends checkpoints from fresh Segment inputs", () => {
    const graph = linearConversation([
      { id: "a", role: "user" },
      { id: "b", role: "assistant" },
      { id: "c", role: "user" },
      { id: "d", role: "assistant" },
      { id: "e", role: "user" },
      { id: "f", role: "assistant" },
    ]);
    for (const [start, end] of [
      [0, 1],
      [2, 3],
      [4, 5],
    ]) {
      graph.messages[end].nodeSummaries = {
        segment: generatedSummary(
          graph.messages.slice(start, end + 1),
          `segment ${end}`,
        ),
      };
    }
    const first = Conversation(graph).planning("d").checkpoint({
      ...checkpointOptions,
      targetSegments: 2,
    })!;
    graph.messages[3].nodeSummaries!.checkpoint = generatedSummary(
      graph.messages.slice(0, 4),
      "checkpoint d",
    );
    const extended = Conversation(graph).planning("f").checkpoint(
      checkpointOptions,
    )!;

    expect(first.sourceNodeIds).toEqual(["a", "b", "c", "d"]);
    expect(first.inputs.map((input) => input.kind)).toEqual([
      "segment",
      "segment",
    ]);
    expect(extended.sourceNodeIds).toEqual(
      graph.messages.map((message) => message.id),
    );
    expect(extended.inputs.map((input) => input.kind)).toEqual([
      "checkpoint",
      "segment",
    ]);
  });

  test.each([
    { targetSegments: 1, mergeTokenTarget: 100_000 },
    { targetSegments: 100, mergeTokenTarget: 0 },
  ])("triggers checkpoints on either merge threshold", (thresholds) => {
    const graph = linearConversation([
      { id: "a", role: "user" },
      { id: "b", role: "assistant" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages),
    };

    expect(
      Conversation(graph).planning("b").checkpoint({
        ...thresholds,
        inputBudget: 10_000,
      }),
    ).toEqual(expect.objectContaining({ ownerNodeId: "b" }));
  });

  test("rejects stale, gapped, and oversized checkpoint inputs", () => {
    const graph = linearConversation([
      { id: "a", role: "user" },
      { id: "b", role: "assistant" },
      { id: "c", role: "user" },
      { id: "d", role: "assistant" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: { ...generatedSummary(graph.messages.slice(0, 2)), sourceDigest: "stale" },
    };
    graph.messages[3].nodeSummaries = {
      segment: generatedSummary(graph.messages.slice(2)),
    };
    const plan = () =>
      Conversation(graph).planning("d").checkpoint(checkpointOptions);

    expect(plan()).toBeUndefined();
    graph.messages[1].nodeSummaries.segment = generatedSummary([
      graph.messages[0],
      graph.messages[3],
    ]);
    expect(plan()).toBeUndefined();
    graph.messages[1].nodeSummaries.segment = generatedSummary(
      graph.messages.slice(0, 2),
    );
    expect(
      Conversation(graph).planning("d").checkpoint({
        ...checkpointOptions,
        inputBudget: 1,
      }),
    ).toBeUndefined();
  });

  test("refreshes generated checkpoints without automatically replacing user edits", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "source" },
      { id: "b", role: "assistant" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages),
      checkpoint: { ...generatedSummary(graph.messages), sourceDigest: "stale" },
    };
    const plan = (force = false) =>
      Conversation(graph).planning("b").checkpoint({
        ...checkpointOptions,
        targetSegments: 100,
        force,
      });

    expect(plan()).toEqual(expect.objectContaining({ action: "refresh" }));
    graph.messages[1].nodeSummaries.checkpoint!.provenance = "user-edited";
    expect(plan()).toBeUndefined();
    expect(plan(true)).toEqual(expect.objectContaining({ action: "refresh" }));
  });
});
