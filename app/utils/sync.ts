import { useAccessStore, useAppConfig, useChatStore } from "../store";
import { useMaskStore } from "../store/mask";
import { usePromptStore } from "../store/prompt";
import { StoreKey } from "../constant";
import { Conversation } from "./conversation";
import { merge } from "./merge";

type NonFunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? never : K;
}[keyof T];
type NonFunctionFields<T> = Pick<T, NonFunctionKeys<T>>;

export function getNonFunctionFileds<T extends object>(obj: T) {
  const ret: any = {};

  Object.entries(obj).map(([k, v]) => {
    if (typeof v !== "function") {
      ret[k] = v;
    }
  });

  return ret as NonFunctionFields<T>;
}

export type GetStoreState<T> = T extends { getState: () => infer U }
  ? NonFunctionFields<U>
  : never;

const LocalStateSetters = {
  [StoreKey.Chat]: useChatStore.setState,
  [StoreKey.Access]: useAccessStore.setState,
  [StoreKey.Config]: useAppConfig.setState,
  [StoreKey.Mask]: useMaskStore.setState,
  [StoreKey.Prompt]: usePromptStore.setState,
} as const;

const LocalStateGetters = {
  [StoreKey.Chat]: () => getNonFunctionFileds(useChatStore.getState()),
  [StoreKey.Access]: () => getNonFunctionFileds(useAccessStore.getState()),
  [StoreKey.Config]: () => getNonFunctionFileds(useAppConfig.getState()),
  [StoreKey.Mask]: () => getNonFunctionFileds(useMaskStore.getState()),
  [StoreKey.Prompt]: () => getNonFunctionFileds(usePromptStore.getState()),
} as const;

export type AppState = {
  [k in keyof typeof LocalStateGetters]: ReturnType<
    (typeof LocalStateGetters)[k]
  >;
};

type Merger<T extends keyof AppState, U = AppState[T]> = (
  localState: U,
  remoteState: U,
) => U;

type StateMerger = {
  [K in keyof AppState]: Merger<K>;
};

// we merge remote state to local state
const MergeStates: StateMerger = {
  [StoreKey.Chat]: (localState, remoteState) => {
    const sessions = [...localState.sessions];
    const positions = new Map(
      sessions.map((session, index) => [session.id, index]),
    );
    const acceptCandidate = (
      candidate: (typeof sessions)[number],
      position?: number,
    ) => {
      try {
        Conversation(candidate).validate();
        if (position === undefined) {
          positions.set(candidate.id, sessions.push(candidate) - 1);
        } else {
          sessions[position] = candidate;
        }
      } catch (error) {
        console.warn("[Sync] Ignored invalid conversation merge", {
          sessionId: candidate.id,
          error,
        });
      }
    };

    remoteState.sessions.forEach((remoteSession) => {
      if (remoteSession.messages.length === 0) return;

      const position = positions.get(remoteSession.id);
      if (position === undefined) {
        acceptCandidate(remoteSession);
        return;
      }

      const localSession = sessions[position];
      const localMessageIds = new Set(
        localSession.messages.map((node) => node.id),
      );
      const missing = remoteSession.messages.filter(
        (node) => !localMessageIds.has(node.id),
      );
      if (missing.length === 0) return;

      const candidate = {
        ...localSession,
        messages: [...localSession.messages, ...missing],
      };
      acceptCandidate(candidate, position);
    });

    return {
      ...localState,
      sessions: sessions.toSorted(
        (a, b) =>
          new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime(),
      ),
    };
  },
  [StoreKey.Prompt]: (localState, remoteState) => {
    localState.prompts = {
      ...remoteState.prompts,
      ...localState.prompts,
    };
    return localState;
  },
  [StoreKey.Mask]: (localState, remoteState) => {
    localState.masks = {
      ...remoteState.masks,
      ...localState.masks,
    };
    return localState;
  },
  [StoreKey.Config]: mergeWithUpdate<AppState[StoreKey.Config]>,
  [StoreKey.Access]: mergeWithUpdate<AppState[StoreKey.Access]>,
};

export function getLocalAppState() {
  const appState = Object.fromEntries(
    Object.entries(LocalStateGetters).map(([key, getter]) => {
      return [key, getter()];
    }),
  ) as AppState;

  return appState;
}

export function setLocalAppState(appState: AppState) {
  (Object.keys(LocalStateSetters) as Array<keyof AppState>).forEach((key) => {
    const setter = LocalStateSetters[key] as (
      state: AppState[typeof key],
    ) => void;
    setter(appState[key]);
  });
}

export function mergeAppState(localState: AppState, remoteState: AppState) {
  Object.keys(localState).forEach(<T extends keyof AppState>(k: string) => {
    const key = k as T;
    const localStoreState = localState[key];
    const remoteStoreState = remoteState[key];
    Object.assign(localState, {
      [key]: MergeStates[key](localStoreState, remoteStoreState),
    });
  });

  return localState;
}

/**
 * Merge state with `lastUpdateTime`, older state will be override
 */
export function mergeWithUpdate<T extends { lastUpdateTime?: number }>(
  localState: T,
  remoteState: T,
) {
  const localUpdateTime = localState.lastUpdateTime ?? 0;
  const remoteUpdateTime = localState.lastUpdateTime ?? 1;

  if (localUpdateTime < remoteUpdateTime) {
    merge(remoteState, localState);
    return { ...remoteState };
  } else {
    merge(localState, remoteState);
    return { ...localState };
  }
}
