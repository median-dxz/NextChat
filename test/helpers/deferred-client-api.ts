import type { ChatOptions, ClientApi } from "../../app/client/api";

export function createDeferredClientApi() {
  const requests: ChatOptions[] = [];
  const controllers: AbortController[] = [];
  const api = {
    llm: {
      chat(options: ChatOptions) {
        requests.push(options);
        const controller = new AbortController();
        controllers.push(controller);
        options.onController?.(controller);
      },
    },
  } as unknown as ClientApi;

  return {
    api,
    requests,
    controllers,
    finish(index: number, message: string, status = 200) {
      requests[index].onFinish(message, new Response(null, { status }));
    },
    fail(index: number, error: Error) {
      requests[index].onError?.(error);
    },
    update(index: number, message: string, chunk = message) {
      requests[index].onUpdate?.(message, chunk);
    },
    reasoning(index: number, message: string, chunk = message) {
      requests[index].onReasoningUpdate?.(message, chunk);
    },
  };
}
