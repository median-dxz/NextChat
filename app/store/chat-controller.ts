import { create } from "zustand";

interface ChatControllerState {
  runs: Map<string, () => void | Promise<void>>;
  register(messageId: string, cancel: () => void | Promise<void>): () => boolean;
  cancel(messageId: string): void | Promise<void>;
  cancelAll(): void;
}

// Only live chat requests belong here; this state is never persisted or synced.
export const useChatControllerStore = create<ChatControllerState>((set, get) => ({
  runs: new Map(),
  register(messageId, cancel) {
    // Cancel any previous run for this messageId
    const oldCancel = get().runs.get(messageId);
    void oldCancel?.();

    set((state) => ({ runs: new Map(state.runs).set(messageId, cancel) }));
    return () => {
      if (get().runs.get(messageId) !== cancel) return false;
      set((state) => {
        const runs = new Map(state.runs);
        runs.delete(messageId);
        return { runs };
      });
      return true;
    };
  },
  cancel(messageId) {
    return get().runs.get(messageId)?.();
  },
  cancelAll() {
    get().runs.forEach((cancel) => cancel());
  },
}));
