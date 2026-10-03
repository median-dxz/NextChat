"use client";

import { getClientConfig } from "@/app/config/client";
import { ALIBABA_BASE_URL, Alibaba, ApiPath, ServiceProvider } from "@/app/constant";
import { useAccessStore } from "@/app/store";
import { getMessageText, getTimeoutMSByModel, isVisionModel } from "@/app/utils";
import { preProcessImageContentForAlibabaDashScope, streamWithThink } from "@/app/utils/chat";
import type { Conversation } from "@/app/utils/conversation";
import { fetch } from "@/app/utils/stream";

import type {
  ChatOptions,
  LLMModel,
  MultimodalContent,
  MultimodalContentForAlibaba,
  SpeechOptions,
} from "../api";
import { LLMApi } from "../llm-api";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    root: string;
  }>;
}

interface RequestInput {
  messages: {
    role: "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
}
interface RequestParam {
  result_format: string;
  incremental_output?: boolean;
  temperature: number;
  repetition_penalty?: number;
  top_p: number;
  max_tokens?: number;
}
interface RequestPayload {
  model: string;
  input: RequestInput;
  parameters: RequestParam;
}

export class QwenApi extends LLMApi {
  readonly providerName = ServiceProvider.Alibaba;
  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.alibabaUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      baseUrl = isApp ? ALIBABA_BASE_URL : ApiPath.Alibaba;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.Alibaba)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    return res?.output?.choices?.at(0)?.message?.content ?? "";
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    const modelConfig = options.config;

    const visionModel = isVisionModel(options.config.model);

    const messages: RequestInput["messages"] = [];
    for (const v of options.messages) {
      const content = (
        visionModel
          ? await preProcessImageContentForAlibabaDashScope(v.content)
          : getMessageText(v.content)
      ) as any;

      const role = v.role;
      messages.push({ role, content });
    }

    const shouldStream = !!options.config.stream;
    const requestPayload: RequestPayload = {
      model: modelConfig.model,
      input: {
        messages,
      },
      parameters: {
        result_format: "message",
        incremental_output: shouldStream,
        temperature: modelConfig.temperature,
        // max_tokens: modelConfig.max_tokens,
        top_p: modelConfig.top_p === 1 ? 0.99 : modelConfig.top_p, // qwen top_p is should be < 1
      },
    };

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const headers = {
        ...this.getHeaders(),
        "X-DashScope-SSE": shouldStream ? "enable" : "disable",
      };

      const chatPath = this.path(Alibaba.ChatPath(modelConfig.model));
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: headers,
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        getTimeoutMSByModel(options.config.model),
      );

      if (shouldStream) {
        const tools = options.tools?.definitions ?? [];
        const funcs = options.tools?.handlers ?? {};
        return streamWithThink(
          chatPath,
          requestPayload,
          headers,
          tools as any,
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: Conversation.MessageTool[]) => {
            // console.log("parseSSE", text, runTools);
            const json = JSON.parse(text);
            const choices = json.output.choices as Array<{
              message: {
                content: string | null | MultimodalContentForAlibaba[];
                tool_calls: Conversation.MessageTool[];
                reasoning_content: string | null;
              };
            }>;

            if (!choices?.length) return { isThinking: false, content: "" };

            const tool_calls = choices[0]?.message?.tool_calls;
            if (tool_calls?.length > 0) {
              const index = tool_calls[0]?.index;
              const id = tool_calls[0]?.id;
              const args = tool_calls[0]?.function?.arguments;
              if (id) {
                runTools.push({
                  id,
                  type: tool_calls[0]?.type,
                  function: {
                    name: tool_calls[0]?.function?.name as string,
                    arguments: args,
                  },
                });
              } else {
                // @ts-ignore
                runTools[index]["function"]["arguments"] += args;
              }
            }

            const reasoning = choices[0]?.message?.reasoning_content;
            const content = choices[0]?.message?.content;

            // Skip if both content and reasoning_content are empty or null
            if ((!reasoning || reasoning.length === 0) && (!content || content.length === 0)) {
              return {
                isThinking: false,
                content: "",
              };
            }

            if (reasoning && reasoning.length > 0) {
              return {
                isThinking: true,
                content: reasoning,
              };
            } else if (content && content.length > 0) {
              return {
                isThinking: false,
                content: Array.isArray(content)
                  ? content.map((item) => item.text).join(",")
                  : content,
              };
            }

            return {
              isThinking: false,
              content: "",
            };
          },
          // processToolMessage, include tool_calls message and tool call results
          (requestPayload: RequestPayload, toolCallMessage: any, toolCallResult: any[]) => {
            requestPayload?.input?.messages?.splice(
              requestPayload?.input?.messages?.length,
              0,
              toolCallMessage,
              ...toolCallResult,
            );
          },
          options,
        );
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message, res);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }
  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
export { Alibaba };
