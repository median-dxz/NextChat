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
  test("locks a streaming turn and exposes actions after reasoning stops", () => {
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
    expect(
      shouldShowMessageActions(
        {
          ...messages[1],
          content: "",
          reasoning: "partial reasoning",
          streaming: false,
        },
        1,
        false,
      ),
    ).toBe(true);
  });

  test("derives pagination and bottom state from one scroll snapshot", () => {
    expect(
      getChatScrollUpdate({
        scrollTop: 20,
        previousScrollTop: 40,
        clientHeight: 1_000,
        scrollHeight: 2_000,
        isMobileScreen: false,
      }),
    ).toEqual(
      expect.objectContaining({
        pageDirection: -1,
        isHitBottom: false,
        isScrolledToBottom: false,
      }),
    );
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

  test("follows the full reasoning disclosure lifecycle without overriding a manual close", async () => {
    const { container, rerender, getByText } = render(
      <ReasoningDisclosure reasoning="" content="" />,
    );

    rerender(<ReasoningDisclosure reasoning="step one" content="" />);
    const details = container.querySelector("details");
    await waitFor(() => expect(details?.open).toBe(true));
    expect(getByText("step one")).toBeTruthy();

    if (!details) throw new Error("reasoning details was not rendered");
    details.open = false;
    fireEvent(details, new Event("toggle"));
    rerender(
      <ReasoningDisclosure reasoning="step one\nstep two" content="" />,
    );
    await waitFor(() => expect(details.open).toBe(false));

    rerender(
      <ReasoningDisclosure
        reasoning="step one\nstep two"
        content="answer"
        reasoningDurationMs={65_000}
      />,
    );
    expect(container.querySelector("summary")?.textContent).toBe(
      "Thought for 1 min 05 sec",
    );
    expect(details.open).toBe(false);

    rerender(
      <ReasoningDisclosure
        reasoning="step one\nstep two"
        content=""
        streaming={false}
        reasoningDurationMs={65_000}
      />,
    );
    expect(container.querySelector("summary")?.textContent).toBe(
      "Thought for 1 min 05 sec",
    );
  });

  test("updates live reasoning time while the model is thinking", () => {
    vi.useFakeTimers();
    const { container } = render(
      <ReasoningDisclosure reasoning="step one" content="" streaming />,
    );

    act(() => vi.advanceTimersByTime(65_000));

    expect(container.querySelector("summary")?.textContent).toBe(
      "Thinking… (1 min 05 sec)",
    );
  });

  test("coalesces bottom requests and cancels pending work on user scroll", () => {
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
    const scrollTo = vi.fn();
    const element = document.createElement("div");
    let scrollHeight = 1_200;
    Object.defineProperty(element, "scrollHeight", {
      get: () => scrollHeight,
    });
    element.scrollTo = scrollTo;
    const { result } = renderHook(() => useScrollToBottom());
    result.current.scrollRef.current = element;
    act(runFrames);
    scrollTo.mockClear();

    act(() => result.current.requestBottom("send"));
    act(() => result.current.requestBottom("button"));
    scrollHeight = 1_450;
    act(runFrames);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1_450);

    scrollTo.mockClear();
    act(() => result.current.requestBottom("send"));
    act(() => result.current.userScrollHandlers.onWheel());
    act(runFrames);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("follows from mount through resize, detachment, and bottom recovery", () => {
    vi.useFakeTimers();
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
    let scrollTop = 900;
    let scrollHeight = 1_200;
    let controls: ReturnType<typeof useScrollToBottom>;

    function Harness() {
      controls = useScrollToBottom();
      return (
        <div
          ref={(element) => {
            if (!element) return;
            Object.defineProperties(element, {
              scrollTop: {
                configurable: true,
                get: () => scrollTop,
                set: (value) => (scrollTop = value),
              },
              scrollHeight: {
                configurable: true,
                get: () => scrollHeight,
              },
              clientHeight: { configurable: true, value: 300 },
            });
            element.scrollTo = scrollTo;
            controls.scrollRef.current = element;
          }}
          onWheel={controls.userScrollHandlers.onWheel}
        >
          <div ref={controls.contentRef} />
        </div>
      );
    }

    const view = render(<Harness />);
    expect(scrollTo).toHaveBeenCalledWith(0, 1_200);

    scrollTo.mockClear();
    act(notifyResize);
    expect(scrollTo).toHaveBeenCalledWith(0, 1_200);

    fireEvent.wheel(view.container.firstElementChild!);
    scrollTop = 500;
    act(() => controls.handleScroll());
    act(() => vi.advanceTimersByTime(120));
    scrollTo.mockClear();
    scrollHeight = 1_300;
    act(notifyResize);
    expect(scrollTo).not.toHaveBeenCalled();

    scrollTop = 1_000;
    act(() => controls.userScrollHandlers.onWheel());
    act(() => controls.handleScroll());
    act(() => vi.advanceTimersByTime(120));
    scrollHeight = 1_400;
    act(notifyResize);
    expect(scrollTo).toHaveBeenCalledWith(0, 1_400);
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
