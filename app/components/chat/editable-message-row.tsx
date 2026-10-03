import { useState, type CSSProperties } from "react";
import { Draggable } from "@hello-pangea/dnd";
import clsx from "clsx";
import AddIcon from "../../icons/add.svg";
import DeleteIcon from "../../icons/clear.svg";
import DragIcon from "../../icons/drag.svg";
import Locale from "../../locales";
import type { ChatSessionEditorCommand } from "../../store/chat-session-editor";
import { getMessageText } from "../../utils";
import { Conversation } from "../../utils/conversation";
import { IconButton } from "../button";
import { Select } from "../ui-lib";
import styles from "./chat.module.scss";

interface EditableMessageRowProps {
  message: Conversation.Node;
  index: number;
  outlineBoundary: boolean;
  dispatch(command: ChatSessionEditorCommand): void;
}

export function EditableMessageRow({
  message,
  index,
  outlineBoundary,
  dispatch,
}: EditableMessageRowProps) {
  const [editing, setEditing] = useState(false);
  const insert = {
    type: "insert-node" as const,
    previousId: message.id,
  };
  return (
    <Draggable draggableId={message.id} index={index} key={message.id} isDragDisabled={editing}>
      {(draggable) => (
        <div
          ref={draggable.innerRef}
          {...draggable.draggableProps}
          className={styles["graph-editor-entry"]}
          style={
            {
              ...draggable.draggableProps.style,
              "--outline-indent": Math.min(message.outlineLevel - 1, 8),
            } as CSSProperties & {
              "--outline-indent": number;
            }
          }
        >
          <div className={styles["graph-editor-row"]}>
            {!editing && (
              <>
                <div
                  className={styles["graph-editor-drag"]}
                  {...draggable.dragHandleProps}
                  aria-label={`${Locale.Chat.Graph.Drag} ${index + 1}`}
                  title={Locale.Chat.Graph.Drag}
                >
                  <DragIcon />
                </div>
                <div className={styles["graph-editor-role"]}>
                  <span className={styles["graph-editor-level"]}>L{message.outlineLevel}</span>
                  <Select
                    value={message.role}
                    aria-label={`${Locale.Chat.Graph.Role} ${index + 1}`}
                    onChange={(event) => {
                      const role = event.currentTarget.value as Conversation.Message["role"];
                      dispatch({
                        type: "set-node-role",
                        nodeId: message.id,
                        role,
                      });
                    }}
                  >
                    {Conversation.roles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            )}
            <textarea
              rows={editing ? 5 : 1}
              className={clsx(editing && styles["graph-editor-content-active"])}
              aria-label={`${Locale.Chat.Actions.Edit} ${index + 1}`}
              value={getMessageText(message.content)}
              onFocus={() => setEditing(true)}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.blur();
                }
              }}
              onChange={(event) => {
                const text = event.target.value;
                dispatch({ type: "set-node-text", nodeId: message.id, text });
              }}
            />
            {!editing && (
              <IconButton
                icon={<DeleteIcon />}
                aria={`${Locale.Chat.Actions.Delete} ${index + 1}`}
                bordered
                className={styles["graph-editor-delete"]}
                onClick={() => dispatch({ type: "remove-node", nodeId: message.id })}
              />
            )}
          </div>
          <button
            type="button"
            className={clsx(
              styles["graph-editor-insert"],
              outlineBoundary && styles["graph-editor-outline-divider"],
            )}
            aria-label={`${Locale.Chat.Graph.Insert} ${index + 1}`}
            onClick={() => dispatch(insert)}
          >
            <AddIcon />
          </button>
        </div>
      )}
    </Draggable>
  );
}
