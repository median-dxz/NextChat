import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/app/utils", () => ({
  safeLocalStorage: () => window.localStorage,
}));

import { DEFAULT_CONFIG, useAppConfig } from "../app/store/config";
import { indexedDBStorage } from "../app/utils/indexedDB-storage";

afterEach(() => {
  vi.restoreAllMocks();
  useAppConfig.setState({
    ...structuredClone(DEFAULT_CONFIG),
    _hasHydrated: true,
  });
});

describe("config store persistence", () => {
  test("migrates the formal v4.1 baseline directly to v4.2", async () => {
    const legacyState = structuredClone(DEFAULT_CONFIG) as any;
    const legacyModelConfig = legacyState.modelConfig;
    legacyModelConfig.sendMemory = false;
    legacyModelConfig.historyMessageCount = 7;
    legacyModelConfig.compressMessageLengthThreshold = 1800;

    for (const key of [
      "contextWindowTokens",
      "enableConversationSummaries",
      "recentRawNodeCount",
      "segmentTargetSourceTokens",
      "segmentMaxSourceNodes",
      "checkpointTargetSegments",
      "checkpointMergeTargetTokens",
      "titleModel",
      "titleProviderName",
      "memoryModel",
      "memoryProviderName",
    ]) {
      delete legacyModelConfig[key];
    }

    vi.spyOn(indexedDBStorage, "getItem").mockResolvedValue(
      JSON.stringify({
        state: {
          ...legacyState,
          _hasHydrated: true,
        },
        version: 4.1,
      }),
    );

    await useAppConfig.persist.rehydrate();

    const migrated = useAppConfig.getState().modelConfig;
    expect(migrated).toMatchObject({
      contextWindowTokens: DEFAULT_CONFIG.modelConfig.contextWindowTokens,
      enableConversationSummaries: false,
      recentRawNodeCount: 7,
      segmentTargetSourceTokens: 1800,
      segmentMaxSourceNodes: DEFAULT_CONFIG.modelConfig.segmentMaxSourceNodes,
      checkpointTargetSegments:
        DEFAULT_CONFIG.modelConfig.checkpointTargetSegments,
      checkpointMergeTargetTokens: 1800,
      titleModel: DEFAULT_CONFIG.modelConfig.titleModel,
      titleProviderName: DEFAULT_CONFIG.modelConfig.titleProviderName,
      memoryModel: DEFAULT_CONFIG.modelConfig.memoryModel,
      memoryProviderName: DEFAULT_CONFIG.modelConfig.memoryProviderName,
    });
    expect(migrated).not.toHaveProperty("historyMessageCount");
    expect(migrated).not.toHaveProperty("compressMessageLengthThreshold");
    expect(migrated).not.toHaveProperty("sendMemory");
  });
});
