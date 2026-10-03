import { DragDropContext, Droppable, type OnDragEndResponder } from "@hello-pangea/dnd";
import CancelIcon from "../../icons/cancel.svg";
import ConfirmIcon from "../../icons/confirm.svg";
import LoadingButtonIcon from "../../icons/loading.svg";
import ReloadIcon from "../../icons/reload.svg";
import Locale from "../../locales";
import { IconButton } from "../button";
import { List, ListItem, Modal, showToast } from "../ui-lib";
import { EditableMessageRow } from "./editable-message-row";
import { useSessionEditor } from "./session-editor";
import { useTitleGeneration } from "./title-generation";
import styles from "./chat.module.scss";

export function EditMessageModal(props: { onClose: () => void }) {
  const edit = useSessionEditor(props.onClose);
  const { session, draft, dispatch, close, save } = edit;
  const { generateTitle, generatingTitle, setTitle } = useTitleGeneration(edit);

  if (!session || !draft) return null;

  const messages = draft.conversation.projectActive().filter((node) => !node.streaming);

  const onDragEnd: OnDragEndResponder = (result) => {
    if (!result.destination || result.source.index === result.destination.index) return;

    dispatch({
      type: "swap-nodes",
      firstId: messages[result.source.index].id,
      secondId: messages[result.destination.index].id,
    });
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.EditMessage.Title}
        onClose={close}
        className={styles["graph-editor-dialog"]}
        contentClassName={styles["graph-editor-dialog-content"]}
        showMaximize={false}
        actions={[
          <IconButton text={Locale.UI.Cancel} icon={<CancelIcon />} key="cancel" onClick={close} />,
          <IconButton
            type="primary"
            text={Locale.UI.Confirm}
            icon={<ConfirmIcon />}
            key="ok"
            disabled={generatingTitle}
            onClick={save}
          />,
        ]}
      >
        <List>
          <ListItem
            title={Locale.Chat.EditMessage.Topic.Title}
            subTitle={Locale.Chat.EditMessage.Topic.SubTitle}
            className={styles["graph-editor-topic-row"]}
          >
            <div className={styles["graph-editor-topic"]}>
              <input
                type="text"
                value={draft.topic}
                onInput={(event) => setTitle(event.currentTarget.value)}
              />
              <IconButton
                icon={generatingTitle ? <LoadingButtonIcon /> : <ReloadIcon />}
                bordered
                aria={Locale.Chat.Actions.RefreshTitle}
                title={Locale.Chat.Actions.RefreshTitle}
                disabled={generatingTitle}
                onClick={() => {
                  showToast(Locale.Chat.Actions.RefreshToast);
                  void generateTitle();
                }}
              />
            </div>
          </ListItem>
        </List>
        {draft.conversation.state.messages.some((node) => node.streaming) && (
          <p>{Locale.Chat.EditMessage.StreamingExcluded}</p>
        )}
        <div className={styles["graph-editor"]}>
          <DragDropContext onDragEnd={onDragEnd}>
            <Droppable droppableId="conversation-graph-editor">
              {(droppable) => (
                <div ref={droppable.innerRef} {...droppable.droppableProps}>
                  {messages.map((message, index) => (
                    <EditableMessageRow
                      key={message.id}
                      message={message}
                      index={index}
                      outlineBoundary={
                        messages[index + 1] !== undefined &&
                        messages[index + 1].outlineLevel !== message.outlineLevel
                      }
                      dispatch={dispatch}
                    />
                  ))}
                  {droppable.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        </div>
      </Modal>
    </div>
  );
}
