export function createSessionRepository<T extends { id: string }>(
  initialSessions: T[],
) {
  const sessions = new Map(
    initialSessions.map((session) => [session.id, structuredClone(session)]),
  );

  return {
    getSession(sessionId: string) {
      return sessions.get(sessionId);
    },
    updateSession(sessionId: string, updater: (session: T) => void) {
      const current = sessions.get(sessionId);
      if (!current) return;
      const draft = structuredClone(current);
      updater(draft);
      sessions.set(sessionId, draft);
    },
  };
}
