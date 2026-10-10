import { useNavigate } from "react-router";
import { Path } from "../../constant";
import CopyIcon from "../../icons/copy.svg";
import Locale from "../../locales";
import { useChatStore } from "../../store";
import { useMaskStore } from "../../store/mask";
import { Conversation } from "../../utils/conversation";
import { IconButton } from "../button";
import { ContextPrompts, MaskConfig } from "../mask";
import { Modal } from "../ui-lib";

export function SessionConfigModel(props: { onClose: () => void }) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const maskStore = useMaskStore();
  const navigate = useNavigate();

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Context.Edit}
        onClose={() => props.onClose()}
        actions={[
          <IconButton
            key="copy"
            icon={<CopyIcon />}
            text={Locale.Chat.Config.SaveAs}
            onClick={() => {
              navigate(Path.Masks);
              setTimeout(() => {
                maskStore.create({
                  ...session.mask,
                  context: session.pinnedInputs.map(Conversation.serializeMessage),
                });
              }, 500);
            }}
          />,
        ]}
      >
        <MaskConfig
          mask={session.mask}
          contextTitle={Locale.Context.PinnedTitle}
          contextEditor={
            <ContextPrompts
              context={session.pinnedInputs}
              createPrompt={Conversation.createMessage}
              updateContext={(updater) =>
                chatStore.updateSession(session.id, (draft) => {
                  updater(draft.pinnedInputs);
                })
              }
            />
          }
          updateMask={(updater) => {
            const mask = { ...session.mask };
            updater(mask);
            chatStore.updateSession(session.id, (draft) => {
              draft.mask = mask;
            });
          }}
          shouldSyncFromGlobal
        />
      </Modal>
    </div>
  );
}
