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
  isMessageInStreamingTurn,
  PromptHints,
  shouldShowMessageActions,
} from "../app/components/chat";
import {
  getChatScrollUpdate,
  useScrollToBottom,
} from "../app/components/chat-scroll";
import { ReasoningDisclosure } from "../app/components/reasoning";

const originalScrollTo = HTMLElement.prototype.scrollTo;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  vi.restoreAllMocks();
});

describe("chat interaction regressions", () => {
  test("locks both messages in a turn while the assistant is streaming", () => {
    const messages = [
      { id: "u1", date: "", role: "user" as const, content: "question" },
      {
        id: "a1",
        date: "",
        role: "assistant" as const,
        content: "partial",
        streaming: true,
      },
    ];

    expect(isMessageInStreamingTurn(messages, 0)).toBe(true);
    expect(isMessageInStreamingTurn(messages, 1)).toBe(true);
  });

  test("derives pagination and bottom state from one scroll snapshot", () => {
    const update = getChatScrollUpdate({
      scrollTop: 20,
      previousScrollTop: 40,
      clientHeight: 1_000,
      scrollHeight: 2_000,
      isMobileScreen: false,
    });

    expect(update.pageDirection).toBe(-1);
    expect(update.isHitBottom).toBe(false);
    expect(update.isScrolledToBottom).toBe(false);

    expect(
      getChatScrollUpdate({
        scrollTop: 995,
        previousScrollTop: 990,
        clientHeight: 1_000,
        scrollHeight: 2_000,
        isMobileScreen: false,
      }),
    ).toEqual(
      expect.objectContaining({ isHitBottom: true, isScrolledToBottom: false }),
    );
  });

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
        reasoningDurationMs={65_000}
      />,
    );
    expect(container.querySelector("summary")?.textContent).toBe(
      "Thought for 1 min 05 sec",
    );

    rerender(
      <ReasoningDisclosure
        reasoning="step one"
        content=""
        streaming={false}
        reasoningDurationMs={65_000}
      />,
    );
    expect(container.querySelector("summary")?.textContent).toBe(
      "Thought for 1 min 05 sec",
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

  test("renders a reasoning-only response expanded on mount", () => {
    const view = render(
      <ReasoningDisclosure reasoning="reasoning only" content="" />,
    );
    expect(view.container.querySelector("details")?.open).toBe(true);
    expect(view.getByText("reasoning only")).toBeTruthy();
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
      const { scrollRef, contentRef } = useScrollToBottom();

      return (
        <div ref={scrollRef}>
          <div ref={contentRef} />
        </div>
      );
    }

    HTMLElement.prototype.scrollTo = scrollTo;
    render(<Harness />);

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith(0, 1200);
    });
  });

  test("cancels a pending bottom scroll when user scrolling starts", () => {
    const scrollTo = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });

    const element = document.createElement("div");
    element.scrollTo = scrollTo;
    Object.defineProperty(element, "scrollHeight", { value: 1_200 });
    const { result } = renderHook(() => useScrollToBottom());
    result.current.scrollRef.current = element;

    act(() => result.current.requestBottom("send"));
    act(() => result.current.userScrollHandlers.onWheel());
    act(() => {
      for (const callback of frames.values()) callback(0);
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("coalesces bottom requests and reads the latest scroll height", () => {
    const scrollTo = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });

    const runFrames = () => {
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    };
    const element = document.createElement("div");
    element.scrollTo = scrollTo;
    let scrollHeight = 1_200;
    Object.defineProperty(element, "scrollHeight", {
      get: () => scrollHeight,
    });
    const { result } = renderHook(() => useScrollToBottom());
    result.current.scrollRef.current = element;

    act(runFrames);
    scrollTo.mockClear();
    act(() => result.current.requestBottom("send"));
    act(() => result.current.requestBottom("button"));
    scrollHeight = 1_450;
    act(runFrames);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 1_450);
  });

  test("follows content resize until a user scroll detaches", () => {
    let notifyResize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;

    function Harness() {
      const { scrollRef, contentRef, userScrollHandlers } = useScrollToBottom();
      return (
        <div ref={scrollRef} onWheel={userScrollHandlers.onWheel}>
          <div ref={contentRef} />
        </div>
      );
    }

    const view = render(<Harness />);
    scrollTo.mockClear();
    act(notifyResize);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fireEvent.wheel(view.container.firstElementChild!);
    scrollTo.mockClear();
    act(notifyResize);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("resumes following after user scrolling settles at the bottom", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const element = document.createElement("div");
    const scrollTo = vi.fn();
    let scrollTop = 900;
    let scrollHeight = 1_200;
    Object.defineProperties(element, {
      scrollTop: { get: () => scrollTop, set: (value) => (scrollTop = value) },
      scrollHeight: { get: () => scrollHeight },
      clientHeight: { get: () => 300 },
    });
    element.scrollTo = scrollTo;
    const { result } = renderHook(() => useScrollToBottom());
    result.current.scrollRef.current = element;

    act(() => result.current.userScrollHandlers.onWheel());
    act(() => result.current.handleScroll());
    act(() => vi.advanceTimersByTime(120));

    scrollHeight = 1_300;
    act(() => result.current.requestBottom("content-resize"));
    expect(scrollTo).toHaveBeenCalledWith(0, 1_300);
  });

  test("does not treat a synthetic scroll event as user detachment", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const element = document.createElement("div");
    const scrollTo = vi.fn();
    Object.defineProperties(element, {
      scrollTop: { value: 600, writable: true },
      scrollHeight: { value: 1_300, writable: true },
      clientHeight: { value: 300 },
    });
    element.scrollTo = scrollTo;
    const { result } = renderHook(() => useScrollToBottom());
    result.current.scrollRef.current = element;

    act(() => result.current.requestBottom("send"));
    scrollTo.mockClear();
    act(() => result.current.handleScroll());
    act(() => result.current.requestBottom("content-resize"));

    expect(scrollTo).toHaveBeenCalledWith(0, 1_300);
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
