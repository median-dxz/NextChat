import { describe, expect, test } from "vitest";

import { Conversation } from "../app/utils/conversation";
import {
  conversationNode,
  conversationState,
  generatedSummary,
  linearConversation,
} from "./fixtures/conversation";

const segmentOptions = {
  tokenTarget: 0,
  itemTarget: 16,
  inputBudget: 10_000,
};

const checkpointOptions = {
  tokenTarget: 100_000,
  itemTarget: 1,
  inputBudget: 10_000,
};

describe("conversation summary", () => {
  test("plans the next uncovered Segment across normal and sparse coverage", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "question" },
      { id: "b", role: "assistant", content: "answer" },
      { id: "c", role: "user" },
      { id: "d", role: "assistant" },
      { id: "e", role: "user" },
      { id: "f", role: "assistant" },
    ]);
    const first = Conversation(graph).summaries.plan("b").segment(segmentOptions)!;
    const afterFirst = Conversation(graph).summaries.commitGenerated(first, "first")!;
    const withSparseSegment = afterFirst.summaries.node("d").edit("segment", "manual");
    const next = withSparseSegment.summaries.plan("f").segment(segmentOptions)!;

    expect(first.coverage.nodeIds).toEqual(["a", "b"]);
    expect(next.coverage.nodeIds).toEqual(["e", "f"]);
  });

  test("splits an oversized uncovered tail at the oldest fitting assistant", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "xxxxxxxx" },
      { id: "b", role: "assistant", content: "xxxxxxxx" },
      { id: "c", role: "user", content: "xxxxxxxx" },
      { id: "d", role: "assistant", content: "xxxxxxxx" },
      { id: "e", role: "user", content: "xxxxxxxx" },
      { id: "f", role: "assistant", content: "xxxxxxxx" },
    ]);

    const first = Conversation(graph)
      .summaries.plan("f")
      .segment({ ...segmentOptions, tokenTarget: 100_000, itemTarget: 6, inputBudget: 4 })!;
    const afterFirst = Conversation(graph).summaries.commitGenerated(first, "first chunk")!;
    const second = afterFirst.summaries
      .plan("f")
      .segment({ ...segmentOptions, tokenTarget: 100_000, itemTarget: 4, inputBudget: 4 })!;

    expect(first.coverage.nodeIds).toEqual(["a", "b"]);
    expect(first.target.nodeId).toBe("b");
    expect(second.coverage.nodeIds).toEqual(["c", "d"]);
    expect(second.target.nodeId).toBe("d");
  });

  test("waits for an assistant and refuses an oversized complete source", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "x".repeat(10_000) },
      { id: "b", role: "assistant" },
    ]);

    expect(Conversation(graph).summaries.plan("a").segment(segmentOptions)).toBeUndefined();
    expect(
      Conversation(graph)
        .summaries.plan("b")
        .segment({
          ...segmentOptions,
          inputBudget: 1,
        }),
    ).toBeUndefined();
  });

  test("refreshes generated stale segments and protects user edits", () => {
    const graph = linearConversation([
      {
        id: "a",
        role: "user",
        content: [
          { type: "text", text: "old" },
          { type: "image_url", image_url: { url: "data:image/png;base64,old" } },
        ],
      },
      { id: "b", role: "assistant" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages, "generated"),
    };
    const edited = Conversation(graph).updateNodeData("a", (node) => {
      node.content = [
        { type: "text", text: "edited" },
        { type: "image_url", image_url: { url: "data:image/png;base64,edited" } },
      ];
    }).state;

    expect(
      Conversation(edited)
        .summaries.plan("b")
        .segment({
          ...segmentOptions,
          tokenTarget: 100_000,
        }),
    ).toEqual(expect.objectContaining({ target: expect.objectContaining({ nodeId: "b" }) }));

    const userEdited = structuredClone(edited);
    userEdited.messages[1].nodeSummaries!.segment!.provenance = "user-edited";
    expect(
      Conversation(userEdited)
        .summaries.plan("b")
        .segment({
          ...segmentOptions,
          tokenTarget: 100_000,
        }),
    ).toBeUndefined();
  });

  test("discards a generated summary when its target leaves the active projection", () => {
    const root = conversationNode({
      id: "root",
      role: "user",
      activeBranchRootId: "branch-a",
    });
    const branchA = conversationNode({
      id: "branch-a",
      role: "assistant",
      parentId: root.id,
      outlineLevel: 2,
    });
    const branchB = conversationNode({
      id: "branch-b",
      role: "assistant",
      parentId: root.id,
      outlineLevel: 2,
    });
    const graph = conversationState([root, branchA, branchB], {
      activeCursorId: branchA.id,
    });
    const plan = Conversation(graph).summaries.plan(branchA.id).segment(segmentOptions)!;

    const switched = Conversation(graph).node(root.id).setBranch(branchB.id);
    expect(switched.summaries.commitGenerated(plan, "late summary")).toBeUndefined();
    expect(switched.node(branchA.id).value.nodeSummaries).toBeUndefined();

    const removed = Conversation(graph).node(branchA.id).remove();
    expect(removed.summaries.commitGenerated(plan, "late summary")).toBeUndefined();
    expect(removed.findNode(branchA.id)).toBeUndefined();
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
    const graph = conversationState([root, branchUser, branchAssistant, rootAssistant], {
      activeCursorId: rootAssistant.id,
    });

    const deep = Conversation(graph).summaries.plan(branchAssistant.id).segment(segmentOptions)!;
    const shallow = Conversation(graph).summaries.plan(rootAssistant.id).segment(segmentOptions)!;

    expect(deep.coverage.nodeIds).toEqual(["2A", "2B"]);
    expect(deep.inputs.slice(0, -deep.coverage.nodeIds.length).map((item) => item.nodeId)).toEqual([
      "1A",
    ]);
    expect(shallow.coverage.nodeIds).toEqual(["1A", "1B"]);
    expect(shallow.inputs.slice(0, -shallow.coverage.nodeIds.length)).toEqual([]);
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
        segment: generatedSummary(graph.messages.slice(start, end + 1), `segment ${end}`),
      };
    }
    const first = Conversation(graph)
      .summaries.plan("d")
      .checkpoint({
        ...checkpointOptions,
        itemTarget: 2,
      })!;
    graph.messages[3].nodeSummaries!.checkpoint = generatedSummary(
      graph.messages.slice(0, 4),
      "checkpoint d",
    );
    const extended = Conversation(graph).summaries.plan("f").checkpoint(checkpointOptions)!;

    expect(first.coverage.nodeIds).toEqual(["a", "b", "c", "d"]);
    expect(first.inputs.map((input) => input.kind)).toEqual(["segment", "segment"]);
    expect(extended.coverage.nodeIds).toEqual(graph.messages.map((message) => message.id));
    expect(extended.inputs.map((input) => input.kind)).toEqual(["checkpoint", "segment"]);
  });

  test.each([
    { itemTarget: 1, tokenTarget: 100_000 },
    { itemTarget: 100, tokenTarget: 0 },
  ])("triggers checkpoints on either merge threshold", (thresholds) => {
    const graph = linearConversation([
      { id: "a", role: "user" },
      { id: "b", role: "assistant" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages),
    };

    expect(
      Conversation(graph)
        .summaries.plan("b")
        .checkpoint({
          ...thresholds,
          inputBudget: 10_000,
        }),
    ).toEqual(expect.objectContaining({ target: expect.objectContaining({ nodeId: "b" }) }));
  });

  test("builds Checkpoint inputs from the best available representations", () => {
    const graph = linearConversation([
      { id: "a", role: "user" },
      { id: "b", role: "assistant" },
      { id: "c", role: "user" },
      { id: "d", role: "assistant" },
    ]);
    graph.messages[3].nodeSummaries = {
      segment: generatedSummary(graph.messages.slice(2)),
    };
    const inputs = () =>
      Conversation(graph)
        .summaries.plan("d")
        .checkpoint(checkpointOptions)!
        .inputs.map((input) => `${input.kind}:${input.nodeId}`);

    graph.messages[1].nodeSummaries = {
      segment: { ...generatedSummary(graph.messages.slice(0, 2)), sourceDigest: "stale" },
    };
    expect(inputs()).toEqual(["raw:a", "raw:b", "segment:d"]);

    graph.messages[1].nodeSummaries.segment = generatedSummary([
      graph.messages[0],
      graph.messages[3],
    ]);
    expect(inputs()).toEqual(["raw:a", "raw:b", "segment:d"]);

    graph.messages[1].nodeSummaries.segment = generatedSummary(
      [graph.messages[1]],
      "segment b",
      "user-edited",
    );
    expect(inputs()).toEqual(["raw:a", "segment:b", "segment:d"]);
  });

  test("rejects a Checkpoint whose selected inputs exceed the budget", () => {
    const graph = linearConversation([
      { id: "a", role: "user" },
      { id: "b", role: "assistant" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages),
    };

    expect(
      Conversation(graph)
        .summaries.plan("b")
        .checkpoint({
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
      Conversation(graph)
        .summaries.plan("b")
        .checkpoint({
          ...checkpointOptions,
          itemTarget: 100,
          force,
        });

    expect(plan()).toEqual(
      expect.objectContaining({
        target: expect.objectContaining({
          expectation: { state: "present", snapshotDigest: expect.any(String) },
        }),
      }),
    );
    graph.messages[1].nodeSummaries.checkpoint!.provenance = "user-edited";
    expect(plan()).toBeUndefined();
    expect(plan(true)).toEqual(
      expect.objectContaining({
        target: expect.objectContaining({
          expectation: { state: "present", snapshotDigest: expect.any(String) },
        }),
      }),
    );
  });
});
