import { useRef } from "react";
import {
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

import {
  PromptHints,
  useInitialChatScrollState,
  useScrollToBottom,
} from "../app/components/chat";

const originalScrollTo = HTMLElement.prototype.scrollTo;

afterEach(() => {
  cleanup();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  vi.restoreAllMocks();
});

describe("chat interaction regressions", () => {
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
