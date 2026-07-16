import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const streamMocks = vi.hoisted(() => ({
  handlers: [] as any[],
  fetchEventSource: vi.fn((_url: string, handlers: any) => {
    streamMocks.handlers.push(handlers);
    return Promise.resolve();
  }),
}));

vi.mock("@fortaine/fetch-event-source", () => ({
  EventStreamContentType: "text/event-stream",
  fetchEventSource: streamMocks.fetchEventSource,
}));

vi.mock("@/app/locales", () => ({
  default: { Error: { Unauthorized: "Unauthorized" } },
}));

vi.mock("@/app/utils/stream", () => ({ fetch: vi.fn() }));

import { streamWithThink } from "../app/utils/chat";

type StreamOptions = {
  onUpdate: ReturnType<typeof vi.fn>;
  onReasoningUpdate: ReturnType<typeof vi.fn>;
  onFinish: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onBeforeTool: ReturnType<typeof vi.fn>;
  onAfterTool: ReturnType<typeof vi.fn>;
};

const animationFrames: FrameRequestCallback[] = [];

function flushAnimationFrames(limit = 100) {
  for (let i = 0; i < limit && animationFrames.length > 0; i += 1) {
    animationFrames.shift()?.(i);
  }
}

function createOptions(): StreamOptions {
  return {
    onUpdate: vi.fn(),
    onReasoningUpdate: vi.fn(),
    onFinish: vi.fn(),
    onError: vi.fn(),
    onBeforeTool: vi.fn(),
    onAfterTool: vi.fn(),
  };
}

function createProcessToolMessageMock() {
  return vi.fn(
    (_requestPayload: any, _toolCallMessage: any, _toolCallResult: any[]) => {},
  );
}

function parseSSE(text: string, runTools: any[]) {
  const event = JSON.parse(text);
  if (event.tool) {
    runTools.push(event.tool);
    return { isThinking: false, content: "" };
  }
  return event;
}

async function openStream(handler: any) {
  await handler.onopen(
    new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
}

async function startStream(overrides?: {
  controller?: AbortController;
  funcs?: Record<string, Function>;
  processToolMessage?: ReturnType<typeof createProcessToolMessageMock>;
  options?: StreamOptions;
}) {
  const controller = overrides?.controller ?? new AbortController();
  const options = overrides?.options ?? createOptions();
  const processToolMessage =
    overrides?.processToolMessage ?? createProcessToolMessageMock();

  streamWithThink(
    "/chat",
    { messages: [] },
    {},
    [],
    overrides?.funcs ?? {},
    controller,
    parseSSE,
    processToolMessage,
    options,
  );

  await vi.waitFor(() =>
    expect(streamMocks.handlers.length).toBeGreaterThan(0),
  );
  const handler = streamMocks.handlers.at(-1);
  await openStream(handler);
  return { controller, handler, options, processToolMessage };
}

beforeEach(() => {
  streamMocks.handlers.length = 0;
  streamMocks.fetchEventSource.mockClear();
  animationFrames.length = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("streamWithThink reasoning lifecycle", () => {
  test("preserves the original output when no reasoning is present", async () => {
    const { handler, options } = await startStream();

    handler.onmessage({
      data: JSON.stringify({ isThinking: false, content: "plain answer" }),
    });
    handler.onmessage({ data: "[DONE]" });
    flushAnimationFrames();

    expect(options.onReasoningUpdate).not.toHaveBeenCalled();
    expect(options.onFinish).toHaveBeenCalledWith(
      "plain answer",
      expect.any(Response),
    );
    expect(options.onError).not.toHaveBeenCalled();
  });

  test("emits accumulated reasoning before accumulated final content", async () => {
    const { handler, options } = await startStream();

    handler.onmessage({
      data: JSON.stringify({ isThinking: true, content: "think" }),
    });
    flushAnimationFrames(10);
    expect(options.onReasoningUpdate).toHaveBeenLastCalledWith("think", "k");

    handler.onmessage({
      data: JSON.stringify({ isThinking: false, content: "answer" }),
    });
    flushAnimationFrames(10);
    expect(options.onUpdate).toHaveBeenLastCalledWith("answer", "r");
    expect(options.onReasoningUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      options.onUpdate.mock.invocationCallOrder[0],
    );

    handler.onmessage({ data: "[DONE]" });
    flushAnimationFrames();
    expect(options.onFinish).toHaveBeenCalledWith(
      "answer",
      expect.any(Response),
    );
    expect(options.onError).not.toHaveBeenCalled();
  });

  test("does not report a reasoning-only response as empty", async () => {
    const { handler, options } = await startStream();

    handler.onmessage({
      data: JSON.stringify({ isThinking: true, content: "reasoning only" }),
    });
    handler.onmessage({ data: "[DONE]" });
    flushAnimationFrames();

    expect(options.onReasoningUpdate).toHaveBeenLastCalledWith(
      "reasoning only",
      "reasoning only",
    );
    expect(options.onFinish).toHaveBeenCalledWith("", expect.any(Response));
    expect(options.onError).not.toHaveBeenCalled();
  });

  test("separates think tags split across streamed chunks", async () => {
    const { handler, options } = await startStream();

    for (const content of ["<thi", "nk>step</thi", "nk>answer"]) {
      handler.onmessage({
        data: JSON.stringify({ isThinking: false, content }),
      });
    }
    handler.onmessage({ data: "[DONE]" });
    flushAnimationFrames();

    expect(options.onReasoningUpdate).toHaveBeenLastCalledWith("step", "step");
    expect(options.onFinish).toHaveBeenCalledWith(
      "answer",
      expect.any(Response),
    );
    expect(options.onError).not.toHaveBeenCalled();
  });

  test("finishes with partial content when aborted", async () => {
    const controller = new AbortController();
    const { handler, options } = await startStream({ controller });

    handler.onmessage({
      data: JSON.stringify({ isThinking: false, content: "partial" }),
    });
    flushAnimationFrames(10);
    controller.abort();
    flushAnimationFrames();

    expect(options.onFinish).toHaveBeenCalledTimes(1);
    expect(options.onFinish).toHaveBeenCalledWith(
      "partial",
      expect.any(Response),
    );
    expect(options.onError).not.toHaveBeenCalled();
  });

  test("restarts the stream after completing a tool call", async () => {
    const processToolMessage = createProcessToolMessageMock();
    const tool = {
      id: "tool-1",
      function: { name: "lookup", arguments: "{}" },
    };
    const lookup = vi.fn().mockResolvedValue({ status: 200, data: "result" });
    const { handler, options } = await startStream({
      funcs: { lookup },
      processToolMessage,
    });

    handler.onmessage({ data: JSON.stringify({ tool }) });
    handler.onmessage({ data: "[DONE]" });

    await vi.waitFor(() => expect(processToolMessage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(streamMocks.handlers).toHaveLength(2), {
      timeout: 1000,
    });
    const restartedHandler = streamMocks.handlers[1];
    await openStream(restartedHandler);
    restartedHandler.onmessage({
      data: JSON.stringify({ isThinking: false, content: "after tool" }),
    });
    restartedHandler.onmessage({ data: "[DONE]" });
    flushAnimationFrames();

    expect(options.onBeforeTool).toHaveBeenCalledWith(tool);
    expect(options.onAfterTool).toHaveBeenCalledWith({
      ...tool,
      content: "result",
      isError: false,
    });
    expect(options.onFinish).toHaveBeenCalledWith(
      "after tool",
      expect.any(Response),
    );
  });
});
