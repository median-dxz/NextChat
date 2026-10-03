import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type ChatScrollState = "following" | "user-scrolling" | "detached";

export type BottomRequestReason = "send" | "button" | "session-switch" | "content-resize";

const USER_SCROLL_END_DELAY_MS = 120;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function isElementAtBottom(element: HTMLElement, threshold: number) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function useScrollToBottom(bottomThreshold = 10) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<ChatScrollState>("following");
  const generationRef = useRef(0);
  const pendingFrameRef = useRef<number | undefined>(undefined);
  const userScrollEndTimerRef = useRef<number | undefined>(undefined);
  const pointerDownRef = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const setState = useCallback((state: ChatScrollState) => {
    stateRef.current = state;
  }, []);

  const cancelPendingScroll = useCallback(() => {
    generationRef.current += 1;
    if (pendingFrameRef.current !== undefined) {
      cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = undefined;
    }
  }, []);

  const updateBottomGeometry = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return false;
    const atBottom = isElementAtBottom(element, bottomThreshold);
    setIsAtBottom(atBottom);
    return atBottom;
  }, [bottomThreshold]);

  const requestBottom = useCallback(
    (reason: BottomRequestReason) => {
      if (reason === "content-resize" && stateRef.current !== "following") {
        updateBottomGeometry();
        return;
      }

      if (reason !== "content-resize") setState("following");
      cancelPendingScroll();
      const generation = generationRef.current;
      pendingFrameRef.current = requestAnimationFrame(() => {
        pendingFrameRef.current = undefined;
        if (generation !== generationRef.current || stateRef.current !== "following") {
          return;
        }

        const element = scrollRef.current;
        if (!element) return;
        element.scrollTo(0, element.scrollHeight);
        setIsAtBottom(true);
      });
    },
    [cancelPendingScroll, setState, updateBottomGeometry],
  );

  const finishUserScroll = useCallback(() => {
    if (userScrollEndTimerRef.current !== undefined) {
      window.clearTimeout(userScrollEndTimerRef.current);
      userScrollEndTimerRef.current = undefined;
    }
    if (stateRef.current !== "user-scrolling") return;
    setState(updateBottomGeometry() ? "following" : "detached");
  }, [setState, updateBottomGeometry]);

  const scheduleUserScrollEnd = useCallback(() => {
    if (userScrollEndTimerRef.current !== undefined) {
      window.clearTimeout(userScrollEndTimerRef.current);
    }
    userScrollEndTimerRef.current = window.setTimeout(finishUserScroll, USER_SCROLL_END_DELAY_MS);
  }, [finishUserScroll]);

  const beginUserScroll = useCallback(() => {
    cancelPendingScroll();
    setState("user-scrolling");
    scheduleUserScrollEnd();
  }, [cancelPendingScroll, scheduleUserScrollEnd, setState]);

  const detach = useCallback(() => {
    cancelPendingScroll();
    setState("detached");
    updateBottomGeometry();
  }, [cancelPendingScroll, setState, updateBottomGeometry]);

  const handleScroll = useCallback(() => {
    updateBottomGeometry();
    if (stateRef.current === "user-scrolling") scheduleUserScrollEnd();
  }, [scheduleUserScrollEnd, updateBottomGeometry]);

  const handlePointerDown = useCallback(() => {
    pointerDownRef.current = true;
  }, []);

  const handlePointerMove = useCallback(() => {
    if (pointerDownRef.current) beginUserScroll();
  }, [beginUserScroll]);

  const handlePointerUp = useCallback(() => {
    pointerDownRef.current = false;
    scheduleUserScrollEnd();
  }, [scheduleUserScrollEnd]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (SCROLL_KEYS.has(event.key)) beginUserScroll();
    },
    [beginUserScroll],
  );

  const handleKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (SCROLL_KEYS.has(event.key)) scheduleUserScrollEnd();
    },
    [scheduleUserScrollEnd],
  );

  useEffect(() => {
    const onPointerMove = () => handlePointerMove();
    const onPointerUp = () => handlePointerUp();
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerup", onPointerUp, { passive: true });
    document.addEventListener("pointercancel", onPointerUp, { passive: true });
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      requestBottom("content-resize");
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [requestBottom]);

  useLayoutEffect(() => {
    requestBottom("session-switch");
    return () => {
      cancelPendingScroll();
      if (userScrollEndTimerRef.current !== undefined) {
        window.clearTimeout(userScrollEndTimerRef.current);
      }
    };
  }, [cancelPendingScroll, requestBottom]);

  return {
    scrollRef,
    contentRef,
    isAtBottom,
    requestBottom,
    detach,
    handleScroll,
    userScrollHandlers: {
      onWheel: beginUserScroll,
      onTouchMove: beginUserScroll,
      onTouchEnd: scheduleUserScrollEnd,
      onPointerDown: handlePointerDown,
      onKeyDown: handleKeyDown,
      onKeyUp: handleKeyUp,
    },
  };
}

export function getChatScrollUpdate({
  scrollTop,
  clientHeight,
  scrollHeight,
  isMobileScreen,
  previousScrollTop,
}: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  isMobileScreen: boolean;
  previousScrollTop: number;
}) {
  const bottomHeight = scrollTop + clientHeight;
  const edgeThreshold = clientHeight;
  const distanceFromBottom = scrollHeight - bottomHeight;
  const isTouchTopEdge = scrollTop <= edgeThreshold;
  const isTouchBottomEdge = bottomHeight >= scrollHeight - edgeThreshold;
  let pageDirection: -1 | 0 | 1 = 0;
  if (scrollTop < previousScrollTop && isTouchTopEdge) pageDirection = -1;
  else if (scrollTop > previousScrollTop && isTouchBottomEdge) pageDirection = 1;
  else if (scrollTop === previousScrollTop) {
    if (isTouchTopEdge && !isTouchBottomEdge) pageDirection = -1;
    else if (isTouchBottomEdge && !isTouchTopEdge) pageDirection = 1;
  }
  return {
    pageDirection,
    isHitBottom: distanceFromBottom <= (isMobileScreen ? 4 : 10),
    isScrolledToBottom: Math.abs(distanceFromBottom) <= 1,
  };
}
