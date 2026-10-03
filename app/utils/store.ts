import { create } from "zustand";
import { combine, persist, createJSONStorage } from "zustand/middleware";
import type { PersistOptions } from "zustand/middleware";
import { Updater } from "../typing";
import { deepClone } from "./clone";
import { indexedDBStorage } from "@/app/utils/indexedDB-storage";

type MakeUpdater<T> = {
  lastUpdateTime: number;
  _hasHydrated: boolean;

  markUpdate: () => void;
  update: Updater<T>;
  setHasHydrated: (state: boolean) => void;
};

type SetStoreState<T> = (
  partial: T | Partial<T> | ((state: T) => T | Partial<T>),
  replace?: false,
) => void;

export function createPersistStore<T extends object, M>(
  state: T,
  methods: (set: SetStoreState<T & MakeUpdater<T>>, get: () => T & MakeUpdater<T>) => M,
  persistOptions: PersistOptions<T & M & MakeUpdater<T>>,
) {
  type Store = T & M & MakeUpdater<T>;
  const oldOnRehydrateStorage = persistOptions.onRehydrateStorage;
  const options: PersistOptions<Store> = {
    ...persistOptions,
    storage: createJSONStorage<Store>(() => indexedDBStorage),
    onRehydrateStorage: (state) => {
      const oldOnFinishHydration = oldOnRehydrateStorage?.(state);
      return (rehydratedState, error) => {
        oldOnFinishHydration?.(rehydratedState, error);
        state.setHasHydrated(true);
      };
    },
  };

  return create(
    persist(
      combine(
        {
          ...state,
          lastUpdateTime: 0,
          _hasHydrated: false,
        },
        (set, get) =>
          ({
            ...methods(set, get as () => T & MakeUpdater<T>),

            markUpdate() {
              set({ lastUpdateTime: Date.now() } as Partial<Store>);
            },
            update(updater: Updater<T>) {
              const currentState = deepClone(get());
              updater(currentState);
              set({
                ...currentState,
                lastUpdateTime: Date.now(),
              });
            },
            setHasHydrated(hydrated: boolean) {
              set({ _hasHydrated: hydrated } as Partial<Store>);
            },
          }) as M & MakeUpdater<T>,
      ),
      options as any,
    ),
  );
}
