import type { RequestMessage } from "./api";
import type { ConversationContextEntry } from "../utils/conversation/context";

export interface ProviderContextAdapter {
  materialize(entries: readonly ConversationContextEntry[]): RequestMessage[];
}

const defaultProviderContextAdapter: ProviderContextAdapter = {
  materialize(entries) {
    return entries.map((entry) => {
      if ("message" in entry) {
        return entry.message;
      }
      if (entry.kind === "raw") {
        return { role: entry.role, content: entry.content };
      }
      return { role: "assistant", content: entry.content };
    });
  },
};

export function getProviderContextAdapter(
  _providerName?: string,
): ProviderContextAdapter {
  return defaultProviderContextAdapter;
}
