import { useEffect, useRef, useState } from "react";
import Locale from "../locales";
import { Markdown } from "./markdown";
import styles from "./chat.module.scss";

export interface ReasoningDisclosureProps {
  reasoning?: string;
  content: string;
  streaming?: boolean;
  reasoningDurationMs?: number;
}

export function ReasoningDisclosure({
  content,
  reasoning = "",
  streaming,
  reasoningDurationMs,
}: ReasoningDisclosureProps) {
  const isThinking =
    reasoning.length > 0 && Boolean(streaming) && content.trim().length === 0;
  const [open, setOpen] = useState(
    reasoning.length > 0 && content.trim().length === 0,
  );
  const [liveDurationMs, setLiveDurationMs] = useState(0);
  const timerStartedAt = useRef<number | null>(null);
  const hadReasoning = useRef(reasoning.length > 0);
  const hadContent = useRef(content.trim().length > 0);

  useEffect(() => {
    const hasReasoning = reasoning.length > 0;
    const hasContent = content.trim().length > 0;

    if (!hadReasoning.current && hasReasoning) {
      setOpen(true);
    }
    if (!hadContent.current && hasContent) {
      setOpen(false);
    }

    hadReasoning.current = hasReasoning;
    hadContent.current = hasContent;
  }, [content, reasoning]);

  useEffect(() => {
    if (!isThinking) {
      timerStartedAt.current = null;
      return;
    }

    timerStartedAt.current ??= Date.now();
    const updateDuration = () => {
      setLiveDurationMs(Date.now() - (timerStartedAt.current ?? Date.now()));
    };
    updateDuration();
    const timer = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(timer);
  }, [isThinking]);

  if (!reasoning) return null;

  return (
    <details
      className={styles["chat-message-reasoning"]}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {isThinking
          ? Locale.Chat.ReasoningThinking(
              formatReasoningDuration(liveDurationMs),
            )
          : Locale.Chat.ReasoningThought(
              reasoningDurationMs === undefined
                ? undefined
                : formatReasoningDuration(reasoningDurationMs),
            )}
      </summary>
      <div className={styles["chat-message-reasoning-content"]}>
        <Markdown content={reasoning} defaultShow />
      </div>
    </details>
  );
}

function formatReasoningDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return Locale.Chat.ReasoningDuration(minutes, seconds);
}
