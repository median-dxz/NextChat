import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../../store/chat";
import {
  ChatSessionEditor,
  ExcludedNodeEditError,
  type ChatSessionEditorCommand,
} from "../../store/chat-session-editor";
import Locale from "../../locales";
import { Conversation } from "../../utils/conversation";
import { showToast } from "../ui-lib";

interface EditScope {
  editor: ChatSessionEditor;
  release(): void;
  summaryRequest: number;
}

export function useSessionEditor(onClose: () => void) {
  const [sessionId] = useState(() => useChatStore.getState().currentSession().id);
  const session = useChatStore((store) => store.sessions.find((item) => item.id === sessionId));
  const [editor, setEditor] = useState<ChatSessionEditor>();
  const scope = useRef<EditScope | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [generatingKinds, setGeneratingKinds] = useState<Conversation.SummaryKind[]>([]);

  const publish = (current: EditScope, next: ChatSessionEditor) => {
    current.editor = next;
    setEditor(next);
  };

  const readDraftSession = () => {
    const current = scope.current;
    if (!current) return;

    const latest = useChatStore.getState().sessions.find((item) => item.id === sessionId);
    if (!latest) return;

    const draft = current.editor.prepareCommit({
      topic: latest.topic,
      conversation: Conversation(latest),
    });

    return { ...latest, ...draft.conversation.state, topic: draft.topic };
  };

  const close = () => {
    const current = scope.current;
    scope.current = undefined;
    current?.release();
    onCloseRef.current();
  };

  useEffect(() => {
    const lease = useChatStore.getState().beginSessionEdit(sessionId);
    const current: EditScope = { ...lease, summaryRequest: 0 };
    scope.current = current;
    setEditor(current.editor);

    const unsubscribe = useChatStore.subscribe((store) => {
      if (scope.current !== current) return;

      const latest = store.sessions.find((item) => item.id === sessionId);
      if (!latest || store.sessions[store.currentSessionIndex]?.id !== sessionId) {
        close();
        return;
      }
    });

    return () => {
      unsubscribe();
      if (scope.current === current) scope.current = undefined;
      current.release();
    };
  }, [sessionId]);

  const dispatch = (command: ChatSessionEditorCommand) => {
    const current = scope.current;
    if (!current) return;

    try {
      publish(current, current.editor.apply(command));
    } catch (error) {
      showToast(
        error instanceof ExcludedNodeEditError
          ? Locale.Chat.EditMessage.ExcludedNodeAffected
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  };

  const save = () => {
    const current = scope.current;
    if (!current) return;

    try {
      useChatStore.getState().updateSession(sessionId, (latest) => {
        const result = current.editor.prepareCommit(latest);
        latest.topic = result.topic;
        latest.conversation = result.conversation;
      });

      close();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const generateSummary = async (nodeId: string, kind?: Conversation.SummaryKind) => {
    const current = scope.current;
    if (!current || !session) return;

    const request = ++current.summaryRequest;
    const active = () => scope.current === current && current.summaryRequest === request;
    setGeneratingKinds(kind ? [kind] : ["segment", "checkpoint"]);

    try {
      await useChatStore.getState().requestNodeSummary(
        session,
        nodeId,
        true,
        kind,
        () => {
          if (!active()) return;

          const draft = readDraftSession();
          return draft ? Conversation(draft) : undefined;
        },
        (nodeId, kind, summary) => {
          if (!active()) return;

          publish(current, current.editor.apply({ type: "update-summary", nodeId, kind, summary }));
          setGeneratingKinds((kinds) => kinds.filter((item) => item !== kind));
        },
      );
    } catch (error) {
      if (active()) showToast(error instanceof Error ? error.message : String(error));
    } finally {
      if (active()) setGeneratingKinds([]);
    }
  };

  const view = editor
    ? {
        draft: editor.state,
        levelOptions: editor.levelOptions,
      }
    : {
        draft: undefined,
        levelOptions: undefined,
      };

  return {
    ...view,
    session,
    dispatch,
    readDraftSession,
    close,
    save,
    generateSummary,
    generatingKinds,
    get active() {
      return scope.current !== undefined;
    },
  };
}
