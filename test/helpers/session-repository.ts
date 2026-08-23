import { Conversation } from "../../app/utils/conversation";

export function createInMemorySessionStore<T extends { id: string }>(initialSessions: T[]) {
  const sessions = new Map(
    initialSessions.map((session) => [session.id, structuredClone(session)]),
  );

  return {
    getSession(sessionId: string) {
      return sessions.get(sessionId);
    },
    mutateSession(sessionId: string, updater: (session: T) => void) {
      const current = sessions.get(sessionId);
      if (!current) return;
      const draft = structuredClone(current);
      updater(draft);
      sessions.set(sessionId, draft);
    },
    updateSession(
      sessionId: string,
      updater: (session: T & { conversation: Conversation.Api }) => void | false,
    ) {
      const current = sessions.get(sessionId);
      if (!current) return;
      const draft = Object.assign(structuredClone(current), {
        conversation: Conversation(current as T & Conversation.State),
      });
      if (updater(draft) === false) return;
      const { conversation, ...session } = draft;
      sessions.set(sessionId, {
        ...session,
        ...conversation.state,
      } as unknown as T);
    },
    updateConversation(
      sessionId: string,
      updater: (conversation: Conversation.Api) => Conversation.Api | undefined,
    ) {
      const current = sessions.get(sessionId);
      if (!current) return;
      const conversation = updater(Conversation(current as T & Conversation.State));
      if (!conversation) return;
      sessions.set(sessionId, { ...current, ...conversation.state });
    },
  };
}
