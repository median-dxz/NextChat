import { describe, expect, test } from "vitest";
import {
  ConversationSummary,
  createContextProjection,
  createSummarySourceDigest,
  estimateRequestMessageTokens,
  getContextInputBudget,
  getEffectiveMaxOutputTokens,
  isSummaryCurrent,
} from "../app/utils/context-compression";

const message = (id: string, role: "user" | "assistant", content = "abcd") => ({
  id,
  role,
  content,
});

describe("context compression primitives", () => {
  test("reserves adaptive input and output budgets for small and large windows", () => {
    expect(getContextInputBudget(32_000, 4_000)).toBe(26_400);
    expect(getContextInputBudget(1_024, 1_024)).toBeGreaterThan(0);
    expect(getEffectiveMaxOutputTokens(1_024, 1_024, 30)).toBe(892);
  });

  test("counts an image as a fixed request cost instead of its base64 length", () => {
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

  test("builds complete turns while allowing only a genuine leading assistant", () => {
    const leading = message("leading", "assistant");
    const user = message("user", "user");
    const answer = message("answer", "assistant");
    const deletedUser = { ...message("deleted", "user"), deletedAt: 1 };
    const orphan = message("orphan", "assistant");

    expect(
      createContextProjection([leading, user, answer, deletedUser, orphan])
        .entries,
    ).toEqual([leading, user, answer]);
    expect(createContextProjection([user, answer], "user").entries).toEqual([
      answer,
    ]);
  });

  test("expires summaries after source edits, removal, or reordering", () => {
    const messages = [message("m1", "user"), message("m2", "assistant")];
    const stored: ConversationSummary = {
      id: "s1",
      kind: "segment",
      content: "summary",
      sourceEntryIds: messages.map((item) => item.id),
      sourceDigest: createSummarySourceDigest(messages),
      inputSummaryIds: [],
    };

    expect(isSummaryCurrent(stored, createContextProjection(messages))).toBe(
      true,
    );
    expect(
      isSummaryCurrent(
        stored,
        createContextProjection([
          messages[0],
          { ...messages[1], content: "edited" },
        ]),
      ),
    ).toBe(false);
    expect(
      isSummaryCurrent(stored, { entries: [messages[1], messages[0]] }),
    ).toBe(false);
    expect(
      isSummaryCurrent(stored, { entries: [messages[1]] }),
    ).toBe(false);
  });
});
