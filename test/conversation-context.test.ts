import { describe, expect, test } from "vitest";

import { Conversation, createMessage } from "../app/utils/conversation";
import {
  conversationNode,
  conversationState,
  generatedSummary,
  linearConversation,
} from "./fixtures/conversation";

describe("conversation context", () => {
  test("keeps the newest global raw suffix within the available budget", () => {
    const root = conversationNode({ id: "1A", role: "user", content: "xxxx" });
    const branchUser = conversationNode({
      id: "2A",
      role: "user",
      content: "xxxx",
      parentId: root.id,
      outlineLevel: 2,
    });
    const branchAssistant = conversationNode({
      id: "2B",
      role: "assistant",
      content: "xxxx",
      parentId: branchUser.id,
      outlineLevel: 2,
    });
    root.activeBranchRootId = branchUser.id;
    const rootAssistant = conversationNode({
      id: "1B",
      role: "assistant",
      content: "xxxx",
      parentId: root.id,
    });
    const graph = conversationState(
      [root, branchUser, branchAssistant, rootAssistant],
      { activeCursorId: rootAssistant.id },
    );

    const context = Conversation(graph).context.build({
      availableTokens: 2,
      recentRawNodeCount: 3,
      summaries: "enabled",
    });

    expect(context.entries.map((entry) => "nodeId" in entry && entry.nodeId)).toEqual([
      "2B",
      "1B",
    ]);
  });

  test("selects continuous non-overlapping mixed representations", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "xxxx" },
      { id: "b", role: "assistant", content: "xxxx" },
      { id: "c", role: "user", content: "xxxx" },
      { id: "d", role: "assistant", content: "xxxx" },
      { id: "e", role: "user", content: "xxxx" },
      { id: "f", role: "assistant", content: "xxxx" },
    ]);
    graph.messages[3].nodeSummaries = {
      checkpoint: generatedSummary(graph.messages.slice(0, 4), "c"),
    };
    graph.messages[5].nodeSummaries = {
      segment: generatedSummary(graph.messages.slice(4), "s"),
    };

    const context = Conversation(graph).context.build({
      availableTokens: 2,
      recentRawNodeCount: 0,
      summaries: "enabled",
    });

    expect(context.entries.map((entry) => entry.kind)).toEqual([
      "checkpoint",
      "segment",
    ]);
    const covered = context.entries.flatMap((entry) => {
      if ("sourceNodeIds" in entry) return entry.sourceNodeIds;
      if ("nodeId" in entry) return [entry.nodeId];
      return [];
    });
    expect(covered).toEqual(graph.messages.map((message) => message.id));
  });

  test("prefers fresh Segment coverage over an equally sized stale Checkpoint", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "xxxx" },
      { id: "b", role: "assistant", content: "xxxx" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages, "x"),
      checkpoint: {
        ...generatedSummary(graph.messages, "x"),
        sourceDigest: "stale",
      },
    };

    const context = Conversation(graph).context.build({
      availableTokens: 1,
      recentRawNodeCount: 0,
      summaries: "enabled",
    });

    expect(context.entries.map((entry) => entry.kind)).toEqual(["segment"]);
  });

  test("combines representations from interleaved Outline Chains", () => {
    const root = conversationNode({ id: "1A", role: "user", content: "xxxx" });
    const branchUser = conversationNode({
      id: "2A",
      role: "user",
      content: "xxxx",
      parentId: root.id,
      outlineLevel: 2,
    });
    const branchAssistant = conversationNode({
      id: "2B",
      role: "assistant",
      content: "xxxx",
      parentId: branchUser.id,
      outlineLevel: 2,
    });
    root.activeBranchRootId = branchUser.id;
    const rootAssistant = conversationNode({
      id: "1B",
      role: "assistant",
      content: "xxxx",
      parentId: root.id,
    });
    branchAssistant.nodeSummaries = {
      segment: generatedSummary([branchUser, branchAssistant], "x"),
    };
    rootAssistant.nodeSummaries = {
      segment: generatedSummary([root, rootAssistant], "x"),
    };
    const graph = conversationState(
      [root, branchUser, branchAssistant, rootAssistant],
      { activeCursorId: rootAssistant.id },
    );

    const context = Conversation(graph).context.build({
      availableTokens: 2,
      recentRawNodeCount: 0,
      summaries: "enabled",
    });

    expect(context.entries.map((entry) => entry.kind)).toEqual([
      "segment",
      "segment",
    ]);
  });

  test("excludes structurally invalid summaries but can use stale summaries", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "x".repeat(400) },
      { id: "b", role: "assistant", content: "x".repeat(400) },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: {
        ...generatedSummary(graph.messages, "stale available"),
        sourceDigest: "stale",
      },
    };
    const build = () =>
      Conversation(graph).context.build({
        availableTokens: 8,
        recentRawNodeCount: 0,
        summaries: "enabled",
      });

    expect(build().entries).toEqual([
      expect.objectContaining({ kind: "segment", content: "stale available" }),
    ]);
    graph.messages[1].nodeSummaries.segment!.sourceNodeIds = ["missing", "b"];
    expect(build().entries).toEqual([]);
  });

  test("assembles fixed inputs, planned history, and current input once", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "old question" },
      { id: "b", role: "assistant", content: "old answer" },
    ]);
    const context = Conversation(graph).context.assemble({
      systemInputs: [createMessage({ role: "system", content: "system" })],
      pinnedInputs: [createMessage({ role: "user", content: "pinned" })],
      globalMemoryInput: createMessage({ role: "system", content: "memory" }),
      currentInput: createMessage({ id: "current", role: "user", content: "now" }),
      budget: { contextWindowTokens: 32_000, requestedOutputTokens: 4_000 },
      recentRawNodeCount: 2,
      summaries: "enabled",
    });

    expect(context.entries.map((entry) => entry.kind)).toEqual([
      "fixed",
      "fixed",
      "fixed",
      "raw",
      "raw",
      "current",
    ]);
    expect(context.inputTokenCount).toBeGreaterThan(
      context.fixedTokenCount + context.historyTokenCount,
    );
    expect(context.effectiveMaxOutputTokens).toBeLessThanOrEqual(4_000);
  });

  test("matches a small-chain lexicographic oracle", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "xxxx" },
      { id: "b", role: "assistant", content: "xxxx" },
      { id: "c", role: "user", content: "xxxx" },
      { id: "d", role: "assistant", content: "xxxx" },
    ]);
    graph.messages[1].nodeSummaries = {
      segment: generatedSummary(graph.messages.slice(0, 2), "x"),
      checkpoint: {
        ...generatedSummary(graph.messages.slice(0, 2), "x"),
        sourceDigest: "stale",
      },
    };
    graph.messages[3].nodeSummaries = {
      segment: generatedSummary(graph.messages.slice(2), "x"),
    };
    const oracle = [
      { kinds: ["segment", "segment"], covered: 4, fresh: 4, raw: 0 },
      { kinds: ["checkpoint", "segment"], covered: 4, fresh: 2, raw: 0 },
      { kinds: ["raw", "raw"], covered: 2, fresh: 2, raw: 2 },
    ].sort(
      (left, right) =>
        right.covered - left.covered ||
        right.fresh - left.fresh ||
        right.raw - left.raw,
    )[0];

    const context = Conversation(graph).context.build({
      availableTokens: 2,
      recentRawNodeCount: 0,
      summaries: "enabled",
    });

    expect(context.entries.map((entry) => entry.kind)).toEqual(oracle.kinds);
  });

  test("keeps a 250-node plan within the public frontier and time limits", () => {
    const graph = linearConversation(
      Array.from({ length: 250 }, (_, index) => ({
        id: `n${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: "xx",
      })),
    );
    for (let index = 1; index < graph.messages.length; index += 2) {
      graph.messages[index].nodeSummaries = {
        segment: generatedSummary(graph.messages.slice(index - 1, index + 1), "x"),
      };
    }

    const startedAt = performance.now();
    const context = Conversation(graph).context.build({
      availableTokens: 160,
      recentRawNodeCount: 8,
      summaries: "enabled",
    });
    const duration = performance.now() - startedAt;

    expect(context.tokens).toBeLessThanOrEqual(160);
    expect(context.diagnostics.finalFrontierSize).toBeLessThanOrEqual(512);
    expect(context.diagnostics.maxCandidateCount).toBeGreaterThan(0);
    expect(duration).toBeLessThan(1_000);
  });
});
