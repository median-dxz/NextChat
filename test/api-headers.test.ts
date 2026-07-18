import { beforeEach, describe, expect, test } from "vitest";
import { getHeaders } from "../app/client/api";
import { ServiceProvider } from "../app/constant";
import { useAccessStore } from "../app/store/access";
import { useChatStore } from "../app/store/chat";

describe("provider authentication headers", () => {
  beforeEach(() => {
    useAccessStore.setState({
      openaiApiKey: "openai-key",
      googleApiKey: "google-key",
      azureApiKey: "azure-key",
      anthropicApiKey: "anthropic-key",
      bytedanceApiKey: "bytedance-key",
      alibabaApiKey: "alibaba-key",
      moonshotApiKey: "moonshot-key",
      xaiApiKey: "xai-key",
      deepseekApiKey: "deepseek-key",
      chatglmApiKey: "chatglm-key",
      siliconflowApiKey: "siliconflow-key",
      iflytekApiKey: "iflytek-key",
      iflytekApiSecret: "iflytek-secret",
      ai302ApiKey: "302-key",
    });
  });

  test.each([
    [ServiceProvider.OpenAI, "Authorization", "Bearer openai-key"],
    [ServiceProvider.Google, "x-goog-api-key", "google-key"],
    [ServiceProvider.Azure, "api-key", "azure-key"],
    [ServiceProvider.Anthropic, "x-api-key", "anthropic-key"],
    [ServiceProvider.ByteDance, "Authorization", "Bearer bytedance-key"],
    [ServiceProvider.Alibaba, "Authorization", "Bearer alibaba-key"],
    [ServiceProvider.Moonshot, "Authorization", "Bearer moonshot-key"],
    [ServiceProvider.XAI, "Authorization", "Bearer xai-key"],
    [ServiceProvider.DeepSeek, "Authorization", "Bearer deepseek-key"],
    [ServiceProvider.ChatGLM, "Authorization", "Bearer chatglm-key"],
    [
      ServiceProvider.SiliconFlow,
      "Authorization",
      "Bearer siliconflow-key",
    ],
    [
      ServiceProvider.Iflytek,
      "Authorization",
      "Bearer iflytek-key:iflytek-secret",
    ],
    [ServiceProvider["302.AI"], "Authorization", "Bearer 302-key"],
  ])("maps %s to its configured key and header", (provider, header, value) => {
    useChatStore.getState().currentSession().mask.modelConfig.providerName =
      provider;

    const headers = getHeaders();

    expect(headers[header]).toBe(value);
  });
});
