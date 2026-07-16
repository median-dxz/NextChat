import { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../app/store/prompt", () => ({
  usePromptStore: () => ({ search: vi.fn() }),
}));

vi.mock("../app/components/markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

import {
  PromptHints,
  shouldShowMessageActions,
  useInitialChatScrollState,
  useScrollToBottom,
} from "../app/components/chat";
import { ReasoningDisclosure } from "../app/components/reasoning";

const originalScrollTo = HTMLElement.prototype.scrollTo;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  vi.restoreAllMocks();
});

describe("chat interaction regressions", () => {
  test("shows actions for a stopped reasoning-only assistant message", () => {
    expect(
      shouldShowMessageActions(
        {
          id: "assistant-1",
          date: "",
          role: "assistant",
          content: "",
          reasoning: "partial reasoning",
          streaming: false,
        },
        1,
        false,
      ),
    ).toBe(true);
  });

  test("automatically expands when reasoning starts and collapses when final content starts", async () => {
    const { container, rerender } = render(
      <ReasoningDisclosure reasoning="" content="" />,
    );

    rerender(<ReasoningDisclosure reasoning="step one" content="" />);
    const details = container.querySelector("details");
    await waitFor(() => expect(details?.open).toBe(true));

    rerender(
      <ReasoningDisclosure
        reasoning="step one"
        content="answer"
        reasoningDurationMs={65_000}
      />,
    );

    await waitFor(() => expect(details?.open).toBe(false));
    expect(container.querySelector("summary")?.textContent).toBe(
      "Thought for 1 min 05 sec",
    );
  });

  test("shows live reasoning time while the model is thinking", () => {
    vi.useFakeTimers();
    const { container } = render(
      <ReasoningDisclosure reasoning="step one" content="" streaming />,
    );

    act(() => vi.advanceTimersByTime(65_000));

    expect(container.querySelector("summary")?.textContent).toBe(
      "Thinking… (1 min 05 sec)",
    );
  });

  test("uses the same completed label after a final answer or an interruption", () => {
    const { container, rerender } = render(
      <ReasoningDisclosure
        reasoning="step one"
        content="answer"
        streaming
        reasoningDurationMs={12_000}
      />,
    );
    expect(container.querySelector("summary")?.textContent).toBe(
      "Thought for 12 sec",
    );

    rerender(
      <ReasoningDisclosure
        reasoning="step one"
        content=""
        streaming={false}
        reasoningDurationMs={12_000}
      />,
    );
    expect(container.querySelector("summary")?.textContent).toBe(
      "Thought for 12 sec",
    );
  });

  test("does not override a user's manual toggle with later reasoning chunks", async () => {
    const { container, rerender } = render(
      <ReasoningDisclosure reasoning="step one" content="" />,
    );
    const details = container.querySelector("details");
    expect(details?.open).toBe(true);

    if (!details) throw new Error("reasoning details was not rendered");
    details.open = false;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(details.open).toBe(false));

    rerender(<ReasoningDisclosure reasoning="step one\nstep two" content="" />);

    await waitFor(() => expect(details.open).toBe(false));
  });

  test("keeps a reasoning-only response visible after a fresh mount", () => {
    const firstRender = render(
      <ReasoningDisclosure reasoning="reasoning only" content="" />,
    );
    expect(firstRender.container.querySelector("details")?.open).toBe(true);
    expect(firstRender.getByText("reasoning only")).toBeTruthy();

    firstRender.unmount();
    const refreshedRender = render(
      <ReasoningDisclosure reasoning="reasoning only" content="" />,
    );

    expect(refreshedRender.container.querySelector("details")?.open).toBe(true);
    expect(refreshedRender.getByText("reasoning only")).toBeTruthy();
  });

  test("starts detached from the unmeasured bottom state so mount can scroll", () => {
    const { result } = renderHook(() => useInitialChatScrollState());

    expect(result.current.isScrolledToBottom).toBe(false);
    expect(result.current.isAttachWithTop).toBe(false);
  });

  test("scrolls the chat container to its measured bottom on mount", async () => {
    const scrollTo = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1200,
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    function Harness() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const { isScrolledToBottom, isAttachWithTop } =
        useInitialChatScrollState();
      useScrollToBottom(scrollRef, isScrolledToBottom || isAttachWithTop, []);

      return <div ref={scrollRef} />;
    }

    HTMLElement.prototype.scrollTo = scrollTo;
    render(<Harness />);

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith(0, 1200);
    });
  });

  test("resets prompt selection when the result set changes", () => {
    const onPromptSelect = vi.fn();
    const initialPrompts = Array.from({ length: 6 }, (_, index) => ({
      title: `old-${index}`,
      content: `old content ${index}`,
    }));
    const nextPrompts = Array.from({ length: 5 }, (_, index) => ({
      title: `new-${index}`,
      content: `new content ${index}`,
    }));
    const { getByText, rerender } = render(
      <PromptHints prompts={initialPrompts} onPromptSelect={onPromptSelect} />,
    );

    fireEvent.mouseEnter(getByText("old-4"));
    rerender(
      <PromptHints prompts={nextPrompts} onPromptSelect={onPromptSelect} />,
    );
    fireEvent.keyDown(window, { key: "Enter" });

    expect(onPromptSelect).toHaveBeenCalledWith(nextPrompts[0]);
  });
});
