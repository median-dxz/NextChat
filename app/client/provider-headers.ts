import { getClientConfig } from "../config/client";
import { ACCESS_CODE_PREFIX, ServiceProvider, type ServiceProviderName } from "../constant";
import { useAccessStore } from "../store/access";

export function getBearerToken(apiKey: string, noBearer = false): string {
  return validString(apiKey) ? `${noBearer ? "" : "Bearer "}${apiKey.trim()}` : "";
}

export function validString(value: string): boolean {
  return value?.length > 0;
}

export function createProviderHeaders(providerName: ServiceProviderName): Record<string, string> {
  const accessStore = useAccessStore.getState();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const clientConfig = getClientConfig();
  const isGoogle = providerName === ServiceProvider.Google;
  const isAzure = providerName === ServiceProvider.Azure;
  const isAnthropic = providerName === ServiceProvider.Anthropic;
  const isBaidu = providerName === ServiceProvider.Baidu;

  let apiKey: string;
  switch (providerName) {
    case ServiceProvider.OpenAI:
      apiKey = accessStore.openaiApiKey;
      break;
    case ServiceProvider.Google:
      apiKey = accessStore.googleApiKey;
      break;
    case ServiceProvider.Azure:
      apiKey = accessStore.azureApiKey;
      break;
    case ServiceProvider.Anthropic:
      apiKey = accessStore.anthropicApiKey;
      break;
    case ServiceProvider.ByteDance:
      apiKey = accessStore.bytedanceApiKey;
      break;
    case ServiceProvider.Alibaba:
      apiKey = accessStore.alibabaApiKey;
      break;
    case ServiceProvider.Moonshot:
      apiKey = accessStore.moonshotApiKey;
      break;
    case ServiceProvider.XAI:
      apiKey = accessStore.xaiApiKey;
      break;
    case ServiceProvider.DeepSeek:
      apiKey = accessStore.deepseekApiKey;
      break;
    case ServiceProvider.ChatGLM:
      apiKey = accessStore.chatglmApiKey;
      break;
    case ServiceProvider.SiliconFlow:
      apiKey = accessStore.siliconflowApiKey;
      break;
    case ServiceProvider.Iflytek:
      apiKey =
        accessStore.iflytekApiKey && accessStore.iflytekApiSecret
          ? `${accessStore.iflytekApiKey}:${accessStore.iflytekApiSecret}`
          : "";
      break;
    case ServiceProvider["302.AI"]:
      apiKey = accessStore.ai302ApiKey;
      break;
    case ServiceProvider.Baidu:
    case ServiceProvider.Tencent:
    case ServiceProvider.Stability:
      apiKey = "";
      break;
    default: {
      const unsupported: never = providerName;
      throw new Error(`Unsupported service provider: ${unsupported}`);
    }
  }

  if (isBaidu && clientConfig?.isApp) return headers;

  const authHeader = isAzure
    ? "api-key"
    : isAnthropic
      ? "x-api-key"
      : isGoogle
        ? "x-goog-api-key"
        : "Authorization";
  const bearerToken = getBearerToken(apiKey, isAzure || isAnthropic || isGoogle);

  if (bearerToken) {
    headers[authHeader] = bearerToken;
  } else if (accessStore.enabledAccessControl() && validString(accessStore.accessCode)) {
    headers.Authorization = getBearerToken(ACCESS_CODE_PREFIX + accessStore.accessCode);
  }

  return headers;
}
