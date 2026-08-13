import { useDebouncedCallback } from "use-debounce";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import SendWhiteIcon from "../icons/send-white.svg";
import BrainIcon from "../icons/brain.svg";
import RenameIcon from "../icons/rename.svg";
import EditIcon from "../icons/rename.svg";
import ExportIcon from "../icons/share.svg";
import ReturnIcon from "../icons/return.svg";
import CopyIcon from "../icons/copy.svg";
import SpeakIcon from "../icons/speak.svg";
import SpeakStopIcon from "../icons/speak-stop.svg";
import LoadingIcon from "../icons/three-dots.svg";
import LoadingButtonIcon from "../icons/loading.svg";
import PromptIcon from "../icons/prompt.svg";
import MaskIcon from "../icons/mask.svg";
import MaxIcon from "../icons/max.svg";
import MinIcon from "../icons/min.svg";
import ResetIcon from "../icons/reload.svg";
import ReloadIcon from "../icons/reload.svg";
import SettingsIcon from "../icons/chat-settings.svg";
import DeleteIcon from "../icons/clear.svg";
import PinIcon from "../icons/pin.svg";
import ConfirmIcon from "../icons/confirm.svg";
import CloseIcon from "../icons/close.svg";
import CancelIcon from "../icons/cancel.svg";
import ImageIcon from "../icons/image.svg";
import AddIcon from "../icons/add.svg";
import DragIcon from "../icons/drag.svg";
import BranchIcon from "../icons/branch.svg";
import ContinueIcon from "../icons/continue.svg";

import BottomIcon from "../icons/bottom.svg";
import StopIcon from "../icons/pause.svg";
import RobotIcon from "../icons/robot.svg";
import SizeIcon from "../icons/size.svg";
import QualityIcon from "../icons/hd.svg";
import StyleIcon from "../icons/palette.svg";
import PluginIcon from "../icons/plugin.svg";
import ShortcutkeyIcon from "../icons/shortcutkey.svg";
import McpToolIcon from "../icons/tool.svg";
import HeadphoneIcon from "../icons/headphone.svg";
import {
  BOT_HELLO,
  ChatMessage,
  ChatSession,
  createConversationNode,
  createMessage,
  DEFAULT_TOPIC,
  getSessionActiveMessages,
  ModelType,
  ModelConfig,
  SubmitKey,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "../store";

import {
  autoGrowTextArea,
  copyToClipboard,
  getMessageImages,
  getMessageTextContent,
  isDalle3,
  isVisionModel,
  safeLocalStorage,
  getModelSizes,
  supportsCustomSize,
  useMobileScreen,
  showPlugins,
} from "../utils";

import { uploadImage as uploadImageRemote } from "@/app/utils/chat";

import dynamic from "next/dynamic";
import isEqual from "lodash-es/isEqual";

import { DalleQuality, DalleStyle, ModelSize } from "../typing";
import { Prompt, usePromptStore } from "../store/prompt";
import Locale from "../locales";

import { IconButton } from "./button";
import styles from "./chat.module.scss";

import {
  List,
  ListItem,
  Modal,
  Select,
  Selector,
  showConfirm,
  showPrompt,
  showToast,
} from "./ui-lib";
import { useNavigate } from "react-router";
import {
  CHAT_PAGE_SIZE,
  DEFAULT_TTS_ENGINE,
  ModelProvider,
  Path,
  ServiceProvider,
  UNFINISHED_INPUT,
} from "../constant";
import { Avatar } from "./emoji";
import { MaskAvatar, MaskConfig } from "./mask";
import { useMaskStore } from "../store/mask";
import { ChatCommandPrefix, useChatCommand, useCommand } from "../command";
import { prettyObject } from "../utils/format";
import { ExportMessageModal } from "./exporter";
import { ReasoningDisclosure } from "./reasoning";
import { getClientConfig } from "../config/client";
import { useAllModels } from "../utils/hooks";
import { ClientApi } from "../client/api";
import { createTTSPlayer } from "../utils/audio";
import { MsEdgeTTS, OUTPUT_FORMAT } from "../utils/ms_edge_tts";

import { isEmpty } from "lodash-es";
import { getModelProvider } from "../utils/model";
import clsx from "clsx";
import { getAvailableClientsCount, isMcpEnabled } from "@/app/mcp/actions";
import { getChatScrollUpdate, useScrollToBottom } from "./chat-scroll";
import { CONVERSATION_ROLES, Conversation } from "../utils/conversation";
import {
  DragDropContext,
  Draggable,
  Droppable,
  type OnDragEndResponder,
} from "@hello-pangea/dnd";

const localStorage = safeLocalStorage();

const ttsPlayer = createTTSPlayer();

function replaceMessageText(
  message: Pick<ChatMessage, "content">,
  text: string,
): ChatMessage["content"] {
  const images = getMessageImages(message);
  if (images.length === 0) return text;

  return [
    { type: "text", text },
    ...images.map((url) => ({
      type: "image_url" as const,
      image_url: { url },
    })),
  ];
}

const Markdown = dynamic(async () => (await import("./markdown")).Markdown, {
  loading: () => <LoadingIcon />,
});

const RealtimeChat = dynamic(
  async () => (await import("@/app/components/realtime-chat")).RealtimeChat,
  { loading: () => <LoadingIcon /> },
);

const MCPAction = () => {
  const navigate = useNavigate();
  const [count, setCount] = useState<number>(0);
  const [mcpEnabled, setMcpEnabled] = useState(false);

  useEffect(() => {
    const checkMcpStatus = async () => {
      const enabled = await isMcpEnabled();
      setMcpEnabled(enabled);
      if (enabled) {
        const count = await getAvailableClientsCount();
        setCount(count);
      }
    };
    checkMcpStatus();
  }, []);

  if (!mcpEnabled) return null;

  return (
    <ChatAction
      onClick={() => navigate(Path.McpMarket)}
      text={`MCP${count ? ` (${count})` : ""}`}
      icon={<McpToolIcon />}
    />
  );
};

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
            bordered
            text={Locale.Chat.Config.SaveAs}
            onClick={() => {
              navigate(Path.Masks);
              setTimeout(() => {
                maskStore.create(session.mask);
              }, 500);
            }}
          />,
        ]}
      >
        <MaskConfig
          mask={session.mask}
          updateMask={(updater) => {
            const mask = { ...session.mask };
            updater(mask);
            chatStore.updateSessionMetadata(session.id, (session) => {
              session.mask = mask;
            });
          }}
          shouldSyncFromGlobal
        />
      </Modal>
    </div>
  );
}

function PromptToast(props: {
  showToast?: boolean;
  showModal?: boolean;
  setShowModal: (_: boolean) => void;
}) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const context = session.pinnedInputs;

  return (
    <div className={styles["prompt-toast"]} key="prompt-toast">
      {props.showToast && context.length > 0 && (
        <div
          className={clsx(styles["prompt-toast-inner"], "clickable")}
          role="button"
          onClick={() => props.setShowModal(true)}
        >
          <BrainIcon />
          <span className={styles["prompt-toast-content"]}>
            {Locale.Context.Toast(context.length)}
          </span>
        </div>
      )}
      {props.showModal && (
        <SessionConfigModel onClose={() => props.setShowModal(false)} />
      )}
    </div>
  );
}

function useSubmitHandler() {
  const config = useAppConfig();
  const submitKey = config.submitKey;
  const isComposing = useRef(false);

  useEffect(() => {
    const onCompositionStart = () => {
      isComposing.current = true;
    };
    const onCompositionEnd = () => {
      isComposing.current = false;
    };

    window.addEventListener("compositionstart", onCompositionStart);
    window.addEventListener("compositionend", onCompositionEnd);

    return () => {
      window.removeEventListener("compositionstart", onCompositionStart);
      window.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

  const shouldSubmit = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Fix Chinese input method "Enter" on Safari
    if (e.keyCode == 229) return false;
    if (e.key !== "Enter") return false;
    if (e.key === "Enter" && (e.nativeEvent.isComposing || isComposing.current))
      return false;
    return (
      (config.submitKey === SubmitKey.AltEnter && e.altKey) ||
      (config.submitKey === SubmitKey.CtrlEnter && e.ctrlKey) ||
      (config.submitKey === SubmitKey.ShiftEnter && e.shiftKey) ||
      (config.submitKey === SubmitKey.MetaEnter && e.metaKey) ||
      (config.submitKey === SubmitKey.Enter &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey)
    );
  };

  return {
    submitKey,
    shouldSubmit,
  };
}

export type RenderPrompt = Pick<Prompt, "title" | "content">;

export function PromptHints(props: {
  prompts: RenderPrompt[];
  onPromptSelect: (prompt: RenderPrompt) => void;
}) {
  const noPrompts = props.prompts.length === 0;
  const [selectIndex, setSelectIndex] = useState(0);
  const effectiveSelectIndex = Math.min(
    selectIndex,
    Math.max(0, props.prompts.length - 1),
  );
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A new result set starts keyboard navigation from its first item.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectIndex(0);
  }, [props.prompts]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (noPrompts || e.metaKey || e.altKey || e.ctrlKey) {
        return;
      }
      // arrow up / down to select prompt
      const changeIndex = (delta: number) => {
        e.stopPropagation();
        e.preventDefault();
        const nextIndex = Math.max(
          0,
          Math.min(props.prompts.length - 1, effectiveSelectIndex + delta),
        );
        setSelectIndex(nextIndex);
        selectedRef.current?.scrollIntoView({
          block: "center",
        });
      };

      if (e.key === "ArrowUp") {
        changeIndex(1);
      } else if (e.key === "ArrowDown") {
        changeIndex(-1);
      } else if (e.key === "Enter") {
        const selectedPrompt = props.prompts.at(effectiveSelectIndex);
        if (selectedPrompt) {
          props.onPromptSelect(selectedPrompt);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [effectiveSelectIndex, noPrompts, props]);

  if (noPrompts) return null;
  return (
    <div className={styles["prompt-hints"]}>
      {props.prompts.map((prompt, i) => (
        <div
          ref={i === effectiveSelectIndex ? selectedRef : null}
          className={clsx(styles["prompt-hint"], {
            [styles["prompt-hint-selected"]]: i === effectiveSelectIndex,
          })}
          key={prompt.title + i.toString()}
          onClick={() => props.onPromptSelect(prompt)}
          onMouseEnter={() => setSelectIndex(i)}
        >
          <div className={styles["hint-title"]}>{prompt.title}</div>
          <div className={styles["hint-content"]}>{prompt.content}</div>
        </div>
      ))}
    </div>
  );
}

export function ChatAction(props: {
  text: string;
  icon: React.ReactElement;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  const iconRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState({
    full: 16,
    icon: 16,
  });

  function updateWidth() {
    if (!iconRef.current || !textRef.current) return;
    const getWidth = (dom: HTMLDivElement) => dom.getBoundingClientRect().width;
    const textWidth = getWidth(textRef.current);
    const iconWidth = getWidth(iconRef.current);
    setWidth({
      full: textWidth + iconWidth,
      icon: iconWidth,
    });
  }

  return (
    <button
      type="button"
      className={clsx(styles["chat-input-action"], "clickable", {
        [styles["chat-input-action-active"]]: props.active,
      })}
      onClick={() => {
        props.onClick();
        setTimeout(updateWidth, 1);
      }}
      onMouseEnter={updateWidth}
      onTouchStart={updateWidth}
      aria-label={props.text}
      aria-pressed={props.active}
      disabled={props.disabled}
      style={
        {
          "--icon-width": `${width.icon}px`,
          "--full-width": `${width.full}px`,
        } as React.CSSProperties
      }
    >
      <div ref={iconRef} className={styles["icon"]}>
        {props.icon}
      </div>
      <div className={styles["text"]} ref={textRef}>
        {props.text}
      </div>
    </button>
  );
}

export function isMessageInStreamingTurn(
  messages: ChatMessage[],
  messageIndex: number,
) {
  const message = messages[messageIndex];
  if (!message) return false;
  if (message.streaming) return true;
  if (message.role !== "user") return false;

  const response = messages[messageIndex + 1];
  return Boolean(
    response && response.role === "assistant" && response.streaming,
  );
}

export function ChatActions(props: {
  uploadImage: () => void;
  setAttachImages: (images: string[]) => void;
  setUploading: (uploading: boolean) => void;
  showPromptModal: () => void;
  showGlobalMemory: () => void;
  scrollToBottom: () => void;
  showPromptHints: () => void;
  hitBottom: boolean;
  uploading: boolean;
  setShowShortcutKeyModal: React.Dispatch<React.SetStateAction<boolean>>;
  setUserInput: (input: string) => void;
  setShowChatSidePanel: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { setAttachImages, setUploading } = props;
  const config = useAppConfig();
  const navigate = useNavigate();
  const chatStore = useChatStore();
  const pluginStore = usePluginStore();
  const session = chatStore.currentSession();
  const cursorNode = session.messages.find(
    (message) => message.id === session.activeCursorId,
  );

  // stop all responses
  const couldStop = chatStore.hasActiveChatRuns();
  const stopAll = () => chatStore.cancelAllChatRuns();

  // switch model
  const currentModel = session.mask.modelConfig.model;
  const currentProviderName =
    session.mask.modelConfig?.providerName || ServiceProvider.OpenAI;
  const allModels = useAllModels();
  const models = useMemo(() => {
    const filteredModels = allModels.filter((m) => m.available);
    const defaultModel = filteredModels.find((m) => m.isDefault);

    if (defaultModel) {
      const arr = [
        defaultModel,
        ...filteredModels.filter((m) => m !== defaultModel),
      ];
      return arr;
    } else {
      return filteredModels;
    }
  }, [allModels]);
  const currentModelName = useMemo(() => {
    const model = models.find(
      (m) =>
        m.name == currentModel &&
        m?.provider?.providerName == currentProviderName,
    );
    return model?.displayName ?? "";
  }, [models, currentModel, currentProviderName]);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showPluginSelector, setShowPluginSelector] = useState(false);
  const showUploadImage = isVisionModel(currentModel);

  const [showSizeSelector, setShowSizeSelector] = useState(false);
  const [showQualitySelector, setShowQualitySelector] = useState(false);
  const [showStyleSelector, setShowStyleSelector] = useState(false);
  const modelSizes = getModelSizes(currentModel);
  const dalle3Qualitys: DalleQuality[] = ["standard", "hd"];
  const dalle3Styles: DalleStyle[] = ["vivid", "natural"];
  const currentSize =
    session.mask.modelConfig?.size ?? ("1024x1024" as ModelSize);
  const currentQuality = session.mask.modelConfig?.quality ?? "standard";
  const currentStyle = session.mask.modelConfig?.style ?? "vivid";

  const isMobileScreen = useMobileScreen();

  useEffect(() => {
    if (!showUploadImage) {
      setAttachImages([]);
      setUploading(false);
    }
  }, [showUploadImage, setAttachImages, setUploading]);

  useEnsureAvailableModel(chatStore, config, session, models);

  return (
    <div className={styles["chat-input-actions"]}>
      <>
        {couldStop && (
          <ChatAction
            onClick={stopAll}
            text={Locale.Chat.InputActions.Stop}
            icon={<StopIcon />}
          />
        )}
        {!props.hitBottom && (
          <ChatAction
            onClick={props.scrollToBottom}
            text={Locale.Chat.InputActions.ToBottom}
            icon={<BottomIcon />}
          />
        )}
        {props.hitBottom && (
          <ChatAction
            onClick={props.showPromptModal}
            text={Locale.Chat.InputActions.Settings}
            icon={<SettingsIcon />}
          />
        )}

        <ChatAction
          onClick={() => chatStore.setNextOutlineDelta(session.id, 1)}
          text={Locale.Chat.InputActions.OutlineIn}
          icon={<span aria-hidden="true">↳+</span>}
          active={session.pendingOutlineDelta === 1}
          disabled={!cursorNode}
        />
        <ChatAction
          onClick={() => chatStore.setNextOutlineDelta(session.id, -1)}
          text={Locale.Chat.InputActions.OutlineOut}
          icon={<span aria-hidden="true">↰−</span>}
          active={session.pendingOutlineDelta === -1}
          disabled={!cursorNode || cursorNode.outlineLevel <= 1}
        />
        <ChatAction
          onClick={props.showGlobalMemory}
          text={Locale.Chat.Graph.GlobalMemory}
          icon={<BrainIcon />}
          active={session.globalMemory.enabled}
        />

        {showUploadImage && (
          <ChatAction
            onClick={props.uploadImage}
            text={Locale.Chat.InputActions.UploadImage}
            icon={props.uploading ? <LoadingButtonIcon /> : <ImageIcon />}
          />
        )}
        <ChatAction
          onClick={props.showPromptHints}
          text={Locale.Chat.InputActions.Prompt}
          icon={<PromptIcon />}
        />

        {isMobileScreen && (
          <ChatAction
            onClick={() => {
              navigate(Path.Masks);
            }}
            text={Locale.Chat.InputActions.Masks}
            icon={<MaskIcon />}
          />
        )}

        <ChatAction
          onClick={() => setShowModelSelector(true)}
          text={currentModelName}
          icon={<RobotIcon />}
        />

        {showModelSelector && (
          <Selector
            defaultSelectedValue={`${currentModel}@${currentProviderName}`}
            items={models.map((m) => ({
              title: `${m.displayName}${
                m?.provider?.providerName
                  ? " (" + m?.provider?.providerName + ")"
                  : ""
              }`,
              value: `${m.name}@${m?.provider?.providerName}`,
            }))}
            onClose={() => setShowModelSelector(false)}
            onSelection={(s) => {
              if (s.length === 0) return;
              const [model, providerName] = getModelProvider(s[0]);
              chatStore.updateSessionMetadata(session.id, (session) => {
                session.mask.modelConfig.model = model as ModelType;
                session.mask.modelConfig.providerName =
                  providerName as ServiceProvider;
                session.mask.syncGlobalConfig = false;
              });
              if (providerName == "ByteDance") {
                const selectedModel = models.find(
                  (m) =>
                    m.name == model &&
                    m?.provider?.providerName == providerName,
                );
                showToast(selectedModel?.displayName ?? "");
              } else {
                showToast(model);
              }
            }}
          />
        )}

        {supportsCustomSize(currentModel) && (
          <ChatAction
            onClick={() => setShowSizeSelector(true)}
            text={currentSize}
            icon={<SizeIcon />}
          />
        )}

        {showSizeSelector && (
          <Selector
            defaultSelectedValue={currentSize}
            items={modelSizes.map((m) => ({
              title: m,
              value: m,
            }))}
            onClose={() => setShowSizeSelector(false)}
            onSelection={(s) => {
              if (s.length === 0) return;
              const size = s[0];
              chatStore.updateSessionMetadata(session.id, (session) => {
                session.mask.modelConfig.size = size;
              });
              showToast(size);
            }}
          />
        )}

        {isDalle3(currentModel) && (
          <ChatAction
            onClick={() => setShowQualitySelector(true)}
            text={currentQuality}
            icon={<QualityIcon />}
          />
        )}

        {showQualitySelector && (
          <Selector
            defaultSelectedValue={currentQuality}
            items={dalle3Qualitys.map((m) => ({
              title: m,
              value: m,
            }))}
            onClose={() => setShowQualitySelector(false)}
            onSelection={(q) => {
              if (q.length === 0) return;
              const quality = q[0];
              chatStore.updateSessionMetadata(session.id, (session) => {
                session.mask.modelConfig.quality = quality;
              });
              showToast(quality);
            }}
          />
        )}

        {isDalle3(currentModel) && (
          <ChatAction
            onClick={() => setShowStyleSelector(true)}
            text={currentStyle}
            icon={<StyleIcon />}
          />
        )}

        {showStyleSelector && (
          <Selector
            defaultSelectedValue={currentStyle}
            items={dalle3Styles.map((m) => ({
              title: m,
              value: m,
            }))}
            onClose={() => setShowStyleSelector(false)}
            onSelection={(s) => {
              if (s.length === 0) return;
              const style = s[0];
              chatStore.updateSessionMetadata(session.id, (session) => {
                session.mask.modelConfig.style = style;
              });
              showToast(style);
            }}
          />
        )}

        {showPlugins(currentProviderName, currentModel) && (
          <ChatAction
            onClick={() => {
              if (pluginStore.getAll().length == 0) {
                navigate(Path.Plugins);
              } else {
                setShowPluginSelector(true);
              }
            }}
            text={Locale.Plugin.Name}
            icon={<PluginIcon />}
          />
        )}
        {showPluginSelector && (
          <Selector
            multiple
            defaultSelectedValue={chatStore.currentSession().mask?.plugin}
            items={pluginStore.getAll().map((item) => ({
              title: `${item?.title}@${item?.version}`,
              value: item?.id,
            }))}
            onClose={() => setShowPluginSelector(false)}
            onSelection={(s) => {
              chatStore.updateSessionMetadata(session.id, (session) => {
                session.mask.plugin = s as string[];
              });
            }}
          />
        )}

        {!isMobileScreen && (
          <ChatAction
            onClick={() => props.setShowShortcutKeyModal(true)}
            text={Locale.Chat.ShortcutKey.Title}
            icon={<ShortcutkeyIcon />}
          />
        )}
        {!isMobileScreen && <MCPAction />}
      </>
      <div className={styles["chat-input-actions-end"]}>
        {config.realtimeConfig.enable && (
          <ChatAction
            onClick={() => props.setShowChatSidePanel(true)}
            text={"Realtime Chat"}
            icon={<HeadphoneIcon />}
          />
        )}
      </div>
    </div>
  );
}

export function EditMessageModal(props: { onClose: () => void }) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const messages = getSessionActiveMessages(session);
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const runGraphAction = (action: () => void) => {
    try {
      action();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };
  const onDragEnd: OnDragEndResponder = (result) => {
    if (!result.destination || result.source.index === result.destination.index)
      return;
    const source = messages[result.source.index];
    const destination = messages[result.destination.index];
    runGraphAction(() =>
      chatStore.swapMessages(session.id, source.id, destination.id),
    );
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.EditMessage.Title}
        onClose={props.onClose}
        className={styles["graph-editor-dialog"]}
        contentClassName={styles["graph-editor-dialog-content"]}
        showMaximize={false}
        actions={[
          <IconButton
            text={Locale.UI.Cancel}
            icon={<CancelIcon />}
            key="cancel"
            onClick={() => {
              props.onClose();
            }}
          />,
          <IconButton
            type="primary"
            text={Locale.UI.Confirm}
            icon={<ConfirmIcon />}
            key="ok"
            onClick={props.onClose}
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
                value={session.topic}
                onInput={(e) =>
                  chatStore.updateSessionMetadata(session.id, (session) => {
                    session.topic = e.currentTarget.value;
                  })
                }
              />
              <IconButton
                icon={<ReloadIcon />}
                bordered
                aria={Locale.Chat.Actions.RefreshTitle}
                title={Locale.Chat.Actions.RefreshTitle}
                onClick={() => {
                  showToast(Locale.Chat.Actions.RefreshToast);
                  chatStore.generateSessionTitle(session, true);
                }}
              />
            </div>
          </ListItem>
        </List>
        <div className={styles["graph-editor"]}>
          <DragDropContext onDragEnd={onDragEnd}>
            <Droppable droppableId="conversation-graph-editor">
              {(droppable) => (
                <div ref={droppable.innerRef} {...droppable.droppableProps}>
                  {messages.map((message, index) => (
                    <Draggable
                      draggableId={message.id}
                      index={index}
                      key={message.id}
                    >
                      {(draggable) => (
                        <div
                          ref={draggable.innerRef}
                          {...draggable.draggableProps}
                          className={styles["graph-editor-entry"]}
                          style={
                            {
                              ...draggable.draggableProps.style,
                              "--outline-indent": Math.min(
                                message.outlineLevel - 1,
                                8,
                              ),
                            } as React.CSSProperties & {
                              "--outline-indent": number;
                            }
                          }
                        >
                          <div className={styles["graph-editor-row"]}>
                            {editingMessageId !== message.id && (
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
                                  <span
                                    className={styles["graph-editor-level"]}
                                  >
                                    L{message.outlineLevel}
                                  </span>
                                  <Select
                                    value={message.role}
                                    aria-label={`${Locale.Chat.Graph.Role} ${index + 1}`}
                                    onChange={(event) =>
                                      chatStore.updateConversation(
                                        session.id,
                                        (conversation) =>
                                          conversation.updateNodeData(
                                            message.id,
                                            (target) => {
                                              target.role = event.currentTarget
                                                .value as ChatMessage["role"];
                                            },
                                          ),
                                      )
                                    }
                                  >
                                    {CONVERSATION_ROLES.map((role) => (
                                      <option key={role} value={role}>
                                        {role}
                                      </option>
                                    ))}
                                  </Select>
                                </div>
                              </>
                            )}
                            <textarea
                              rows={editingMessageId === message.id ? 5 : 1}
                              className={clsx(
                                editingMessageId === message.id &&
                                  styles["graph-editor-content-active"],
                              )}
                              aria-label={`${Locale.Chat.Actions.Edit} ${index + 1}`}
                              value={getMessageTextContent(message)}
                              onFocus={() => setEditingMessageId(message.id)}
                              onBlur={() => {
                                setEditingMessageId((current) =>
                                  current === message.id ? undefined : current,
                                );
                                window.getSelection()?.removeAllRanges();
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  event.currentTarget.blur();
                                }
                              }}
                              onChange={(event) =>
                                chatStore.updateMessageContent(
                                  session.id,
                                  message.id,
                                  event.target.value,
                                )
                              }
                            />
                            {editingMessageId !== message.id && (
                              <IconButton
                                icon={<DeleteIcon />}
                                aria={`${Locale.Chat.Actions.Delete} ${index + 1}`}
                                bordered
                                className={styles["graph-editor-delete"]}
                                onClick={() =>
                                  chatStore.deleteMessage(
                                    session.id,
                                    message.id,
                                  )
                                }
                              />
                            )}
                          </div>
                          <button
                            type="button"
                            className={clsx(
                              styles["graph-editor-insert"],
                              messages[index + 1] &&
                                messages[index + 1].outlineLevel !==
                                  message.outlineLevel &&
                                styles["graph-editor-outline-divider"],
                            )}
                            aria-label={`${Locale.Chat.Graph.Insert} ${index + 1}`}
                            onClick={() =>
                              runGraphAction(() =>
                                chatStore.insertMessageBetween(
                                  session.id,
                                  createConversationNode({
                                    role: "user",
                                    content: "",
                                  }),
                                  message.id,
                                  messages[index + 1]?.id,
                                ),
                              )
                            }
                          >
                            <AddIcon />
                          </button>
                        </div>
                      )}
                    </Draggable>
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

export function DeleteImageButton(props: { deleteImage: () => void }) {
  return (
    <div className={styles["delete-image"]} onClick={props.deleteImage}>
      <DeleteIcon />
    </div>
  );
}

function NodeViewerModal(props: {
  nodeId: string;
  onClose: () => void;
  onPin: (message: ChatMessage) => void;
}) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const node = session.messages.find((item) => item.id === props.nodeId);
  const [content, setContent] = useState(() =>
    node ? getMessageTextContent(node) : "",
  );
  const [segment, setSegment] = useState(
    () => node?.nodeSummaries?.segment?.content ?? "",
  );
  const [checkpoint, setCheckpoint] = useState(
    () => node?.nodeSummaries?.checkpoint?.content ?? "",
  );
  const [segmentOpen, setSegmentOpen] = useState(() => Boolean(segment));
  const [checkpointOpen, setCheckpointOpen] = useState(() =>
    Boolean(checkpoint),
  );
  const [role, setRole] = useState<ChatMessage["role"]>(
    () => node?.role ?? "user",
  );
  const [outlineLevel, setOutlineLevel] = useState(
    () => node?.outlineLevel ?? 1,
  );
  const [editingProperty, setEditingProperty] = useState<
    "outline-level" | "role"
  >();
  const [generating, setGenerating] = useState(false);

  if (!node) return null;

  const outlineLevelOptions = ([-1, 0, 1] as const).flatMap((delta) => {
    const level = node.outlineLevel + delta;
    if (level < 1) return [];
    try {
      Conversation(session).node(node.id).shiftLevel(delta);
      return [level];
    } catch {
      return [];
    }
  });

  const save = () => {
    try {
      chatStore.updateConversation(session.id, (conversation) => {
        const outlineDelta =
          outlineLevel === node.outlineLevel
            ? 0
            : outlineLevel > node.outlineLevel
              ? 1
              : -1;
        let next = conversation.node(node.id).shiftLevel(outlineDelta);
        next = next.updateNodeData(node.id, (target) => {
          target.role = role;
          target.content = replaceMessageText(target, content);
        });
        for (const [kind, value] of [
          ["segment", segment],
          ["checkpoint", checkpoint],
        ] as const) {
          const summary = next.summaries.node(node.id);
          next =
            role === "assistant"
              ? summary.edit(kind, value)
              : summary.remove(kind);
        }
        return next;
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
      return;
    }
    props.onClose();
  };
  const refreshSummaryDrafts = (kind?: "segment" | "checkpoint") => {
    const current = useChatStore
      .getState()
      .sessions.find((item) => item.id === session.id)
      ?.messages.find((item) => item.id === node.id);

    if (!kind || kind === "segment") {
      const value = current?.nodeSummaries?.segment?.content ?? "";
      setSegment(value);
      setSegmentOpen(Boolean(value));
    }
    if (!kind || kind === "checkpoint") {
      const value = current?.nodeSummaries?.checkpoint?.content ?? "";
      setCheckpoint(value);
      setCheckpointOpen(Boolean(value));
    }
  };
  const generateSummary = async (kind?: "segment" | "checkpoint") => {
    setGenerating(true);
    try {
      await chatStore.generateNodeSummary(session.id, node.id, true, kind);
      refreshSummaryDrafts(kind);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  };
  const deleteSummary = (kind: "segment" | "checkpoint") => {
    chatStore.deleteNodeSummary(session.id, node.id, kind);
    if (kind === "segment") setSegment("");
    else setCheckpoint("");
  };
  const summaryEditors = [
    {
      kind: "segment" as const,
      label: Locale.Chat.Graph.Segment,
      value: segment,
      open: segmentOpen,
      setValue: setSegment,
      setOpen: setSegmentOpen,
    },
    {
      kind: "checkpoint" as const,
      label: Locale.Chat.Graph.Checkpoint,
      value: checkpoint,
      open: checkpointOpen,
      setValue: setCheckpoint,
      setOpen: setCheckpointOpen,
    },
  ];

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.Graph.Node}
        onClose={props.onClose}
        className={styles["node-viewer-dialog"]}
        contentClassName={styles["node-viewer-dialog-content"]}
        showMaximize={false}
        actions={[
          ...(role === "assistant"
            ? [
                <IconButton
                  key="generate"
                  text={Locale.Chat.Graph.GenerateSummary}
                  icon={generating ? <LoadingButtonIcon /> : <BrainIcon />}
                  disabled={generating}
                  onClick={() => void generateSummary()}
                />,
              ]
            : []),
          <IconButton
            key="save"
            type="primary"
            text={Locale.Chat.Graph.Save}
            icon={<ConfirmIcon />}
            onClick={save}
          />,
        ]}
      >
        <div className={styles["node-viewer"]}>
          <div className={styles["node-viewer-properties"]}>
            <div className={styles["node-viewer-level"]}>
              <span id="node-outline-level-label">
                {Locale.Chat.Graph.OutlineLevel}
              </span>
              {editingProperty === "outline-level" ? (
                <Select
                  autoFocus
                  value={outlineLevel}
                  aria-labelledby="node-outline-level-label"
                  onBlur={() => setEditingProperty(undefined)}
                  onChange={(event) =>
                    setOutlineLevel(Number(event.currentTarget.value))
                  }
                >
                  {outlineLevelOptions.map((level) => (
                    <option key={level} value={level}>
                      L{level}
                    </option>
                  ))}
                </Select>
              ) : (
                <button
                  type="button"
                  className={styles["node-viewer-property-tag"]}
                  aria-label={`${Locale.Chat.Graph.OutlineLevel}: L${outlineLevel}`}
                  disabled={outlineLevelOptions.length === 1}
                  onClick={() => setEditingProperty("outline-level")}
                >
                  L{outlineLevel}
                </button>
              )}
            </div>
            <div className={styles["node-viewer-role"]}>
              <span id="node-role-label">{Locale.Chat.Graph.Role}</span>
              {editingProperty === "role" ? (
                <Select
                  autoFocus
                  value={role}
                  aria-labelledby="node-role-label"
                  onBlur={() => setEditingProperty(undefined)}
                  onChange={(event) =>
                    setRole(event.currentTarget.value as ChatMessage["role"])
                  }
                >
                  {CONVERSATION_ROLES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              ) : (
                <button
                  type="button"
                  className={styles["node-viewer-property-tag"]}
                  aria-label={`${Locale.Chat.Graph.Role}: ${role}`}
                  onClick={() => setEditingProperty("role")}
                >
                  {role}
                </button>
              )}
            </div>
          </div>
          <label className={styles["node-viewer-content"]}>
            <span>{Locale.Chat.Actions.Edit}</span>
            <textarea
              rows={5}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <div className={styles["node-viewer-secondary-action"]}>
            <IconButton
              bordered
              text={Locale.Chat.Graph.Pin}
              icon={<PinIcon />}
              onClick={() => props.onPin(node)}
            />
          </div>
          {role === "assistant" && (
            <div className={styles["node-summary-editor"]}>
              {summaryEditors.map((editor) => (
                <details
                  key={editor.kind}
                  open={editor.open}
                  onToggle={(event) => editor.setOpen(event.currentTarget.open)}
                >
                  <summary>
                    <span>{editor.label}</span>
                    <span>{editor.value ? `${editor.value.length}` : "—"}</span>
                  </summary>
                  <textarea
                    rows={4}
                    value={editor.value}
                    onChange={(event) =>
                      editor.setValue(event.currentTarget.value)
                    }
                  />
                  <div className={styles["node-summary-actions"]}>
                    <IconButton
                      text={Locale.Chat.Graph.GenerateSummary}
                      icon={<BrainIcon />}
                      disabled={generating}
                      onClick={() => void generateSummary(editor.kind)}
                    />
                    <IconButton
                      text={Locale.Chat.Actions.Delete}
                      icon={<DeleteIcon />}
                      onClick={() => deleteSummary(editor.kind)}
                    />
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function BranchSelectorModal(props: {
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
                <strong>
                  {getMessageTextContent(branch).slice(0, 120) || branch.id}
                </strong>
              </span>
              <span className={styles["branch-selector-level"]}>
                L{branch.outlineLevel}
              </span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

function GlobalMemoryModal(props: { onClose: () => void }) {
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
              providerName: providerName ?? ServiceProvider.OpenAI,
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
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <label className={styles["global-memory-field"]}>
            <span>{Locale.Chat.Graph.Content}</span>
            <textarea
              rows={6}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <label className={styles["global-memory-model"]}>
            <span>{Locale.Chat.Graph.TemporaryMemoryModel}</span>
            <Select
              value={updateModel}
              aria-label={Locale.Chat.Graph.TemporaryMemoryModel}
              onChange={(event) => setUpdateModel(event.currentTarget.value)}
            >
              <option value="@">
                {Locale.Chat.Graph.UseConfiguredMemoryModel}
              </option>
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

export function ShortcutKeyModal(props: { onClose: () => void }) {
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const shortcuts = [
    {
      title: Locale.Chat.ShortcutKey.newChat,
      keys: isMac ? ["⌘", "Shift", "O"] : ["Ctrl", "Shift", "O"],
    },
    { title: Locale.Chat.ShortcutKey.focusInput, keys: ["Shift", "Esc"] },
    {
      title: Locale.Chat.ShortcutKey.copyLastCode,
      keys: isMac ? ["⌘", "Shift", ";"] : ["Ctrl", "Shift", ";"],
    },
    {
      title: Locale.Chat.ShortcutKey.copyLastMessage,
      keys: isMac ? ["⌘", "Shift", "C"] : ["Ctrl", "Shift", "C"],
    },
    {
      title: Locale.Chat.ShortcutKey.showShortcutKey,
      keys: isMac ? ["⌘", "/"] : ["Ctrl", "/"],
    },
  ];
  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.ShortcutKey.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            type="primary"
            text={Locale.UI.Confirm}
            icon={<ConfirmIcon />}
            key="ok"
            onClick={() => {
              props.onClose();
            }}
          />,
        ]}
      >
        <div className={styles["shortcut-key-container"]}>
          <div className={styles["shortcut-key-grid"]}>
            {shortcuts.map((shortcut, index) => (
              <div key={index} className={styles["shortcut-key-item"]}>
                <div className={styles["shortcut-key-title"]}>
                  {shortcut.title}
                </div>
                <div className={styles["shortcut-key-keys"]}>
                  {shortcut.keys.map((key, i) => (
                    <div key={i} className={styles["shortcut-key"]}>
                      <span>{key}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function useEnsureAvailableModel(
  chatStore: Pick<
    ReturnType<typeof useChatStore.getState>,
    "updateSessionMetadata"
  >,
  config: Pick<
    ReturnType<typeof useAppConfig.getState>,
    "modelConfig" | "update"
  >,
  session: ChatSession,
  models: ReadonlyArray<ReturnType<typeof useAllModels>[number]>,
) {
  const currentModel = session.mask.modelConfig.model;
  const syncGlobalConfig = session.mask.syncGlobalConfig;
  const globalModel = config.modelConfig.model;
  const globalProviderName = config.modelConfig.providerName;
  const updateConfig = config.update;

  useEffect(() => {
    const isUnavailableModel = !models.some((model) => {
      return model.name === currentModel;
    });
    if (!isUnavailableModel || models.length === 0) return;

    const nextModel = models.find((model) => model.isDefault) ?? models[0];
    if (!nextModel) return;

    const nextProviderName = (nextModel.provider?.providerName ??
      ServiceProvider.OpenAI) as ServiceProvider;

    if (syncGlobalConfig) {
      // Global config owns synced sessions; repair it once and let
      // useSyncGlobalModelConfig propagate the valid model downstream.
      if (
        globalModel === nextModel.name &&
        globalProviderName === nextProviderName
      ) {
        return;
      }
      updateConfig((config) => {
        config.modelConfig.model = nextModel.name;
        config.modelConfig.providerName = nextProviderName;
      });
    } else {
      // A detached session owns its model and must not rewrite global config.
      chatStore.updateSessionMetadata(session.id, (session) => {
        if (
          session.mask.syncGlobalConfig ||
          (session.mask.modelConfig.model === nextModel.name &&
            session.mask.modelConfig.providerName === nextProviderName)
        ) {
          return false;
        }
        session.mask.modelConfig.model = nextModel.name;
        session.mask.modelConfig.providerName = nextProviderName;
      });
    }
    showToast(
      nextModel.provider?.providerName == "ByteDance"
        ? (nextModel.displayName ?? nextModel.name)
        : nextModel.name,
    );
  }, [
    chatStore,
    currentModel,
    globalModel,
    globalProviderName,
    models,
    session.id,
    syncGlobalConfig,
    updateConfig,
  ]);
}

export function useSyncGlobalModelConfig(
  chatStore: Pick<
    ReturnType<typeof useChatStore.getState>,
    "updateSessionMetadata"
  >,
  session: ChatSession,
  modelConfig: ModelConfig,
) {
  useEffect(() => {
    if (
      !session.mask.syncGlobalConfig ||
      isEqual(session.mask.modelConfig, modelConfig)
    ) {
      return;
    }

    chatStore.updateSessionMetadata(session.id, (session) => {
      if (
        !session.mask.syncGlobalConfig ||
        isEqual(session.mask.modelConfig, modelConfig)
      ) {
        return false;
      }

      session.mask.modelConfig = { ...modelConfig };
    });
  }, [
    chatStore,
    modelConfig,
    session.id,
    session.mask.modelConfig,
    session.mask.syncGlobalConfig,
  ]);
}

function ChatView() {
  type RenderMessage = ChatMessage & { preview?: boolean };

  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const config = useAppConfig();
  const fontSize = config.fontSize;
  const fontFamily = config.fontFamily;

  const [showExport, setShowExport] = useState(false);
  const [showGlobalMemory, setShowGlobalMemory] = useState(false);
  const [viewingNodeId, setViewingNodeId] = useState<string>();
  const [branchParentId, setBranchParentId] = useState<string>();
  const [actionMessageId, setActionMessageId] = useState<string>();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [userInput, setUserInput] = useState(() => {
    if (typeof localStorage === "undefined") return "";
    const key = UNFINISHED_INPUT(session.id);
    const unfinishedInput = localStorage.getItem(key) ?? "";
    if (unfinishedInput) localStorage.removeItem(key);
    return unfinishedInput;
  });
  const [isLoading, setIsLoading] = useState(false);
  const { submitKey, shouldSubmit } = useSubmitHandler();
  const isMobileScreen = useMobileScreen();
  const {
    scrollRef,
    contentRef,
    isAtBottom,
    requestBottom,
    handleScroll,
    userScrollHandlers,
  } = useScrollToBottom(isMobileScreen ? 4 : 10);
  const navigate = useNavigate();
  const [attachImages, setAttachImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  // prompt hints
  const promptStore = usePromptStore();
  const [promptHints, setPromptHints] = useState<RenderPrompt[]>([]);
  const onSearch = useDebouncedCallback(
    (text: string) => {
      const matchedPrompts = promptStore.search(text);
      setPromptHints(matchedPrompts);
    },
    100,
    { leading: true, trailing: true },
  );

  // auto grow input
  const [inputRows, setInputRows] = useState(2);
  const measure = useDebouncedCallback(
    () => {
      const rows = inputRef.current ? autoGrowTextArea(inputRef.current) : 1;
      const inputRows = Math.min(
        20,
        Math.max(2 + Number(!isMobileScreen), rows),
      );
      setInputRows(inputRows);
    },
    100,
    {
      leading: true,
      trailing: true,
    },
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(measure, [userInput]);

  // chat commands shortcuts
  const chatCommands = useChatCommand({
    new: () => chatStore.newSession(),
    newm: () => navigate(Path.NewChat),
    prev: () => chatStore.nextSession(-1),
    next: () => chatStore.nextSession(1),
    fork: () => chatStore.forkSession(),
    del: () => chatStore.deleteSession(chatStore.currentSessionIndex),
  });

  // only search prompts when user input is short
  const SEARCH_TEXT_LIMIT = 30;
  const onInput = (text: string) => {
    setUserInput(text);
    const n = text.trim().length;

    // clear search results
    if (n === 0) {
      setPromptHints([]);
    } else if (text.match(ChatCommandPrefix)) {
      setPromptHints(chatCommands.search(text));
    } else if (!config.disablePromptHint && n < SEARCH_TEXT_LIMIT) {
      // check if need to trigger auto completion
      if (text.startsWith("/")) {
        let searchText = text.slice(1);
        onSearch(searchText);
      }
    }
  };

  const doSubmit = (userInput: string) => {
    if (userInput.trim() === "" && isEmpty(attachImages)) return;
    const matchCommand = chatCommands.match(userInput);
    if (matchCommand.matched) {
      setUserInput("");
      setPromptHints([]);
      matchCommand.invoke();
      return;
    }
    setIsLoading(true);
    chatStore
      .onUserInput(userInput, attachImages)
      .then(() => setIsLoading(false))
      .catch((error) => {
        setIsLoading(false);
        setUserInput(userInput);
        showToast(
          error instanceof Error ? error.message : Locale.Memory.CompactFailed,
        );
      });
    setAttachImages([]);
    chatStore.setLastInput(userInput);
    setUserInput("");
    setPromptHints([]);
    if (!isMobileScreen) inputRef.current?.focus();
    requestBottom("send");
  };

  const onPromptSelect = (prompt: RenderPrompt) => {
    setTimeout(() => {
      setPromptHints([]);

      const matchedChatCommand = chatCommands.match(prompt.content);
      if (matchedChatCommand.matched) {
        // if user is selecting a chat command, just trigger it
        matchedChatCommand.invoke();
        setUserInput("");
      } else {
        // or fill the prompt
        setUserInput(prompt.content);
      }
      inputRef.current?.focus();
    }, 30);
  };

  // stop response
  const onUserStop = (messageId: string) => {
    chatStore.cancelChatRun(session.id, messageId);
  };

  useSyncGlobalModelConfig(chatStore, session, config.modelConfig);

  // check if should send message
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // if ArrowUp and no userInput, fill with last input
    if (
      e.key === "ArrowUp" &&
      userInput.length <= 0 &&
      !(e.metaKey || e.altKey || e.ctrlKey)
    ) {
      setUserInput(chatStore.lastInput ?? "");
      e.preventDefault();
      return;
    }
    if (shouldSubmit(e) && promptHints.length === 0) {
      doSubmit(userInput);
      e.preventDefault();
    }
  };
  const onDelete = (msgId: string) => {
    chatStore.deleteMessage(session.id, msgId);
  };

  const onResend = (message: ChatMessage) => {
    setIsLoading(true);
    chatStore
      .retryMessage(session.id, message.id)
      .then((prepared) => {
        setIsLoading(false);
        if (!prepared) console.error("[Chat] failed to resend", message);
      })
      .catch((error) => {
        setIsLoading(false);
        showToast(
          error instanceof Error ? error.message : Locale.Memory.CompactFailed,
        );
      });
    inputRef.current?.focus();
  };

  const onPinMessage = (message: ChatMessage) => {
    chatStore.updateSessionMetadata(session.id, (session) => {
      session.pinnedInputs.push({
        ...createMessage({
          role: message.role,
          content: message.content,
          date: message.date,
        }),
        outlineLevel: 0,
      } as ChatMessage);
    });

    showToast(Locale.Chat.Actions.PinToastContent, {
      text: Locale.Chat.Actions.PinToastAction,
      onClick: () => {
        setShowPromptModal(true);
      },
    });
  };

  const accessStore = useAccessStore();
  const [speechStatus, setSpeechStatus] = useState(false);
  const [speechLoading, setSpeechLoading] = useState(false);

  async function openaiSpeech(text: string) {
    if (speechStatus) {
      ttsPlayer.stop();
      setSpeechStatus(false);
    } else {
      var api: ClientApi;
      api = new ClientApi(ModelProvider.GPT);
      const config = useAppConfig.getState();
      setSpeechLoading(true);
      ttsPlayer.init();
      let audioBuffer: ArrayBuffer;
      const { markdownToTxt } = require("markdown-to-txt");
      const textContent = markdownToTxt(text);
      if (config.ttsConfig.engine !== DEFAULT_TTS_ENGINE) {
        const edgeVoiceName = accessStore.edgeVoiceName();
        const tts = new MsEdgeTTS();
        await tts.setMetadata(
          edgeVoiceName,
          OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
        );
        audioBuffer = await tts.toArrayBuffer(textContent);
      } else {
        audioBuffer = await api.llm.speech({
          model: config.ttsConfig.model,
          input: textContent,
          voice: config.ttsConfig.voice,
          speed: config.ttsConfig.speed,
        });
      }
      setSpeechStatus(true);
      ttsPlayer
        .play(audioBuffer, () => {
          setSpeechStatus(false);
        })
        .catch((e) => {
          console.error("[OpenAI Speech]", e);
          showToast(prettyObject(e));
          setSpeechStatus(false);
        })
        .finally(() => setSpeechLoading(false));
    }
  }

  const context: RenderMessage[] = session.mask.hideContext
    ? []
    : session.mask.context.slice();

  if (
    context.length === 0 &&
    session.messages.at(0)?.content !== BOT_HELLO.content
  ) {
    const copiedHello = Object.assign({}, BOT_HELLO);
    if (!accessStore.isAuthorized()) {
      copiedHello.content = Locale.Error.Unauthorized;
    }
    context.push(copiedHello);
  }

  // preview messages
  const visibleSessionMessages = getSessionActiveMessages(session);
  const renderMessages = context
    .concat(visibleSessionMessages as RenderMessage[])
    .concat(
      isLoading
        ? [
            {
              ...createMessage({ role: "assistant", content: "……" }),
              preview: true,
            },
          ]
        : [],
    )
    .concat(
      userInput.length > 0 && config.sendPreviewBubble
        ? [
            {
              ...createMessage({ role: "user", content: userInput }),
              preview: true,
            },
          ]
        : [],
    );

  const [msgRenderIndex, _setMsgRenderIndex] = useState(
    Math.max(0, renderMessages.length - CHAT_PAGE_SIZE),
  );
  const lastScrollTop = useRef(0);

  function setMsgRenderIndex(newIndex: number) {
    newIndex = Math.min(renderMessages.length - CHAT_PAGE_SIZE, newIndex);
    newIndex = Math.max(0, newIndex);
    _setMsgRenderIndex(newIndex);
  }

  const endRenderIndex = Math.min(
    msgRenderIndex + 3 * CHAT_PAGE_SIZE,
    renderMessages.length,
  );
  const messages = renderMessages.slice(msgRenderIndex, endRenderIndex);

  const onChatBodyScroll = (e: HTMLElement) => {
    const previousScrollTop = lastScrollTop.current;
    const { pageDirection } = getChatScrollUpdate({
      scrollTop: e.scrollTop,
      clientHeight: e.clientHeight,
      scrollHeight: e.scrollHeight,
      isMobileScreen,
      previousScrollTop,
    });
    lastScrollTop.current = e.scrollTop;
    handleScroll();

    if (pageDirection !== 0) {
      setMsgRenderIndex(msgRenderIndex + pageDirection * CHAT_PAGE_SIZE);
    }
  };

  function scrollToBottom() {
    setMsgRenderIndex(renderMessages.length - CHAT_PAGE_SIZE);
    requestBottom("button");
  }

  const [showPromptModal, setShowPromptModal] = useState(false);

  const [clientConfig] = useState(getClientConfig);

  const autoFocus = !isMobileScreen; // wont auto focus on mobile screen
  const showMaxIcon = !isMobileScreen && !clientConfig?.isApp;

  useCommand({
    fill: setUserInput,
    submit: (text) => {
      doSubmit(text);
    },
    code: (text) => {
      if (accessStore.disableFastLink) return;
      console.log("[Command] got code from url: ", text);
      showConfirm(Locale.URLCommand.Code + `code = ${text}`).then((res) => {
        if (res) {
          accessStore.update((access) => (access.accessCode = text));
        }
      });
    },
    settings: (text) => {
      if (accessStore.disableFastLink) return;

      try {
        const payload = JSON.parse(text) as {
          key?: string;
          url?: string;
        };

        console.log("[Command] got settings from url: ", payload);

        if (payload.key || payload.url) {
          showConfirm(
            Locale.URLCommand.Settings +
              `\n${JSON.stringify(payload, null, 4)}`,
          ).then((res) => {
            if (!res) return;
            if (payload.key) {
              accessStore.update(
                (access) => (access.openaiApiKey = payload.key!),
              );
            }
            if (payload.url) {
              accessStore.update((access) => (access.openaiUrl = payload.url!));
            }
            accessStore.update((access) => (access.useCustomConfig = true));
          });
        }
      } catch {
        console.error("[Command] failed to get settings from url: ", text);
      }
    },
  });

  // edit / insert message modal
  const [isEditingMessage, setIsEditingMessage] = useState(false);

  // remember unfinished input
  useEffect(() => {
    const key = UNFINISHED_INPUT(session.id);
    const dom = inputRef.current;
    return () => {
      localStorage.setItem(key, dom?.value ?? "");
    };
  }, [session.id]);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const currentModel = chatStore.currentSession().mask.modelConfig.model;
      if (!isVisionModel(currentModel)) {
        return;
      }
      const items = (event.clipboardData || window.clipboardData).items;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          event.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const images: string[] = [];
            images.push(...attachImages);
            images.push(
              ...(await new Promise<string[]>((res, rej) => {
                setUploading(true);
                const imagesData: string[] = [];
                uploadImageRemote(file)
                  .then((dataUrl) => {
                    imagesData.push(dataUrl);
                    setUploading(false);
                    res(imagesData);
                  })
                  .catch((e) => {
                    setUploading(false);
                    rej(e);
                  });
              })),
            );
            const imagesLength = images.length;

            if (imagesLength > 3) {
              images.splice(3, imagesLength - 3);
            }
            setAttachImages(images);
          }
        }
      }
    },
    [attachImages, chatStore],
  );

  async function uploadImage() {
    const images: string[] = [];
    images.push(...attachImages);

    images.push(
      ...(await new Promise<string[]>((res, rej) => {
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept =
          "image/png, image/jpeg, image/webp, image/heic, image/heif";
        fileInput.multiple = true;
        fileInput.onchange = (event: any) => {
          setUploading(true);
          const files = event.target.files;
          const imagesData: string[] = [];
          for (let i = 0; i < files.length; i++) {
            const file = event.target.files[i];
            uploadImageRemote(file)
              .then((dataUrl) => {
                imagesData.push(dataUrl);
                if (
                  imagesData.length === 3 ||
                  imagesData.length === files.length
                ) {
                  setUploading(false);
                  res(imagesData);
                }
              })
              .catch((e) => {
                setUploading(false);
                rej(e);
              });
          }
        };
        fileInput.click();
      })),
    );

    const imagesLength = images.length;
    if (imagesLength > 3) {
      images.splice(3, imagesLength - 3);
    }
    setAttachImages(images);
  }

  // 快捷键 shortcut keys
  const [showShortcutKeyModal, setShowShortcutKeyModal] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 打开新聊天 command + shift + o
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        setTimeout(() => {
          chatStore.newSession();
          navigate(Path.Chat);
        }, 10);
      }
      // 聚焦聊天输入 shift + esc
      else if (event.shiftKey && event.key.toLowerCase() === "escape") {
        event.preventDefault();
        inputRef.current?.focus();
      }
      // 复制最后一个代码块 command + shift + ;
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.code === "Semicolon"
      ) {
        event.preventDefault();
        const copyCodeButton =
          document.querySelectorAll<HTMLElement>(".copy-code-button");
        if (copyCodeButton.length > 0) {
          copyCodeButton[copyCodeButton.length - 1].click();
        }
      }
      // 复制最后一个回复 command + shift + c
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "c"
      ) {
        event.preventDefault();
        const lastNonUserMessage = messages
          .filter((message) => message.role !== "user")
          .pop();
        if (lastNonUserMessage) {
          const lastMessageContent = getMessageTextContent(lastNonUserMessage);
          copyToClipboard(lastMessageContent);
        }
      }
      // 展示快捷键 command + /
      else if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        setShowShortcutKeyModal(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [messages, chatStore, navigate, session]);

  const [showChatSidePanel, setShowChatSidePanel] = useState(false);

  return (
    <>
      <div className={styles.chat} key={session.id}>
        <div className="window-header" data-tauri-drag-region>
          {isMobileScreen && (
            <div className="window-actions">
              <div className={"window-action-button"}>
                <IconButton
                  icon={<ReturnIcon />}
                  bordered
                  title={Locale.Chat.Actions.ChatList}
                  onClick={() => navigate(Path.Home)}
                />
              </div>
            </div>
          )}

          <div
            className={clsx("window-header-title", styles["chat-body-title"])}
          >
            <div
              className={clsx(
                "window-header-main-title",
                styles["chat-body-main-title"],
              )}
              onClickCapture={() => setIsEditingMessage(true)}
            >
              {!session.topic ? DEFAULT_TOPIC : session.topic}
            </div>
            <div className="window-header-sub-title">
              {Locale.Chat.SubTitle(session.messages.length)}
            </div>
          </div>
          <div className="window-actions">
            {!isMobileScreen && (
              <div className="window-action-button">
                <IconButton
                  icon={<RenameIcon />}
                  bordered
                  title={Locale.Chat.EditMessage.Title}
                  aria={Locale.Chat.EditMessage.Title}
                  onClick={() => setIsEditingMessage(true)}
                />
              </div>
            )}
            <div className="window-action-button">
              <IconButton
                icon={<ExportIcon />}
                bordered
                title={Locale.Chat.Actions.Export}
                onClick={() => {
                  setShowExport(true);
                }}
              />
            </div>
            {showMaxIcon && (
              <div className="window-action-button">
                <IconButton
                  icon={config.tightBorder ? <MinIcon /> : <MaxIcon />}
                  bordered
                  title={Locale.Chat.Actions.FullScreen}
                  aria={Locale.Chat.Actions.FullScreen}
                  onClick={() => {
                    config.update(
                      (config) => (config.tightBorder = !config.tightBorder),
                    );
                  }}
                />
              </div>
            )}
          </div>

          <PromptToast
            showToast={!isAtBottom}
            showModal={showPromptModal}
            setShowModal={setShowPromptModal}
          />
        </div>
        <div className={styles["chat-main"]}>
          <div className={styles["chat-body-container"]}>
            <div
              className={styles["chat-body"]}
              ref={scrollRef}
              onScroll={(e) => onChatBodyScroll(e.currentTarget)}
              onWheel={userScrollHandlers.onWheel}
              onTouchMove={userScrollHandlers.onTouchMove}
              onTouchEnd={userScrollHandlers.onTouchEnd}
              onPointerDown={userScrollHandlers.onPointerDown}
              onKeyDown={userScrollHandlers.onKeyDown}
              onKeyUp={userScrollHandlers.onKeyUp}
              onMouseDown={() => inputRef.current?.blur()}
              onTouchStart={() => inputRef.current?.blur()}
            >
              <div ref={contentRef}>
                {messages
                  // TODO
                  // .filter((m) => !m.isMcpResponse)
                  .map((message, i) => {
                    const absoluteIndex = msgRenderIndex + i;
                    const isUser = message.role === "user";
                    const isContext = absoluteIndex < context.length;
                    const storedNode =
                      isContext || message.preview ? undefined : message;
                    const messageText = getMessageTextContent(message);
                    const messageImages = getMessageImages(message);
                    const isActiveTurn = isMessageInStreamingTurn(
                      renderMessages,
                      absoluteIndex,
                    );
                    const hasMessageOutput =
                      message.content.length > 0 || Boolean(message.reasoning);
                    const isActionCandidate =
                      absoluteIndex > 0 &&
                      !message.preview &&
                      !isContext &&
                      hasMessageOutput;
                    const showActions =
                      isActionCandidate &&
                      (!isActiveTurn || Boolean(message.streaming));
                    const showTyping = message.preview || message.streaming;
                    const renderActions =
                      showActions && actionMessageId === message.id;
                    const editMessage = async () => {
                      if (storedNode) {
                        setViewingNodeId(storedNode.id);
                        return;
                      }
                      const newMessage = await showPrompt(
                        Locale.Chat.Actions.Edit,
                        messageText,
                        10,
                      );
                      const newContent = replaceMessageText(
                        message,
                        newMessage,
                      );
                      chatStore.updateSessionMetadata(session.id, (draft) => {
                        const item = draft.mask.context.find(
                          (item) => item.id === message.id,
                        );
                        if (item) item.content = newContent;
                      });
                    };

                    return (
                      <React.Fragment key={message.id}>
                        <div
                          id={`chat-message-${message.id}`}
                          className={clsx(
                            isUser
                              ? styles["chat-message-user"]
                              : styles["chat-message"],
                          )}
                          onPointerEnter={() => setActionMessageId(message.id)}
                          onPointerLeave={() =>
                            setActionMessageId((current) =>
                              current === message.id ? undefined : current,
                            )
                          }
                          onFocusCapture={() => setActionMessageId(message.id)}
                          onBlurCapture={(event) => {
                            if (
                              !event.currentTarget.contains(
                                event.relatedTarget as Node | null,
                              )
                            ) {
                              setActionMessageId((current) =>
                                current === message.id ? undefined : current,
                              );
                            }
                          }}
                          onClick={() => {
                            if (isMobileScreen) setActionMessageId(message.id);
                          }}
                        >
                          <div className={styles["chat-message-container"]}>
                            <div className={styles["chat-message-header"]}>
                              <div className={styles["chat-message-avatar"]}>
                                <div className={styles["chat-message-edit"]}>
                                  <IconButton
                                    icon={<EditIcon />}
                                    aria={Locale.Chat.Actions.Edit}
                                    onClick={editMessage}
                                  />
                                </div>
                                {isUser ? (
                                  <Avatar avatar={config.avatar} />
                                ) : (
                                  <>
                                    {["system"].includes(message.role) ? (
                                      <Avatar avatar="2699-fe0f" />
                                    ) : (
                                      <MaskAvatar
                                        avatar={session.mask.avatar}
                                        model={
                                          message.model ||
                                          session.mask.modelConfig.model
                                        }
                                      />
                                    )}
                                  </>
                                )}
                              </div>
                              {!isUser && (
                                <div className={styles["chat-model-name"]}>
                                  {message.model}
                                </div>
                              )}

                              {renderActions && (
                                <div className={styles["chat-message-actions"]}>
                                  <div className={styles["chat-input-actions"]}>
                                    {message.streaming ? (
                                      <ChatAction
                                        text={Locale.Chat.Actions.Stop}
                                        icon={<StopIcon />}
                                        onClick={() =>
                                          onUserStop(message.id ?? i)
                                        }
                                      />
                                    ) : (
                                      <>
                                        <ChatAction
                                          text={Locale.Chat.Actions.Retry}
                                          icon={<ResetIcon />}
                                          onClick={() => onResend(message)}
                                        />

                                        <ChatAction
                                          text={Locale.Chat.Actions.Delete}
                                          icon={<DeleteIcon />}
                                          onClick={() =>
                                            onDelete(message.id ?? i)
                                          }
                                        />

                                        <ChatAction
                                          text={Locale.Chat.Actions.Copy}
                                          icon={<CopyIcon />}
                                          onClick={() =>
                                            copyToClipboard(messageText)
                                          }
                                        />
                                        {config.ttsConfig.enable && (
                                          <ChatAction
                                            text={
                                              speechStatus
                                                ? Locale.Chat.Actions.StopSpeech
                                                : Locale.Chat.Actions.Speech
                                            }
                                            icon={
                                              speechStatus ? (
                                                <SpeakStopIcon />
                                              ) : (
                                                <SpeakIcon />
                                              )
                                            }
                                            onClick={() =>
                                              openaiSpeech(messageText)
                                            }
                                          />
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                            {message?.tools?.length == 0 && showTyping && (
                              <div className={styles["chat-message-status"]}>
                                {Locale.Chat.Typing}
                              </div>
                            )}
                            {/*@ts-ignore*/}
                            {message?.tools?.length > 0 && (
                              <div className={styles["chat-message-tools"]}>
                                {message?.tools?.map((tool) => (
                                  <div
                                    key={tool.id}
                                    title={tool?.errorMsg}
                                    className={styles["chat-message-tool"]}
                                  >
                                    {tool.isError === false ? (
                                      <ConfirmIcon />
                                    ) : tool.isError === true ? (
                                      <CloseIcon />
                                    ) : (
                                      <LoadingButtonIcon />
                                    )}
                                    <span>{tool?.function?.name}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className={styles["chat-message-item"]}>
                              {!isUser && (
                                <ReasoningDisclosure
                                  reasoning={message.reasoning ?? ""}
                                  streaming={message.streaming}
                                  reasoningDurationMs={
                                    message.reasoningDurationMs
                                  }
                                  content={messageText}
                                />
                              )}
                              <Markdown
                                key={message.streaming ? "loading" : "done"}
                                content={messageText}
                                loading={
                                  (message.preview || message.streaming) &&
                                  message.content.length === 0 &&
                                  !isUser
                                }
                                onDoubleClickCapture={() => {
                                  if (!isMobileScreen) return;
                                  setUserInput(messageText);
                                }}
                                fontSize={fontSize}
                                fontFamily={fontFamily}
                                parentRef={scrollRef}
                                defaultShow={i >= messages.length - 6}
                              />
                              {messageImages.length == 1 && (
                                <>
                                  {/* External and data URLs cannot use Next image optimization. */}
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    className={
                                      styles["chat-message-item-image"]
                                    }
                                    src={messageImages[0]}
                                    alt=""
                                  />
                                </>
                              )}
                              {messageImages.length > 1 && (
                                <div
                                  className={styles["chat-message-item-images"]}
                                  style={
                                    {
                                      "--image-count": messageImages.length,
                                    } as React.CSSProperties
                                  }
                                >
                                  {messageImages.map((image, index) => {
                                    return (
                                      <React.Fragment key={index}>
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                          className={
                                            styles[
                                              "chat-message-item-image-multi"
                                            ]
                                          }
                                          src={image}
                                          alt=""
                                        />
                                      </React.Fragment>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                            {message?.audio_url && (
                              <div className={styles["chat-message-audio"]}>
                                <audio src={message.audio_url} controls />
                              </div>
                            )}

                            <div className={styles["chat-message-meta"]}>
                              {!isActiveTurn && showActions && storedNode && (
                                <div
                                  className={clsx(
                                    styles["chat-message-node-actions"],
                                    styles["chat-input-actions"],
                                    renderActions &&
                                      styles[
                                        "chat-message-node-actions-active"
                                      ],
                                  )}
                                >
                                  <ChatAction
                                    text={Locale.Chat.Graph.Branch}
                                    icon={<BranchIcon />}
                                    onClick={() =>
                                      setBranchParentId(storedNode.id)
                                    }
                                  />
                                  <ChatAction
                                    text={Locale.Chat.Graph.Continue}
                                    icon={<ContinueIcon />}
                                    active={
                                      session.activeCursorId === storedNode.id
                                    }
                                    onClick={() => {
                                      chatStore.continueFromNode(
                                        session.id,
                                        storedNode.id,
                                      );
                                      inputRef.current?.focus();
                                    }}
                                  />
                                </div>
                              )}
                              <div
                                className={styles["chat-message-action-date"]}
                              >
                                {isContext
                                  ? Locale.Chat.IsContext
                                  : message.date.toLocaleString()}
                              </div>
                            </div>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}
              </div>
            </div>
            <div className={styles["chat-input-panel"]}>
              <PromptHints
                prompts={promptHints}
                onPromptSelect={onPromptSelect}
              />

              <ChatActions
                uploadImage={uploadImage}
                setAttachImages={setAttachImages}
                setUploading={setUploading}
                showPromptModal={() => setShowPromptModal(true)}
                showGlobalMemory={() => setShowGlobalMemory(true)}
                scrollToBottom={scrollToBottom}
                hitBottom={isAtBottom}
                uploading={uploading}
                showPromptHints={() => {
                  // Click again to close
                  if (promptHints.length > 0) {
                    setPromptHints([]);
                    return;
                  }

                  inputRef.current?.focus();
                  setUserInput("/");
                  onSearch("");
                }}
                setShowShortcutKeyModal={setShowShortcutKeyModal}
                setUserInput={setUserInput}
                setShowChatSidePanel={setShowChatSidePanel}
              />
              <label
                className={clsx(styles["chat-input-panel-inner"], {
                  [styles["chat-input-panel-inner-attach"]]:
                    attachImages.length !== 0,
                })}
                htmlFor="chat-input"
              >
                <textarea
                  id="chat-input"
                  ref={inputRef}
                  className={styles["chat-input"]}
                  placeholder={Locale.Chat.Input(submitKey)}
                  onInput={(e) => onInput(e.currentTarget.value)}
                  value={userInput}
                  onKeyDown={onInputKeyDown}
                  onPaste={handlePaste}
                  rows={inputRows}
                  autoFocus={autoFocus}
                  style={{
                    fontSize: config.fontSize,
                    fontFamily: config.fontFamily,
                  }}
                />
                {attachImages.length != 0 && (
                  <div className={styles["attach-images"]}>
                    {attachImages.map((image, index) => {
                      return (
                        <div
                          key={index}
                          className={styles["attach-image"]}
                          style={{ backgroundImage: `url("${image}")` }}
                        >
                          <div className={styles["attach-image-mask"]}>
                            <DeleteImageButton
                              deleteImage={() => {
                                setAttachImages(
                                  attachImages.filter((_, i) => i !== index),
                                );
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <IconButton
                  icon={<SendWhiteIcon />}
                  text={Locale.Chat.Send}
                  className={styles["chat-input-send"]}
                  type="primary"
                  onClick={() => doSubmit(userInput)}
                />
              </label>
            </div>
          </div>
          <div
            className={clsx(styles["chat-side-panel"], {
              [styles["mobile"]]: isMobileScreen,
              [styles["chat-side-panel-show"]]: showChatSidePanel,
            })}
          >
            {showChatSidePanel && (
              <RealtimeChat
                onClose={() => {
                  setShowChatSidePanel(false);
                }}
                onStartVoice={async () => {
                  console.log("start voice");
                }}
              />
            )}
          </div>
        </div>
      </div>
      {showExport && (
        <ExportMessageModal onClose={() => setShowExport(false)} />
      )}

      {isEditingMessage && (
        <EditMessageModal
          onClose={() => {
            setIsEditingMessage(false);
          }}
        />
      )}

      {showShortcutKeyModal && (
        <ShortcutKeyModal onClose={() => setShowShortcutKeyModal(false)} />
      )}

      {viewingNodeId && (
        <NodeViewerModal
          nodeId={viewingNodeId}
          onClose={() => setViewingNodeId(undefined)}
          onPin={onPinMessage}
        />
      )}

      {branchParentId && (
        <BranchSelectorModal
          parentId={branchParentId}
          onClose={() => setBranchParentId(undefined)}
          onStartBranch={() => inputRef.current?.focus()}
        />
      )}

      {showGlobalMemory && (
        <GlobalMemoryModal onClose={() => setShowGlobalMemory(false)} />
      )}
    </>
  );
}

export function Chat() {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  return <ChatView key={session.id} />;
}
