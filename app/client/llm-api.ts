import type { ServiceProviderName } from "../constant";
import type { ChatOptions, LLMModel, LLMUsage, SpeechOptions } from "./api";
import { createProviderHeaders } from "./provider-headers";

export abstract class LLMApi {
  abstract readonly providerName: ServiceProviderName;

  getHeaders(): Record<string, string> {
    return createProviderHeaders(this.providerName);
  }

  abstract chat(options: ChatOptions): Promise<void>;
  abstract speech(options: SpeechOptions): Promise<ArrayBuffer>;
  abstract usage(): Promise<LLMUsage>;
  abstract models(): Promise<LLMModel[]>;
}
