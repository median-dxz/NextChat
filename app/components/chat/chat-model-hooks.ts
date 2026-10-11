import { useEffect } from "react";
import isEqual from "lodash-es/isEqual";
import { ServiceProvider } from "../../constant";
import type { ChatSession, ModelConfig, useAppConfig, useChatStore } from "../../store";
import type { useAllModels } from "../../utils/hooks";
import { showToast } from "../ui-lib";

export function useEnsureAvailableModel(
  chatStore: Pick<ReturnType<typeof useChatStore.getState>, "updateSession">,
  config: Pick<ReturnType<typeof useAppConfig.getState>, "modelConfig" | "update">,
  session: ChatSession,
  models: ReadonlyArray<ReturnType<typeof useAllModels>[number]>,
) {
  const currentModel = session.mask.modelConfig.model;
  const syncGlobalConfig = session.mask.syncGlobalConfig;
  const globalModel = config.modelConfig.model;
  const globalProviderName = config.modelConfig.providerName;
  const updateConfig = config.update;

  useEffect(() => {
    const isUnavailableModel = !models.some((model) => {
      return model.name === currentModel;
    });
    if (!isUnavailableModel || models.length === 0) return;

    const nextModel = models.find((model) => model.isDefault) ?? models[0];
    if (!nextModel) return;

    const nextProviderName = (nextModel.provider?.providerName ??
      ServiceProvider.OpenAI) as ServiceProvider;

    if (syncGlobalConfig) {
      // Global config owns synced sessions; repair it once and let
      // useSyncGlobalModelConfig propagate the valid model downstream.
      if (globalModel === nextModel.name && globalProviderName === nextProviderName) {
        return;
      }
      updateConfig((config) => {
        config.modelConfig.model = nextModel.name;
        config.modelConfig.providerName = nextProviderName;
      });
    } else {
      // A detached session owns its model and must not rewrite global config.
      chatStore.updateSession(session.id, (session) => {
        if (
          session.mask.modelConfig.model === nextModel.name &&
          session.mask.modelConfig.providerName === nextProviderName
        ) {
          return false;
        }
        session.mask.modelConfig.model = nextModel.name;
        session.mask.modelConfig.providerName = nextProviderName;
      });
    }
    showToast(
      nextModel.provider?.providerName == "ByteDance"
        ? (nextModel.displayName ?? nextModel.name)
        : nextModel.name,
    );
  }, [
    chatStore,
    currentModel,
    globalModel,
    globalProviderName,
    models,
    session.id,
    syncGlobalConfig,
    updateConfig,
  ]);
}

export function useSyncGlobalModelConfig(
  chatStore: Pick<ReturnType<typeof useChatStore.getState>, "updateSession">,
  session: ChatSession,
  modelConfig: ModelConfig,
) {
  useEffect(() => {
    if (!session.mask.syncGlobalConfig || isEqual(session.mask.modelConfig, modelConfig)) {
      return;
    }

    chatStore.updateSession(session.id, (session) => {
      if (!session.mask.syncGlobalConfig || isEqual(session.mask.modelConfig, modelConfig)) {
        return false;
      }

      session.mask.modelConfig = { ...modelConfig };
    });
  }, [chatStore, modelConfig, session.id, session.mask.modelConfig, session.mask.syncGlobalConfig]);
}
