import type { ChatSession } from "../store/chat";
import type { ConversationSummary } from "../utils/context-compression";
import {
  createContextProjection,
  isSummaryCurrent,
} from "../utils/context-compression";
import Locale from "../locales";
import { useChatStore } from "../store";
import { IconButton } from "./button";
import styles from "./chat.module.scss";
import { List, ListItem } from "./ui-lib";

export function SessionSummaryList({
  session,
  onLocate,
}: {
  session: ChatSession;
  onLocate: (summary: ConversationSummary) => void;
}) {
  const chatStore = useChatStore();
  if (session.summaries.length === 0) return null;

  const projection = createContextProjection(
    session.messages,
    session.contextBoundaryAfterMessageId,
  );
  const messageNumbers = new Map(
    session.messages.map((message, index) => [message.id, index + 1]),
  );

  return (
    <List>
      {session.summaries.map((summary) => {
        const current = isSummaryCurrent(summary, projection);
        return (
          <ListItem
            key={summary.id}
            className={styles["summary-item"]}
            subTitle={
              <div>
                <div className={styles["summary-content"]}>
                  {summary.content}
                </div>
                <div className={styles["summary-meta"]}>
                  {Locale.Memory.SummaryRange(
                    summary.kind,
                    messageNumbers.get(summary.sourceEntryIds[0]) ?? 0,
                    messageNumbers.get(summary.sourceEntryIds.at(-1)!) ?? 0,
                  )}
                  {!current && (
                    <span className={styles["summary-expired"]}>
                      {` · ${Locale.Memory.Expired}`}
                    </span>
                  )}
                </div>
              </div>
            }
          >
            <div className={styles["summary-actions"]}>
              <IconButton
                text={Locale.Memory.Locate}
                bordered
                onClick={() => onLocate(summary)}
              />
              {current && (
                <IconButton
                  text={Locale.Memory.Recompress}
                  bordered
                  onClick={() =>
                    void chatStore.recompressSummary(session.id, summary.id)
                  }
                />
              )}
              <IconButton
                text={Locale.Memory.DeleteSummary}
                bordered
                onClick={() => chatStore.deleteSummary(session.id, summary.id)}
              />
            </div>
          </ListItem>
        );
      })}
    </List>
  );
}
