import { useState } from "react";
import { isServiceProviderName, ServiceProvider } from "../../constant";
import BrainIcon from "../../icons/brain.svg";
import ConfirmIcon from "../../icons/confirm.svg";
import LoadingButtonIcon from "../../icons/loading.svg";
import Locale from "../../locales";
import { useChatStore } from "../../store";
import { useAllModels } from "../../utils/hooks";
import { getModelProvider } from "../../utils/model";
import { IconButton } from "../button";
import { Modal, Select } from "../ui-lib";
import styles from "./global-memory-modal.module.scss";

export function GlobalMemoryModal(props: { onClose: () => void }) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const [enabled, setEnabled] = useState(session.globalMemory.enabled);
  const [prompt, setPrompt] = useState(session.globalMemory.prompt);
  const [content, setContent] = useState(session.globalMemory.content);
  const [updating, setUpdating] = useState(false);
  const [updateModel, setUpdateModel] = useState("@");
  const availableModels = useAllModels().filter((model) => model.available);

  const save = () => {
    chatStore.editGlobalMemory(session.id, { enabled, prompt, content });
  };
  const update = async () => {
    save();
    setUpdating(true);
    try {
      const [model, providerName] = getModelProvider(updateModel);
      await chatStore.updateGlobalMemory(
        session.id,
        prompt,
        updateModel === "@"
          ? undefined
          : {
              model,
              providerName:
                providerName && isServiceProviderName(providerName)
                  ? providerName
                  : ServiceProvider.OpenAI,
            },
      );
      setContent(useChatStore.getState().currentSession().globalMemory.content);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.Graph.GlobalMemory}
        onClose={props.onClose}
        className={styles["global-memory-dialog"]}
        contentClassName={styles["global-memory-dialog-content"]}
        showMaximize={false}
        actions={[
          <IconButton
            key="update"
            text={Locale.Chat.Graph.UpdateMemory}
            icon={updating ? <LoadingButtonIcon /> : <BrainIcon />}
            disabled={updating || !enabled || !prompt.trim()}
            onClick={() => void update()}
          />,
          <IconButton
            key="save"
            type="primary"
            text={Locale.Chat.Graph.SaveMemory}
            icon={<ConfirmIcon />}
            onClick={() => {
              save();
              props.onClose();
            }}
          />,
        ]}
      >
        <div className={styles["global-memory-editor"]}>
          <label className={styles["global-memory-toggle"]}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>{Locale.Chat.Graph.Enabled}</span>
          </label>
          <label className={styles["global-memory-field"]}>
            <span>{Locale.Chat.Graph.Prompt}</span>
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <label className={styles["global-memory-field"]}>
            <span>{Locale.Chat.Graph.Content}</span>
            <textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
          </label>
          <label className={styles["global-memory-model"]}>
            <span>{Locale.Chat.Graph.TemporaryMemoryModel}</span>
            <Select
              value={updateModel}
              aria-label={Locale.Chat.Graph.TemporaryMemoryModel}
              onChange={(event) => setUpdateModel(event.currentTarget.value)}
            >
              <option value="@">{Locale.Chat.Graph.UseConfiguredMemoryModel}</option>
              {availableModels.map((model) => (
                <option
                  key={`${model.name}@${model.provider?.providerName}`}
                  value={`${model.name}@${model.provider?.providerName}`}
                >
                  {model.displayName} ({model.provider?.providerName})
                </option>
              ))}
            </Select>
          </label>
        </div>
      </Modal>
    </div>
  );
}
