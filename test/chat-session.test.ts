import { describe, expect, test } from "vitest";

import type { ChatMessage } from "../app/store/chat";
import {
  getVisibleMessages,
  mergeEditedMessagesWithTombstones,
  runResendTransaction,
} from "../app/utils/chat-session";

const message = (
  id: string,
  role: ChatMessage["role"],
  content = id,
): ChatMessage => ({ id, date: "", role, content });

describe("chat session operations", () => {
  test("hides tombstones while preserving them through editing", () => {
    const visible = message("u1", "user", "old");
    const tombstone = { ...message("a1", "assistant", ""), deletedAt: 1 };
    const edited = { ...visible, content: "edited" };

    expect(getVisibleMessages([visible, tombstone])).toEqual([visible]);
    expect(
      mergeEditedMessagesWithTombstones([visible, tombstone], [edited]),
    ).toEqual([edited, tombstone]);
  });

  const firstTurn = [
    message("u1", "user", "one"),
    message("a1", "assistant", "one"),
  ];
  const secondTurn = [
    message("u2", "user", "two"),
    message("a2", "assistant", "two"),
  ];

  test.each([
    {
      name: "retries an assistant from its user input",
      messages: firstTurn,
      target: "a1",
      boundary: undefined,
      expected: {
        textContent: "one",
        images: [],
        remainingMessages: [],
        contextBoundaryAfterMessageId: undefined,
      },
    },
    {
      name: "truncates descendants",
      messages: [...firstTurn, ...secondTurn],
      target: "a1",
      boundary: "a2",
      expected: {
        textContent: "one",
        images: [],
        remainingMessages: [],
        contextBoundaryAfterMessageId: undefined,
      },
    },
    {
      name: "moves a truncated boundary to the retained prefix",
      messages: [...firstTurn, ...secondTurn],
      target: "a2",
      boundary: "a2",
      expected: {
        textContent: "two",
        images: [],
        remainingMessages: firstTurn,
        contextBoundaryAfterMessageId: "a1",
      },
    },
    {
      name: "does not cross a tombstone to find a user input",
      messages: [
        ...firstTurn,
        { ...message("u2", "user", ""), deletedAt: 1 },
        message("a2", "assistant", "two"),
      ],
      target: "a2",
      boundary: undefined,
      expected: undefined,
    },
  ])("$name", async ({ messages, target, boundary, expected }) => {
    const updates: Array<{ messages: ChatMessage[]; boundary?: string }> = [];
    const resends: Array<{ textContent: string; images: string[] }> = [];
    const result = await runResendTransaction({
      messages,
      targetMessageId: target,
      contextBoundaryAfterMessageId: boundary,
      update(nextMessages, nextBoundary) {
        updates.push({ messages: nextMessages, boundary: nextBoundary });
      },
      async resend(textContent, images) {
        resends.push({ textContent, images });
      },
    });

    expect(result).toEqual(expected);
    expect(updates).toEqual(
      expected
        ? [
            {
              messages: expected.remainingMessages,
              boundary: expected.contextBoundaryAfterMessageId,
            },
          ]
        : [],
    );
    expect(resends).toEqual(
      expected
        ? [{ textContent: expected.textContent, images: expected.images }]
        : [],
    );
  });

  test("restores messages and boundary when retry startup fails", async () => {
    const updates: Array<{ messages: ChatMessage[]; boundary?: string }> = [];

    await expect(
      runResendTransaction({
        messages: firstTurn,
        targetMessageId: "a1",
        contextBoundaryAfterMessageId: "a1",
        update(messages, boundary) {
          updates.push({ messages, boundary });
        },
        resend: async () => {
          throw new Error("startup failed");
        },
      }),
    ).rejects.toThrow("startup failed");

    expect(updates).toEqual([
      { messages: [], boundary: undefined },
      { messages: firstTurn, boundary: "a1" },
    ]);
  });
});
