import type { ClientApi, LLMConfig, ModelInputMessage } from "./api";
import type { ConversationMessageInput } from "../utils/conversation";

export function toModelInputMessages(
  messages: readonly ConversationMessageInput[],
): ModelInputMessage[] {
  return messages.map((message) => ({
    role:
      message.role === "system"
        ? "instruction"
        : message.role === "assistant"
          ? "model"
          : "user",
    content: message.content,
  }));
}

export function requestText(
  api: ClientApi,
  messages: ModelInputMessage[],
  config: LLMConfig,
  pluginIds: string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    api.llm.chat({
      messages,
      config: {
        ...config,
        stream: false,
      },
      pluginIds,
      onReasoningUpdate() {},
      onFinish(message, response) {
        if (response?.status === 200) {
          resolve(message.trim());
          return;
        }

        reject(
          new Error(
            `Text request failed (${config.providerName}/${config.model}, status ${response?.status ?? "unknown"})`,
          ),
        );
      },
      onError: reject,
    });
  });
}
