import type { LLMModel } from "../client/api";

export function getModelKey(model: Pick<LLMModel, "name" | "provider">) {
  const providerId = model.provider?.id ?? model.provider?.providerName ?? "unknown";
  return `${model.name}@${providerId}`;
}

export function mergeModelLists(
  baseModels: readonly LLMModel[],
  overrideModels: readonly LLMModel[],
) {
  const modelMap = new Map<string, LLMModel>();

  baseModels.forEach((model) => {
    modelMap.set(getModelKey(model), model);
  });

  overrideModels.forEach((model) => {
    modelMap.set(getModelKey(model), model);
  });

  return Array.from(modelMap.values());
}
