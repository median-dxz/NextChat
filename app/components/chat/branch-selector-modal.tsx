import BranchIcon from "../../icons/branch.svg";
import Locale from "../../locales";
import { useChatStore } from "../../store";
import { getMessageText } from "../../utils";
import { Conversation } from "../../utils/conversation";
import { IconButton } from "../button";
import { Modal } from "../ui-lib";
import styles from "./chat.module.scss";

export function BranchSelectorModal(props: {
  parentId: string;
  onClose: () => void;
  onStartBranch: () => void;
}) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const parentNode = Conversation(session).findNode(props.parentId);
  if (!parentNode) return null;
  const parent = parentNode.value;
  const branches = parentNode.branches;
  const select = (branchRootId?: string) => {
    chatStore.selectConversationBranch(session.id, parent.id, branchRootId);
    props.onClose();
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.Graph.BranchTitle}
        onClose={props.onClose}
        className={styles["branch-selector-dialog"]}
        contentClassName={styles["branch-selector-dialog-content"]}
        showMaximize={false}
        actions={[
          <IconButton
            key="new-branch"
            type="primary"
            text={Locale.Chat.Graph.NewBranch}
            icon={<BranchIcon />}
            onClick={() => {
              chatStore.startConversationBranch(session.id, parent.id);
              props.onStartBranch();
              props.onClose();
            }}
          />,
        ]}
      >
        <div className={styles["branch-selector"]}>
          <button
            type="button"
            aria-pressed={!parent.activeBranchRootId}
            onClick={() => select(undefined)}
          >
            <span className={styles["branch-selector-indicator"]} />
            <span className={styles["branch-selector-copy"]}>
              <strong>{Locale.Chat.Graph.NoBranch}</strong>
            </span>
          </button>
          {branches.map((branch) => (
            <button
              type="button"
              key={branch.id}
              aria-pressed={parent.activeBranchRootId === branch.id}
              onClick={() => select(branch.id)}
            >
              <span className={styles["branch-selector-indicator"]} />
              <span className={styles["branch-selector-copy"]}>
                <strong>{getMessageText(branch.content).slice(0, 120) || branch.id}</strong>
              </span>
              <span className={styles["branch-selector-level"]}>L{branch.outlineLevel}</span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
