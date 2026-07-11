import { jest } from "@jest/globals";
import { createPersistStore } from "../app/utils/store";

describe("createPersistStore", () => {
  test("marks hydration complete and preserves the configured finish callback", async () => {
    const onFinishHydration = jest.fn();
    const useTestStore = createPersistStore(
      { count: 0 },
      (set) => ({
        increment: () => set((state) => ({ count: state.count + 1 })),
      }),
      {
        name: "persist-store-hydration-test",
        skipHydration: true,
        onRehydrateStorage: () => onFinishHydration,
      },
    );

    expect(useTestStore.getState()._hasHydrated).toBe(false);

    await useTestStore.persist.rehydrate();

    expect(onFinishHydration).toHaveBeenCalledWith(
      expect.objectContaining({ _hasHydrated: false }),
      undefined,
    );
    expect(useTestStore.getState()._hasHydrated).toBe(true);
  });
});
