import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../../store/chat";
import type { useSessionEditor } from "./session-editor";
import { showToast } from "../ui-lib";

export function useTitleGeneration(
  edit: Pick<ReturnType<typeof useSessionEditor>, "active" | "readDraftSession" | "dispatch">,
) {
  const requestId = useRef(0);
  const [generatingTitle, setGeneratingTitle] = useState(false);

  const setTitle = (topic: string) => {
    requestId.current += 1;
    setGeneratingTitle(false);
    edit.dispatch({ type: "set-topic", topic });
  };

  useEffect(() => {
    return () => {
      requestId.current += 1;
    };
  }, []);

  const generateTitle = async () => {
    const request = ++requestId.current;
    const active = () => requestId.current === request && edit.active;

    try {
      const draft = edit.readDraftSession();
      if (!draft) return;

      setGeneratingTitle(true);
      const topic = await useChatStore.getState().requestSessionTitle(draft, true);

      if (active() && topic !== undefined) {
        edit.dispatch({ type: "set-topic", topic });
      }
    } catch (error) {
      if (active()) {
        showToast(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId.current === request) {
        setGeneratingTitle(false);
      }
    }
  };

  return { generateTitle, generatingTitle, setTitle };
}
