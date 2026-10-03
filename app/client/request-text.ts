import type { Conversation } from "@/app/utils/conversation";

import type { ClientApi, LLMConfig } from "./api";

export function requestText(
  api: ClientApi,
  messages: Conversation.MessageInput[],
  config: LLMConfig,
): Promise<string> {
  return new Promise((resolve, reject) => {
    api.llm.chat({
      messages: messages.map(({ role, content }) => ({ role, content })),
      config: {
        model: config.model,
        temperature: config.temperature,
        top_p: config.top_p,
        max_tokens: config.max_tokens,
        presence_penalty: config.presence_penalty,
        frequency_penalty: config.frequency_penalty,
        stream: false,
      },
      onReasoningUpdate() {},
      onFinish(message, response) {
        if (response?.status === 200) {
          resolve(message.trim());
          return;
        }

        reject(
          new Error(
            `Text request failed (${api.llm.providerName}/${config.model}, status ${response?.status ?? "unknown"})`,
          ),
        );
      },
      onError: reject,
    });
  });
}
