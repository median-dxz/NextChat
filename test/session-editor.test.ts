import { describe, expect, test } from "vitest";

import { ChatSessionEditor } from "../app/store/chat-session-editor";
import { Conversation } from "../app/utils/conversation";
import { generatedSummary, linearConversation } from "./fixtures/conversation";

const image = { type: "image_url" as const, image_url: { url: "https://example.test/image.png" } };

function session() {
  return {
    ...linearConversation([
      { id: "u", role: "user", content: [{ type: "text", text: "question" }, image] },
      { id: "a", role: "assistant", content: "answer" },
      { id: "tail", role: "user", content: "tail" },
    ]),
    topic: "saved title",
  };
}

describe("session editor", () => {
  test("keeps all edits local and preserves images when committing text", () => {
    const saved = session();
    const before = structuredClone(saved);

    const edit = ChatSessionEditor.open(saved)
      .apply({ type: "set-topic", topic: "draft title" })
      .apply({ type: "set-node-text", nodeId: "u", text: "edited question" })
      .apply({ type: "set-node-role", nodeId: "tail", role: "assistant" })
      .apply({ type: "swap-nodes", firstId: "u", secondId: "a" })
      .apply({ type: "insert-node", previousId: "tail" });

    expect(saved).toEqual(before);
    const result = edit.prepareCommit({ topic: saved.topic, conversation: Conversation(saved) });

    expect(result.topic).toBe("draft title");
    expect(result.conversation.node("u").value.content).toEqual([
      { type: "text", text: "edited question" },
      image,
    ]);
    expect(result.conversation.node("tail").value.role).toBe("assistant");
    expect(
      result.conversation
        .projectActive()
        .slice(0, 2)
        .map((node) => node.id),
    ).toEqual(["a", "u"]);
    expect(result.conversation.state.messages).toHaveLength(4);

    expect(saved).toEqual(before);
  });

  test("preserves automatic updates when draft fields are reverted", () => {
    const saved = session();
    saved.messages[1].nodeSummaries = {
      segment: generatedSummary(saved.messages.slice(0, 2), "original summary"),
    };
    const automatic = generatedSummary(saved.messages.slice(0, 2), "automatic summary");

    const edit = ChatSessionEditor.open(saved)
      .apply({ type: "set-topic", topic: "draft" })
      .apply({ type: "set-topic", topic: saved.topic })
      .apply({ type: "user-edit-summary", nodeId: "a", kind: "segment", content: "draft summary" })
      .apply({
        type: "user-edit-summary",
        nodeId: "a",
        kind: "segment",
        content: "original summary",
      });
    const result = edit.prepareCommit({
      topic: "automatic title",
      conversation: Conversation(saved).summaries.node("a").update("segment", automatic),
    });

    expect(result.topic).toBe("automatic title");
    expect(result.conversation.node("a").value.nodeSummaries?.segment).toEqual(automatic);
  });

  test("permits reordering earlier messages without changing the generating reply", () => {
    const saved = {
      ...linearConversation([
        { id: "u", role: "user", content: "first question" },
        { id: "a", role: "assistant", content: "first answer" },
        { id: "q", role: "user", content: "current question" },
        { id: "stream", role: "assistant", content: "partial", streaming: true },
      ]),
      topic: "saved title",
    };
    const edit = ChatSessionEditor.open(saved);
    const before = structuredClone(edit.state.conversation.state);
    const result = edit
      .apply({ type: "swap-nodes", firstId: "u", secondId: "a" })
      .prepareCommit({ topic: saved.topic, conversation: Conversation(saved) });

    expect(result.conversation.projectActive().map((node) => node.id)).toEqual([
      "a",
      "u",
      "q",
      "stream",
    ]);
    expect(result.conversation.node("stream").value).toEqual(saved.messages[3]);
    expect(edit.state.conversation.state).toEqual(before);
  });

  test("preserves generated source snapshots when node text is edited after generation", () => {
    const saved = session();
    const snapshot = generatedSummary(saved.messages.slice(0, 2));

    const edit = ChatSessionEditor.open(saved)
      .apply({ type: "update-summary", nodeId: "a", kind: "segment", summary: snapshot })
      .apply({ type: "set-node-text", nodeId: "a", text: "changed source" });
    const committed = edit.prepareCommit({
      topic: saved.topic,
      conversation: Conversation(saved),
    }).conversation;

    expect(committed.node("a").value.nodeSummaries?.segment).toEqual(snapshot);
  });

  test("removes blank summaries on save, preserves other kinds and strips summaries after role change", () => {
    const saved = session();
    const snapshot = generatedSummary(saved.messages.slice(0, 2));
    saved.messages[1].nodeSummaries = { segment: snapshot, checkpoint: snapshot };

    const edit = ChatSessionEditor.open(saved).apply({
      type: "user-edit-summary",
      nodeId: "a",
      kind: "segment",
      content: " \n ",
    });

    const committed = edit
      .prepareCommit({ topic: saved.topic, conversation: Conversation(saved) })
      .conversation.node("a").value.nodeSummaries;
    expect(committed?.segment).toBeUndefined();
    expect(committed?.checkpoint).toEqual(snapshot);

    const afterRoleChange = ChatSessionEditor.open(saved)
      .apply({ type: "set-node-role", nodeId: "a", role: "user" })
      .prepareCommit({ topic: saved.topic, conversation: Conversation(saved) })
      .conversation.node("a").value.nodeSummaries;
    expect(afterRoleChange?.segment).toBeUndefined();
    expect(afterRoleChange?.checkpoint).toBeUndefined();
  });
});
