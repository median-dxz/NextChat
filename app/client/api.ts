import type { Conversation } from "@/app/utils/conversation";

import { ServiceProvider, type ServiceProviderName } from "../constant";
import type { ModelType } from "../store/config";
import { ChatGPTApi, DalleRequestPayload } from "./platforms/openai";
import { GeminiProApi } from "./platforms/google";
import { ClaudeApi } from "./platforms/anthropic";
import { ErnieApi } from "./platforms/baidu";
import { DoubaoApi } from "./platforms/bytedance";
import { QwenApi } from "./platforms/alibaba";
import { HunyuanApi } from "./platforms/tencent";
import { MoonshotApi } from "./platforms/moonshot";
import { SparkApi } from "./platforms/iflytek";
import { DeepSeekApi } from "./platforms/deepseek";
import { XAIApi } from "./platforms/xai";
import { ChatGLMApi } from "./platforms/glm";
import { SiliconflowApi } from "./platforms/siliconflow";
import { Ai302Api } from "./platforms/ai302";
import { LLMApi } from "./llm-api";

export { LLMApi } from "./llm-api";
export { getBearerToken, validString } from "./provider-headers";

export const Models = ["gpt-3.5-turbo", "gpt-4"] as const;
export const TTSModels = ["tts-1", "tts-1-hd"] as const;
export type ChatModel = ModelType;

export type MultimodalContent = Conversation.ContentPart;

export interface MultimodalContentForAlibaba {
  text?: string;
  image?: string;
}

export interface LLMConfig {
  model: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  stream?: boolean;
  presence_penalty: number;
  frequency_penalty: number;
  size?: DalleRequestPayload["size"];
  quality?: DalleRequestPayload["quality"];
  style?: DalleRequestPayload["style"];
}

export interface SpeechOptions {
  model: string;
  input: string;
  voice: string;
  response_format?: string;
  speed?: number;
  onController?: (controller: AbortController) => void;
}

export interface ChatToolDefinition {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters: object;
  };
}

export interface ChatTools {
  definitions: ChatToolDefinition[];
  handlers: Record<string, Function>;
}

export interface ChatOptions {
  messages: Conversation.MessageInput[];
  config: LLMConfig;
  tools?: ChatTools;

  onUpdate?: (message: string, chunk: string) => void;
  onReasoningUpdate?: (reasoning: string, chunk: string) => void;
  onFinish: (message: string, responseRes: Response) => void;
  onError?: (err: Error) => void;
  onController?: (controller: AbortController) => void;
  onBeforeTool?: (tool: Conversation.MessageTool) => void;
  onAfterTool?: (tool: Conversation.MessageTool) => void;
}

export interface LLMUsage {
  used: number;
  total: number;
}

export interface LLMModel {
  name: string;
  displayName?: string;
  available: boolean;
  provider: LLMModelProvider;
  sorted: number;
}

export interface LLMModelProvider {
  id: string;
  providerName: string;
  providerType: string;
  sorted: number;
}

export class ClientApi {
  public llm: LLMApi;

  constructor(provider: ServiceProviderName = ServiceProvider.OpenAI) {
    switch (provider) {
      case ServiceProvider.Google:
        this.llm = new GeminiProApi();
        break;
      case ServiceProvider.Anthropic:
        this.llm = new ClaudeApi();
        break;
      case ServiceProvider.Baidu:
        this.llm = new ErnieApi();
        break;
      case ServiceProvider.ByteDance:
        this.llm = new DoubaoApi();
        break;
      case ServiceProvider.Alibaba:
        this.llm = new QwenApi();
        break;
      case ServiceProvider.Tencent:
        this.llm = new HunyuanApi();
        break;
      case ServiceProvider.Moonshot:
        this.llm = new MoonshotApi();
        break;
      case ServiceProvider.Iflytek:
        this.llm = new SparkApi();
        break;
      case ServiceProvider.DeepSeek:
        this.llm = new DeepSeekApi();
        break;
      case ServiceProvider.XAI:
        this.llm = new XAIApi();
        break;
      case ServiceProvider.ChatGLM:
        this.llm = new ChatGLMApi();
        break;
      case ServiceProvider.SiliconFlow:
        this.llm = new SiliconflowApi();
        break;
      case ServiceProvider["302.AI"]:
        this.llm = new Ai302Api();
        break;
      case ServiceProvider.OpenAI:
      case ServiceProvider.Azure:
        this.llm = new ChatGPTApi(provider);
        break;
      case ServiceProvider.Stability:
        throw new Error(`Unsupported chat provider: ${provider}`);
      default: {
        const unsupported: never = provider;
        throw new Error(`Unsupported service provider: ${unsupported}`);
      }
    }
  }

  config() {}

  prompts() {}

  masks() {}
}
