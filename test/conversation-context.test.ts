import { describe, expect, test } from "vitest";

import { estimateRequestMessageTokens, getContextInputBudget } from "../app/utils/context-budget";
import { Conversation } from "../app/utils/conversation";
import {
  conversationNode,
  conversationState,
  generatedSummary,
  linearConversation,
} from "./fixtures/conversation";

const CURRENT_INPUT_CONTENT = "iiii";

function budgetForHistoryTokens(availableTokens: number) {
  const requestedOutputTokens = 1;
  const currentInputTokens = estimateRequestMessageTokens({ content: CURRENT_INPUT_CONTENT });
  for (let contextWindowTokens = 1; contextWindowTokens <= 10_000; contextWindowTokens += 1) {
    if (
      getContextInputBudget(contextWindowTokens, requestedOutputTokens) - currentInputTokens ===
      availableTokens
    ) {
      return { contextWindowTokens, requestedOutputTokens };
    }
  }
  throw new Error(`Cannot construct a history budget of ${availableTokens} tokens`);
}

function assembleHistory(
  graph: Conversation.State,
  options: {
    availableTokens: number;
    recentRawNodeCount: number;
    summaries: "enabled" | "disabled";
  },
) {
  const conversation = Conversation(graph).insert(
    Conversation.createNode({ role: "user", content: CURRENT_INPUT_CONTENT }),
  );
  const assembly = conversation.context.assemble({
    systemInputs: [],
    pinnedInputs: [],
    budget: budgetForHistoryTokens(options.availableTokens),
    recentRawNodeCount: options.recentRawNodeCount,
    summaries: options.summaries,
  });
  return assembly.messages.slice(0, -1);
}

describe("conversation context", () => {
  test("keeps the newest global raw suffix within the available budget", () => {
    const root = conversationNode({ id: "1A", role: "user", content: "aaaa" });
    const branchUser = conversationNode({
      id: "2A",
      role: "user",
      content: "bbbb",
      parentId: root.id,
      outlineLevel: 2,
    });
    const branchAssistant = conversationNode({
      id: "2B",
      role: "assistant",
      content: "cccc",
      parentId: branchUser.id,
      outlineLevel: 2,
    });
    root.activeBranchRootId = branchUser.id;
    const rootAssistant = conversationNode({
      id: "1B",
      role: "assistant",
      content: "dddd",
      parentId: root.id,
    });
    const graph = conversationState([root, branchUser, branchAssistant, rootAssistant], {
      activeCursorId: rootAssistant.id,
    });

    const history = assembleHistory(graph, {
      availableTokens: 2,
      recentRawNodeCount: 3,
      summaries: "enabled",
    });

    expect(history).toEqual([
      { role: "assistant", content: "cccc" },
      { role: "assistant", content: "dddd" },
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

    const history = assembleHistory(graph, {
      availableTokens: 2,
      recentRawNodeCount: 0,
      summaries: "enabled",
    });

    expect(history).toEqual([
      { role: "assistant", content: "c" },
      { role: "assistant", content: "s" },
    ]);
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
    const graph = conversationState([root, branchUser, branchAssistant, rootAssistant], {
      activeCursorId: rootAssistant.id,
    });

    const history = assembleHistory(graph, {
      availableTokens: 2,
      recentRawNodeCount: 0,
      summaries: "enabled",
    });

    expect(history).toEqual([
      { role: "assistant", content: "x" },
      { role: "assistant", content: "x" },
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
    const invalidGraph = structuredClone(graph);
    invalidGraph.messages[1].nodeSummaries!.segment!.sourceNodeIds = ["missing", "b"];
    const assemble = (state: Conversation.State) =>
      assembleHistory(state, {
        availableTokens: 8,
        recentRawNodeCount: 0,
        summaries: "enabled",
      });

    expect(assemble(graph)).toEqual([{ role: "assistant", content: "stale available" }]);
    expect(assemble(invalidGraph)).toEqual([]);
  });

  test("assembles fixed inputs, planned history, and current input once", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "old question" },
      { id: "b", role: "assistant", content: "old answer" },
      { id: "current", role: "user", content: "now" },
    ]);
    const context = Conversation(graph).context.assemble({
      systemInputs: [Conversation.createMessage({ role: "system", content: "system" })],
      pinnedInputs: [Conversation.createMessage({ role: "user", content: "pinned" })],
      globalMemoryInput: Conversation.createMessage({ role: "system", content: "memory" }),
      budget: { contextWindowTokens: 32_000, requestedOutputTokens: 4_000 },
      recentRawNodeCount: 2,
      summaries: "enabled",
    });

    expect(context.messages).toEqual([
      { role: "system", content: "system" },
      { role: "system", content: "memory" },
      { role: "user", content: "pinned" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "now" },
    ]);
    expect(context.effectiveMaxOutputTokens).toBeLessThanOrEqual(4_000);
  });

  test("requires the cursor to identify a current user input", () => {
    const graph = linearConversation([
      { id: "a", role: "user", content: "question" },
      { id: "b", role: "assistant", content: "answer" },
    ]);

    expect(() =>
      Conversation(graph).context.assemble({
        systemInputs: [],
        pinnedInputs: [],
        budget: { contextWindowTokens: 32_000, requestedOutputTokens: 4_000 },
        recentRawNodeCount: 2,
        summaries: "enabled",
      }),
    ).toThrow("Conversation cursor must point to the current user input");
  });

  test("keeps the cursor input as a required suffix when history does not fit", () => {
    const graph = linearConversation([
      { id: "old", role: "user", content: "x".repeat(4_000) },
      { id: "current", role: "user", content: "now" },
    ]);

    const context = Conversation(graph).context.assemble({
      systemInputs: [],
      pinnedInputs: [],
      budget: { contextWindowTokens: 1_024, requestedOutputTokens: 128 },
      recentRawNodeCount: 0,
      summaries: "disabled",
    });

    expect(context.messages).toEqual([{ role: "user", content: "now" }]);
  });

  test("keeps a 250-node plan within the budget and compute limits", () => {
    const graph = linearConversation(
      Array.from({ length: 250 }, (_, index) => ({
        id: `n${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content:
          index % 10 === 0
            ? ([
                { type: "text" as const, text: "x".repeat(1_000) },
                {
                  type: "image_url" as const,
                  image_url: { url: `data:image/png;base64,${"a".repeat(2_000)}` },
                },
              ] as Conversation.ContentPart[])
            : "x".repeat(1_000),
      })),
    );
    for (let index = 1; index < graph.messages.length; index += 2) {
      graph.messages[index].nodeSummaries = {
        segment: generatedSummary(graph.messages.slice(index - 1, index + 1), "x"),
      };
    }

    // Thread CPU time isolates planner cost from other Vitest workers in this process.
    const startedAt = process.threadCpuUsage();
    const history = assembleHistory(graph, {
      availableTokens: 160,
      recentRawNodeCount: 8,
      summaries: "enabled",
    });
    const cpu = process.threadCpuUsage(startedAt);
    const duration = (cpu.user + cpu.system) / 1_000;

    expect(
      history.reduce((tokens, message) => tokens + estimateRequestMessageTokens(message), 0),
    ).toBeLessThanOrEqual(160);
    expect(duration).toBeLessThan(50);
  });
});
