import { create } from "zustand";

interface ChatControllerState {
  runs: Map<string, () => void | Promise<void>>;
  register(messageId: string, cancel: () => void | Promise<void>): void;
  remove(messageId: string): void;
  cancel(messageId: string): void | Promise<void>;
  cancelAll(): void;
}

// Only live chat requests belong here; this state is never persisted or synced.
export const useChatControllerStore = create<ChatControllerState>((set, get) => ({
  runs: new Map(),
  register(messageId, cancel) {
    set((state) => ({ runs: new Map(state.runs).set(messageId, cancel) }));
  },
  remove(messageId) {
    set((state) => {
      const runs = new Map(state.runs);
      runs.delete(messageId);
      return { runs };
    });
  },
  cancel(messageId) {
    return get().runs.get(messageId)?.();
  },
  cancelAll() {
    get().runs.forEach((cancel) => cancel());
  },
}));
