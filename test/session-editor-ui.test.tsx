import { act, cleanup, fireEvent, render, renderHook, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../app/store/prompt", () => ({ usePromptStore: () => ({ search: vi.fn() }) }));
vi.mock("../app/components/markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { NodeViewerModal } from "../app/components/chat";
import { EditMessageModal } from "../app/components/chat/edit-message-modal";
import { useSessionEditor } from "../app/components/chat/session-editor";
import { useChatStore } from "../app/store/chat";
import { ChatGPTApi } from "../app/client/platforms/openai";
import { ServiceProvider } from "../app/constant";
import { Conversation } from "../app/utils/conversation";
import { generatedSummary, linearConversation } from "./fixtures/conversation";
import Locale from "../app/locales";

const original = useChatStore.getState();

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
    },
  });

  const session = {
    ...structuredClone(original.sessions[0]),
    ...linearConversation([
      { id: "u", role: "user", content: "saved question" },
      { id: "a", role: "assistant", content: "saved answer" },
    ]),
    topic: "saved title",
  };

  useChatStore.setState({ sessions: [session], currentSessionIndex: 0 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;

  useChatStore.setState({
    sessions: original.sessions,
    currentSessionIndex: original.currentSessionIndex,
  });
});

function EditorHost({
  onClose,
  nodeId,
  onPin = () => {},
}: {
  onClose(): void;
  nodeId?: string;
  onPin?(message: Conversation.Message): void;
}) {
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    onClose();
  };
  if (!open) return null;
  return nodeId ? (
    <NodeViewerModal nodeId={nodeId} onClose={close} onPin={onPin} />
  ) : (
    <EditMessageModal onClose={close} />
  );
}

describe("session editor lifecycle", () => {
  test("generation disables input and Save while Cancel invalidates late results", async () => {
    const provider = vi.spyOn(ChatGPTApi.prototype, "chat").mockResolvedValue(undefined);
    const saved = structuredClone(useChatStore.getState().currentSession());
    saved.mask.modelConfig.compressModel = "summary-model";
    saved.mask.modelConfig.compressProviderName = ServiceProvider.OpenAI;
    useChatStore.setState({ sessions: [saved] });

    const view = render(<EditorHost nodeId="a" onClose={vi.fn()} />);
    const segment = view.getByText(Locale.Chat.Graph.Segment).closest("details")!;
    fireEvent.click(
      within(segment).getByRole("button", { name: Locale.Chat.Graph.GenerateSummary }),
    );

    expect(view.getByDisplayValue("saved answer")).toBeDisabled();
    expect(view.getByRole("button", { name: Locale.Chat.Graph.Save })).toBeDisabled();
    expect(view.getByRole("button", { name: Locale.UI.Cancel })).toBeEnabled();

    fireEvent.click(view.getByRole("button", { name: Locale.UI.Cancel }));

    expect(view.queryByRole("dialog")).not.toBeInTheDocument();

    await act(async () => {
      provider.mock.calls[0][0].onFinish("late", new Response(null, { status: 200 }));
    });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().currentSession()).toEqual(saved);
  });

  test("saving a pinned input snapshots the draft and survives cancelling node edits", () => {
    const saved = structuredClone(useChatStore.getState().currentSession());
    const onPin = vi.fn((message: Conversation.Message) =>
      useChatStore.getState().updateSession(saved.id, (session) => {
        session.pinnedInputs.push(message);
      }),
    );

    const view = render(<EditorHost nodeId="a" onClose={vi.fn()} onPin={onPin} />);
    fireEvent.change(view.getByDisplayValue("saved answer"), {
      target: { value: "prompt draft" },
    });
    fireEvent.click(view.getByRole("button", { name: `${Locale.Chat.Graph.Role}: assistant` }));
    fireEvent.change(view.getByRole("combobox", { name: Locale.Chat.Graph.Role }), {
      target: { value: "system" },
    });
    fireEvent.click(view.getByRole("button", { name: Locale.Chat.Graph.SaveToPinned }));

    expect(onPin).toHaveBeenCalledWith(
      expect.objectContaining({ content: "prompt draft", role: "system" }),
    );
    expect(view.getByRole("dialog")).toBeInTheDocument();
    expect(useChatStore.getState().currentSession().messages).toEqual(saved.messages);
    fireEvent.change(view.getByDisplayValue("prompt draft"), {
      target: { value: "discarded answer" },
    });

    fireEvent.click(view.getByRole("button", { name: Locale.UI.Cancel }));

    expect(useChatStore.getState().currentSession().pinnedInputs.at(-1)?.content).toBe(
      "prompt draft",
    );
    expect(useChatStore.getState().currentSession().pinnedInputs.at(-1)?.role).toBe("system");
    expect(useChatStore.getState().currentSession().messages).toEqual(saved.messages);
  });

  test.each(["Cancel", "Escape"])("%s discards edits and releases the lease", (method) => {
    const saved = structuredClone(useChatStore.getState().currentSession());
    const closed = vi.fn();

    const view = render(
      <StrictMode>
        <EditorHost onClose={closed} />
      </StrictMode>,
    );
    fireEvent.input(view.getByDisplayValue("saved title"), {
      target: { value: "discarded title" },
    });
    fireEvent.change(view.getByDisplayValue("saved question"), {
      target: { value: "discarded question" },
    });

    const dialog = view.getByRole("dialog");
    if (method === "Cancel") fireEvent.click(view.getByRole("button", { name: Locale.UI.Cancel }));
    if (method === "Escape") {
      const input = view.getByDisplayValue("discarded question");
      act(() => input.focus());
      expect(input).toHaveFocus();

      expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);

      expect(input).not.toHaveFocus();
      expect(dialog).toBeInTheDocument();
      expect(closed).not.toHaveBeenCalled();
      expect(input).toHaveValue("discarded question");
      expect(useChatStore.getState().currentSession()).toEqual(saved);

      fireEvent(dialog, new Event("cancel", { cancelable: true }));
    }

    expect(closed).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().currentSession()).toEqual(saved);

    const lease = useChatStore.getState().beginSessionEdit(saved.id);
    lease.release();
  });

  test("Confirm preserves the completed reply and publishes local edits atomically", async () => {
    const provider = vi.spyOn(ChatGPTApi.prototype, "chat").mockResolvedValue(undefined);
    const saved = structuredClone(useChatStore.getState().currentSession());
    saved.mask.modelConfig.providerName = ServiceProvider.OpenAI;
    saved.mask.modelConfig.enableConversationSummaries = false;
    useChatStore.setState({ sessions: [saved] });
    const run = await useChatStore.getState().onUserInput("current question");
    const request = provider.mock.calls[0][0];
    request.onUpdate?.("partial answer", "partial answer");
    const closed = vi.fn();
    const view = render(<EditorHost onClose={closed} />);
    expect(view.queryByDisplayValue("partial answer")).not.toBeInTheDocument();
    expect(view.getByText(Locale.Chat.EditMessage.StreamingExcluded)).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: `${Locale.Chat.Actions.Delete} 3` }));
    expect(view.getByText(Locale.Chat.EditMessage.ExcludedNodeAffected)).toBeInTheDocument();
    expect(view.getByDisplayValue("current question")).toBeInTheDocument();

    await act(async () => {
      request.onReasoningUpdate?.("finished reasoning", "finished reasoning");
      request.onFinish("finished answer", new Response(null, { status: 200 }));
      await run.completion;
    });
    const finished = useChatStore
      .getState()
      .currentSession()
      .messages.find((node) => node.id === run.assistantNodeId)!;
    expect(finished).toMatchObject({
      content: "finished answer",
      reasoning: "finished reasoning",
      streaming: false,
    });
    expect(view.queryByDisplayValue("finished answer")).not.toBeInTheDocument();
    const published: Array<{ topic: string; content: Conversation.Content }> = [];
    const unsubscribe = useChatStore.subscribe((store) => {
      const session = store.currentSession();
      published.push({ topic: session.topic, content: session.messages[0].content });
    });

    try {
      fireEvent.input(view.getByDisplayValue("saved title"), {
        target: { value: "confirmed title" },
      });
      fireEvent.change(view.getByDisplayValue("saved question"), {
        target: { value: "confirmed question" },
      });

      expect(published).toEqual([]);

      fireEvent.click(view.getByRole("button", { name: Locale.UI.Confirm }));

      expect(published).toEqual([{ topic: "confirmed title", content: "confirmed question" }]);
      expect(
        useChatStore
          .getState()
          .currentSession()
          .messages.find((node) => node.id === run.assistantNodeId),
      ).toEqual(finished);
      expect(closed).toHaveBeenCalledTimes(1);

      const reopened = render(<EditorHost onClose={vi.fn()} />);
      expect(reopened.getByDisplayValue("finished answer")).toBeEnabled();
      expect(
        reopened.queryByText(Locale.Chat.EditMessage.StreamingExcluded),
      ).not.toBeInTheDocument();
    } finally {
      unsubscribe();
    }
  });

  test.each(["unmount", "switch"])("%s discards the draft and frees its session", (method) => {
    const saved = structuredClone(useChatStore.getState().currentSession());
    const onClose = vi.fn();

    const hook = renderHook(() => useSessionEditor(onClose), { wrapper: StrictMode });
    act(() => hook.result.current.dispatch({ type: "set-topic", topic: "discarded" }));

    if (method === "unmount") hook.unmount();
    if (method === "switch")
      act(() => {
        useChatStore.setState({
          sessions: [saved, { ...saved, id: "other" }],
          currentSessionIndex: 1,
        });
      });
    if (method !== "unmount") expect(onClose).toHaveBeenCalledTimes(1);
    const remaining = useChatStore.getState().sessions.find((item) => item.id === saved.id);
    expect(remaining).toEqual(saved);

    act(() => {
      useChatStore.setState({ sessions: [saved], currentSessionIndex: 0 });
    });
    const lease = useChatStore.getState().beginSessionEdit(saved.id);
    lease.release();
  });

  test("saving a generated summary after editing confirms the final source and preserves coverage", async () => {
    const provider = vi.spyOn(ChatGPTApi.prototype, "chat").mockResolvedValue(undefined);
    const saved = structuredClone(useChatStore.getState().currentSession());
    saved.mask.modelConfig.compressModel = "summary-model";
    saved.mask.modelConfig.compressProviderName = ServiceProvider.OpenAI;
    useChatStore.setState({ sessions: [saved] });
    const view = render(<EditorHost nodeId="a" onClose={vi.fn()} />);
    const segment = view.getByText(Locale.Chat.Graph.Segment).closest("details")!;

    fireEvent.click(
      within(segment).getByRole("button", { name: Locale.Chat.Graph.GenerateSummary }),
    );
    await act(async () => {
      provider.mock.calls[0][0].onFinish("generated summary", new Response(null, { status: 200 }));
    });

    const summaryInput = view.getByDisplayValue("generated summary");
    expect(summaryInput).toBeEnabled();
    fireEvent.change(summaryInput, { target: { value: " \n " } });
    expect(summaryInput).toHaveValue(" \n ");

    fireEvent.change(summaryInput, { target: { value: "manual summary" } });
    fireEvent.change(view.getByDisplayValue("saved answer"), {
      target: { value: "revised answer" },
    });
    fireEvent.click(view.getByRole("button", { name: Locale.Chat.Graph.Save }));

    const sources = saved.messages.map((node) =>
      node.id === "a" ? { ...node, content: "revised answer" } : node,
    );

    expect(
      Conversation(useChatStore.getState().currentSession()).node("a").value.nodeSummaries?.segment,
    ).toEqual(generatedSummary(sources, "manual summary", "user-edited"));
  });
});
