import { describe, expect, test } from "vitest";
import {
  ConversationSummary,
  createContextProjection,
  createSummarySourceDigest,
  estimateRequestMessageTokens,
  getEffectiveMaxOutputTokens,
  getContextInputBudget,
  isSummaryCurrent,
  planConversationContext,
  planSummaryMaintenance,
} from "../app/utils/context-compression";

const message = (id: string, role: "user" | "assistant", content = "abcd") => ({
  id,
  role,
  content,
});

const summary = (
  id: string,
  sourceMessages: ReturnType<typeof message>[],
  kind: ConversationSummary["kind"] = "segment",
): ConversationSummary => ({
  id,
  kind,
  content: id,
  sourceEntryIds: sourceMessages.map((item) => item.id),
  sourceDigest: createSummarySourceDigest(sourceMessages),
  inputSummaryIds: [],
});

describe("context compression planner", () => {
  test("separates input window from output budget and safety reserve", () => {
    expect(getContextInputBudget(32_000, 4_000)).toBe(26_400);
  });

  test("keeps input space when the configured reply limit equals the window", () => {
    const inputBudget = getContextInputBudget(1_024, 1_024);
    const plan = planConversationContext({
      projection: createContextProjection([]),
      summaries: [],
      historyMessageCount: 4,
      contextWindowTokens: 1_024,
      maxOutputTokens: 1_024,
      fixedTokenCount: 20,
      currentInputTokenCount: 10,
    });

    expect(inputBudget).toBeGreaterThan(0);
    expect(getEffectiveMaxOutputTokens(1_024, 1_024, 30)).toBe(892);
    expect(plan.overflow).toBe(false);
  });

  test("does not count an image data URL as base64 text tokens", () => {
    expect(
      estimateRequestMessageTokens({
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${"A".repeat(200_000)}` },
          },
        ],
      }),
    ).toBeLessThan(2_000);
  });

  test("lets mandatory input use the reply reserve before reporting overflow", () => {
    const plan = planConversationContext({
      projection: createContextProjection([]),
      summaries: [],
      historyMessageCount: 4,
      contextWindowTokens: 1_024,
      maxOutputTokens: 1_024,
      fixedTokenCount: 0,
      currentInputTokenCount: 700,
    });

    expect(plan.overflow).toBe(false);
  });

  test("selects an old summary and recent complete turns without duplication", () => {
    const messages = [
      message("m1", "user", "a".repeat(4_000)),
      message("m2", "assistant", "b".repeat(4_000)),
      message("m3", "user"),
      message("m4", "assistant"),
    ];
    const plan = planConversationContext({
      projection: { entries: messages },
      summaries: [summary("s1", messages.slice(0, 2))],
      historyMessageCount: 2,
      contextWindowTokens: 2_000,
      maxOutputTokens: 200,
      fixedTokenCount: 10,
      currentInputTokenCount: 1,
    });

    expect(plan.selectedSummaryIds).toEqual(["s1"]);
    expect(plan.selectedMessageIds).toEqual(["m3", "m4"]);
  });

  test("uses a checkpoint without deleting its source segments", () => {
    const messages = [
      message("m1", "user", "a".repeat(4_000)),
      message("m2", "assistant", "b".repeat(4_000)),
      message("m3", "user", "c".repeat(4_000)),
      message("m4", "assistant", "d".repeat(4_000)),
      message("m5", "user"),
      message("m6", "assistant"),
    ];
    const s1 = summary("s1", messages.slice(0, 2));
    const s2 = summary("s2", messages.slice(2, 4));
    const s12 = summary("s12", messages.slice(0, 4), "checkpoint");
    s12.inputSummaryIds = ["s1", "s2"];

    const plan = planConversationContext({
      projection: createContextProjection(messages),
      summaries: [s1, s2, s12],
      historyMessageCount: 2,
      contextWindowTokens: 2_000,
      maxOutputTokens: 200,
      fixedTokenCount: 0,
      currentInputTokenCount: 1,
    });

    expect(plan.selectedSummaryIds).toEqual(["s12"]);
    expect(plan.selectedMessageIds).toEqual(["m5", "m6"]);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
  });

  test("combines a checkpoint, following segment, and recent raw turn", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message(
        `m${index + 1}`,
        index % 2 === 0 ? "user" : "assistant",
        index < 8 ? "x".repeat(4_000) : "abcd",
      ),
    );
    const checkpoint = summary(
      "checkpoint",
      messages.slice(0, 4),
      "checkpoint",
    );
    const segment = summary("segment", messages.slice(4, 8));

    const plan = planConversationContext({
      projection: createContextProjection(messages),
      summaries: [checkpoint, segment],
      historyMessageCount: 2,
      contextWindowTokens: 2_000,
      maxOutputTokens: 200,
      fixedTokenCount: 0,
      currentInputTokenCount: 1,
    });

    expect(plan.selectedSummaryIds).toEqual(["checkpoint", "segment"]);
    expect(plan.selectedMessageIds).toEqual(["m9", "m10"]);
  });

  test("honors tombstones and boundaries while preserving an orphan assistant", () => {
    const messages = [
      message("m1", "user"),
      message("m2", "assistant"),
      { ...message("m3", "user"), deletedAt: 1 },
      message("m4", "assistant"),
    ];
    const plan = planConversationContext({
      projection: createContextProjection(messages, "m2"),
      summaries: [],
      historyMessageCount: 10,
      contextWindowTokens: 2_000,
      maxOutputTokens: 200,
      fixedTokenCount: 0,
      currentInputTokenCount: 1,
    });

    expect(plan.selectedMessageIds).toEqual(["m4"]);
    expect(plan.requiresCompaction).toBe(false);
  });

  test("does not select summaries entirely before the context boundary", () => {
    const messages = [
      message("m1", "user", "x".repeat(4_000)),
      message("m2", "assistant", "y".repeat(4_000)),
      message("m3", "user"),
      message("m4", "assistant"),
    ];
    const plan = planConversationContext({
      projection: createContextProjection(messages, "m2"),
      summaries: [summary("s1", messages.slice(0, 2))],
      historyMessageCount: 2,
      contextWindowTokens: 2_000,
      maxOutputTokens: 200,
      fixedTokenCount: 0,
      currentInputTokenCount: 1,
    });

    expect(plan.selectedSummaryIds).toEqual([]);
    expect(plan.selectedMessageIds).toEqual(["m3", "m4"]);
  });

  test("reserves budget for the latest complete turn before old summaries", () => {
    const messages = [
      message("m1", "user", "x".repeat(4_000)),
      message("m2", "assistant", "y".repeat(4_000)),
      message("m3", "user", "a".repeat(800)),
      message("m4", "assistant", "a".repeat(200)),
    ];
    const oldSummary = summary("s1", messages.slice(0, 2));
    oldSummary.content = "x".repeat(3_200);
    const plan = planConversationContext({
      projection: createContextProjection(messages),
      summaries: [oldSummary],
      historyMessageCount: 2,
      contextWindowTokens: 1_024,
      maxOutputTokens: 0,
      fixedTokenCount: 0,
      currentInputTokenCount: 1,
    });

    expect(plan.selectedMessageIds).toEqual(["m3", "m4"]);
    expect(plan.selectedSummaryIds).toEqual([]);
    expect(plan.requiresCompaction).toBe(true);
  });

  test("reports overflow when mandatory input cannot fit", () => {
    const plan = planConversationContext({
      projection: createContextProjection([]),
      summaries: [],
      historyMessageCount: 4,
      contextWindowTokens: 1_000,
      maxOutputTokens: 400,
      fixedTokenCount: 100,
      currentInputTokenCount: 850,
    });

    expect(plan.overflow).toBe(true);
  });

  test("lets summaries expire naturally when their source projection changes", () => {
    const messages = [message("m1", "user"), message("m2", "assistant")];
    const stored = summary("s1", messages);
    const edited = [messages[0], { ...messages[1], content: "edited" }];
    const reordered = [...messages].reverse();

    expect(isSummaryCurrent(stored, createContextProjection(messages))).toBe(
      true,
    );
    expect(isSummaryCurrent(stored, createContextProjection(edited))).toBe(
      false,
    );
    expect(
      isSummaryCurrent(stored, createContextProjection([messages[0]])),
    ).toBe(false);
    expect(isSummaryCurrent(stored, { entries: reordered })).toBe(false);
  });

  test("summarizes the uncovered node outside the recent window", () => {
    const messages = [message("m1", "user"), message("m2", "assistant")];

    expect(
      planSummaryMaintenance({
        projection: createContextProjection(messages),
        summaries: [],
        historyMessageCount: 1,
        inputBudget: 1_000,
        compressionThreshold: 0,
        force: false,
      }),
    ).toEqual(
      expect.objectContaining({ kind: "segment", sourceEntryIds: ["m1"] }),
    );
  });

  test("can compact one oversized recent turn when emergency planning must progress", () => {
    const messages = [
      message("m1", "user", "a".repeat(4_000)),
      message("m2", "assistant", "b".repeat(4_000)),
    ];

    expect(
      planSummaryMaintenance({
        projection: createContextProjection(messages),
        summaries: [],
        historyMessageCount: 1,
        inputBudget: 100,
        compressionThreshold: 100,
        force: true,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "segment",
        sourceEntryIds: ["m1"],
      }),
    );
  });
});
