import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import BrainIcon from "../../icons/brain.svg";
import BranchIcon from "../../icons/branch.svg";
import SettingsIcon from "../../icons/chat-settings.svg";
import DeleteIcon from "../../icons/clear.svg";
import CloseIcon from "../../icons/close.svg";
import ConfirmIcon from "../../icons/confirm.svg";
import ContinueIcon from "../../icons/continue.svg";
import CopyIcon from "../../icons/copy.svg";
import ImageIcon from "../../icons/image.svg";
import LoadingButtonIcon from "../../icons/loading.svg";
import MaskIcon from "../../icons/mask.svg";
import MaxIcon from "../../icons/max.svg";
import MinIcon from "../../icons/min.svg";
import PromptIcon from "../../icons/prompt.svg";
import ResetIcon from "../../icons/reload.svg";
import { default as EditIcon, default as RenameIcon } from "../../icons/rename.svg";
import ReturnIcon from "../../icons/return.svg";
import SendWhiteIcon from "../../icons/send-white.svg";
import ExportIcon from "../../icons/share.svg";
import SpeakStopIcon from "../../icons/speak-stop.svg";
import SpeakIcon from "../../icons/speak.svg";
import LoadingIcon from "../../icons/three-dots.svg";

import BottomIcon from "../../icons/bottom.svg";
import QualityIcon from "../../icons/hd.svg";
import HeadphoneIcon from "../../icons/headphone.svg";
import StyleIcon from "../../icons/palette.svg";
import StopIcon from "../../icons/pause.svg";
import PluginIcon from "../../icons/plugin.svg";
import RobotIcon from "../../icons/robot.svg";
import ShortcutkeyIcon from "../../icons/shortcutkey.svg";
import SizeIcon from "../../icons/size.svg";
import McpToolIcon from "../../icons/tool.svg";
import {
  BOT_HELLO,
  ChatSession,
  DEFAULT_TOPIC,
  ModelConfig,
  ModelType,
  SubmitKey,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "../../store";

import {
  autoGrowTextArea,
  copyToClipboard,
  getMessageImages,
  getMessageText,
  getModelSizes,
  isDalle3,
  isVisionModel,
  safeLocalStorage,
  showPlugins,
  supportsCustomSize,
  useMobileScreen,
} from "../../utils";

import { uploadImage as uploadImageRemote } from "@/app/utils/chat";

import isEqual from "lodash-es/isEqual";
import dynamic from "next/dynamic";

import Locale from "../../locales";
import { Prompt, usePromptStore } from "../../store/prompt";
import { DalleQuality, DalleStyle, ModelSize } from "../../typing";

import { IconButton } from "../button";
import styles from "./chat.module.scss";

import { useNavigate } from "react-router";
import { ClientApi } from "../../client/api";
import { ChatCommandPrefix, useChatCommand, useCommand } from "../../command";
import { getClientConfig } from "../../config/client";
import {
  CHAT_PAGE_SIZE,
  DEFAULT_TTS_ENGINE,
  Path,
  ServiceProvider,
  UNFINISHED_INPUT,
} from "../../constant";
import { useChatControllerStore } from "../../store/chat-controller";
import { createTTSPlayer } from "../../utils/audio";
import { prettyObject } from "../../utils/format";
import { useAllModels } from "../../utils/hooks";
import { MsEdgeTTS, OUTPUT_FORMAT } from "../../utils/ms_edge_tts";
import { Avatar } from "../emoji";
import { ExportMessageModal } from "../exporter";
import { MaskAvatar } from "../mask";
import { ReasoningDisclosure } from "../reasoning";
import { Selector, showConfirm, showToast } from "../ui-lib";

import { getAvailableClientsCount, isMcpEnabled } from "@/app/mcp/actions";
import clsx from "clsx";
import { isEmpty } from "lodash-es";
import { Conversation } from "../../utils/conversation";
import { getModelProvider } from "../../utils/model";
import { BranchSelectorModal } from "./branch-selector-modal";
import { getChatScrollUpdate, useScrollToBottom } from "./chat-scroll";
import { EditMessageModal } from "./edit-message-modal";
import { GlobalMemoryModal } from "./global-memory-modal";
import { NodeViewerModal } from "./node-viewer-modal";
import { SessionConfigModel } from "./session-config-modal";
import { ShortcutKeyModal } from "./shortcut-key-modal";

const localStorage = safeLocalStorage();

const ttsPlayer = createTTSPlayer();

const Markdown = dynamic(async () => (await import("../markdown")).Markdown, {
  loading: () => <LoadingIcon />,
});

const RealtimeChat = dynamic(
  async () => (await import("@/app/components/realtime-chat")).RealtimeChat,
  {
    loading: () => <LoadingIcon />,
  },
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
      {props.showModal && <SessionConfigModel onClose={() => props.setShowModal(false)} />}
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
    if (e.key === "Enter" && (e.nativeEvent.isComposing || isComposing.current)) return false;
    return (
      (config.submitKey === SubmitKey.AltEnter && e.altKey) ||
      (config.submitKey === SubmitKey.CtrlEnter && e.ctrlKey) ||
      (config.submitKey === SubmitKey.ShiftEnter && e.shiftKey) ||
      (config.submitKey === SubmitKey.MetaEnter && e.metaKey) ||
      (config.submitKey === SubmitKey.Enter && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey)
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
  const effectiveSelectIndex = Math.min(selectIndex, Math.max(0, props.prompts.length - 1));
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isLongPressRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState({
    full: 16,
    icon: 16,
  });

  function updateWidth() {
    if (!iconRef.current || !textRef.current) return;
    const getWidth = (dom: HTMLDivElement) => dom.scrollWidth;
    const textWidth = getWidth(textRef.current);
    const iconWidth = getWidth(iconRef.current);
    setWidth({
      full: textWidth + iconWidth,
      icon: iconWidth,
    });
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      className={clsx(styles["chat-input-action"], "clickable", {
        [styles["chat-input-action-active"]]: props.active,
        [styles["chat-input-action-expanded"]]: expanded,
      })}
      onClick={() => {
        props.onClick();
        setTimeout(updateWidth, 1);
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          updateWidth();
        }
      }}
      onTouchStart={() => {
        updateWidth();
        isLongPressRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);

        timerRef.current = setTimeout(() => {
          isLongPressRef.current = true;
          setExpanded(true);
        }, 350);
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        if (!touch) return;
        const rect = event.currentTarget.getBoundingClientRect();
        // Cancel only if finger genuinely leaves the button bounding box
        const isOutOfBounds =
          touch.clientX < rect.left ||
          touch.clientX > rect.right ||
          touch.clientY < rect.top ||
          touch.clientY > rect.bottom;

        if (isOutOfBounds) {
          if (timerRef.current) clearTimeout(timerRef.current);
          if (isLongPressRef.current) {
            setExpanded(false);
          }
        }
      }}
      onTouchEnd={(event) => {
        if (timerRef.current) clearTimeout(timerRef.current);

        if (isLongPressRef.current) {
          event.preventDefault();
          isLongPressRef.current = false;
          setExpanded(false);
        }
        // Fast taps rely on native onClick to avoid premature modal mounting and ghost-click bleed
      }}
      onTouchCancel={() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        isLongPressRef.current = false;
        setExpanded(false);
      }}
      onFocus={updateWidth}
      onBlur={() => setExpanded(false)}
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

export function isMessageInStreamingTurn(messages: Conversation.Message[], messageIndex: number) {
  const message = messages[messageIndex];
  if (!message) return false;
  if (message.streaming) return true;
  if (message.role !== "user") return false;

  const response = messages[messageIndex + 1];
  return Boolean(response && response.role === "assistant" && response.streaming);
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
  const cursorNode = session.messages.find((message) => message.id === session.activeCursorId);

  // stop all responses
  const couldStop = useChatControllerStore((state) => state.runs.size > 0);
  const stopAll = useChatControllerStore((state) => state.cancelAll);

  // switch model
  const currentModel = session.mask.modelConfig.model;
  const currentProviderName = session.mask.modelConfig?.providerName || ServiceProvider.OpenAI;
  const allModels = useAllModels();
  const models = useMemo(() => {
    const filteredModels = allModels.filter((m) => m.available);
    const defaultModel = filteredModels.find((m) => m.isDefault);

    if (defaultModel) {
      const arr = [defaultModel, ...filteredModels.filter((m) => m !== defaultModel)];
      return arr;
    } else {
      return filteredModels;
    }
  }, [allModels]);
  const currentModelName = useMemo(() => {
    const model = models.find(
      (m) => m.name == currentModel && m?.provider?.providerName == currentProviderName,
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
  const currentSize = session.mask.modelConfig?.size ?? ("1024x1024" as ModelSize);
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
          <ChatAction onClick={stopAll} text={Locale.Chat.InputActions.Stop} icon={<StopIcon />} />
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
              title: `${m.displayName}${m?.provider?.providerName ? " (" + m?.provider?.providerName + ")" : ""}`,
              value: `${m.name}@${m?.provider?.providerName}`,
            }))}
            onClose={() => setShowModelSelector(false)}
            onSelection={(s) => {
              if (s.length === 0) return;
              const [model, providerName] = getModelProvider(s[0]);
              chatStore.updateSession(session.id, (draft) => {
                draft.mask.modelConfig.model = model as ModelType;
                draft.mask.modelConfig.providerName = providerName as ServiceProvider;
                draft.mask.syncGlobalConfig = false;
              });
              if (providerName == "ByteDance") {
                const selectedModel = models.find(
                  (m) => m.name == model && m?.provider?.providerName == providerName,
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
              chatStore.updateSession(session.id, (draft) => {
                draft.mask.modelConfig.size = size;
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
              chatStore.updateSession(session.id, (draft) => {
                draft.mask.modelConfig.quality = quality;
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
              chatStore.updateSession(session.id, (draft) => {
                draft.mask.modelConfig.style = style;
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
              chatStore.updateSession(session.id, (draft) => {
                draft.mask.plugin = s as string[];
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
      {config.realtimeConfig.enable && (
        <div className={styles["chat-input-actions-end"]}>
          <ChatAction
            onClick={() => props.setShowChatSidePanel(true)}
            text={"Realtime Chat"}
            icon={<HeadphoneIcon />}
          />
        </div>
      )}
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

export function useEnsureAvailableModel(
  chatStore: Pick<ReturnType<typeof useChatStore.getState>, "updateSession">,
  config: Pick<ReturnType<typeof useAppConfig.getState>, "modelConfig" | "update">,
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
      if (globalModel === nextModel.name && globalProviderName === nextProviderName) {
        return;
      }
      updateConfig((config) => {
        config.modelConfig.model = nextModel.name;
        config.modelConfig.providerName = nextProviderName;
      });
    } else {
      // A detached session owns its model and must not rewrite global config.
      chatStore.updateSession(session.id, (session) => {
        if (
          session.mask.modelConfig.model === nextModel.name &&
          session.mask.modelConfig.providerName === nextProviderName
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
  chatStore: Pick<ReturnType<typeof useChatStore.getState>, "updateSession">,
  session: ChatSession,
  modelConfig: ModelConfig,
) {
  useEffect(() => {
    if (!session.mask.syncGlobalConfig || isEqual(session.mask.modelConfig, modelConfig)) {
      return;
    }

    chatStore.updateSession(session.id, (session) => {
      if (!session.mask.syncGlobalConfig || isEqual(session.mask.modelConfig, modelConfig)) {
        return false;
      }

      session.mask.modelConfig = { ...modelConfig };
    });
  }, [chatStore, modelConfig, session.id, session.mask.modelConfig, session.mask.syncGlobalConfig]);
}

function ChatView() {
  type RenderMessage = Conversation.Message & { preview?: boolean };

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
  const { scrollRef, contentRef, isAtBottom, requestBottom, handleScroll, userScrollHandlers } =
    useScrollToBottom(isMobileScreen ? 4 : 10);
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
      const inputRows = Math.min(20, Math.max(2 + Number(!isMobileScreen), rows));
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
        showToast(error instanceof Error ? error.message : Locale.Memory.CompactFailed);
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
    useChatControllerStore.getState().cancel(messageId);
  };

  useSyncGlobalModelConfig(chatStore, session, config.modelConfig);

  // check if should send message
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // if ArrowUp and no userInput, fill with last input
    if (e.key === "ArrowUp" && userInput.length <= 0 && !(e.metaKey || e.altKey || e.ctrlKey)) {
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

  const onResend = (message: Conversation.Message) => {
    // when it is resending a message
    // 1. for a user's message, find the next bot response
    // 2. for a bot's message, find the last user's input
    // 3. delete original user input and bot's message
    // 4. resend the user's input
    setIsLoading(true);
    chatStore
      .retryMessage(session.id, message.id)
      .then((prepared) => {
        setIsLoading(false);
        if (!prepared) console.error("[Chat] failed to resend", message);
      })
      .catch((error) => {
        setIsLoading(false);
        showToast(error instanceof Error ? error.message : Locale.Memory.CompactFailed);
      });
    inputRef.current?.focus();
  };

  const onPinMessage = (message: Conversation.Message) => {
    chatStore.updateSession(session.id, (session) => {
      session.pinnedInputs.push({
        ...Conversation.createMessage({
          role: message.role,
          content: message.content,
          date: message.date,
        }),
        outlineLevel: 0,
      } as Conversation.Message);
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
      api = new ClientApi(ServiceProvider.OpenAI);
      const config = useAppConfig.getState();
      setSpeechLoading(true);
      ttsPlayer.init();
      let audioBuffer: ArrayBuffer;
      const { markdownToTxt } = require("markdown-to-txt");
      const textContent = markdownToTxt(text);
      if (config.ttsConfig.engine !== DEFAULT_TTS_ENGINE) {
        const edgeVoiceName = accessStore.edgeVoiceName();
        const tts = new MsEdgeTTS();
        await tts.setMetadata(edgeVoiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
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

  const context: RenderMessage[] = session.mask.hideContext ? [] : session.pinnedInputs.slice();

  if (context.length === 0 && session.messages.at(0)?.content !== BOT_HELLO.content) {
    const copiedHello = Object.assign({}, BOT_HELLO);
    if (!accessStore.isAuthorized()) {
      copiedHello.content = Locale.Error.Unauthorized;
    }
    context.push(copiedHello);
  }

  // preview messages
  const conversation = Conversation(session);
  const visibleSessionMessages = conversation.projectActive();

  const retryableMessageIds = new Set<string>();
  for (const node of visibleSessionMessages) {
    if (node.role !== "user") continue;
    retryableMessageIds.add(node.id);
    const response = conversation.node(node.id).sameLevelSuccessor;
    if (response?.role === "assistant") retryableMessageIds.add(response.id);
  }

  const renderMessages = context
    .concat(visibleSessionMessages as RenderMessage[])
    .concat(
      isLoading
        ? [
            {
              ...Conversation.createMessage({ role: "assistant", content: "……" }),
              preview: true,
            },
          ]
        : [],
    )
    .concat(
      userInput.length > 0 && config.sendPreviewBubble
        ? [
            {
              ...Conversation.createMessage({ role: "user", content: userInput }),
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

  const endRenderIndex = Math.min(msgRenderIndex + 3 * CHAT_PAGE_SIZE, renderMessages.length);
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
          showConfirm(Locale.URLCommand.Settings + `\n${JSON.stringify(payload, null, 4)}`).then(
            (res) => {
              if (!res) return;
              if (payload.key) {
                accessStore.update((access) => (access.openaiApiKey = payload.key!));
              }
              if (payload.url) {
                accessStore.update((access) => (access.openaiUrl = payload.url!));
              }
              accessStore.update((access) => (access.useCustomConfig = true));
            },
          );
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
        fileInput.accept = "image/png, image/jpeg, image/webp, image/heic, image/heif";
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
                if (imagesData.length === 3 || imagesData.length === files.length) {
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
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
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
      else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Semicolon") {
        event.preventDefault();
        const copyCodeButton = document.querySelectorAll<HTMLElement>(".copy-code-button");
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
        const lastNonUserMessage = messages.filter((message) => message.role !== "user").pop();
        if (lastNonUserMessage) {
          const lastMessageContent = getMessageText(lastNonUserMessage.content);
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

          <div className={clsx("window-header-title", styles["chat-body-title"])}>
            <div
              className={clsx("window-header-main-title", styles["chat-body-main-title"])}
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
                    config.update((config) => (config.tightBorder = !config.tightBorder));
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
                    const storedNode = isContext || message.preview ? undefined : message;
                    const messageText = getMessageText(message.content);
                    const messageImages = getMessageImages(message.content);
                    const isActiveTurn = isMessageInStreamingTurn(renderMessages, absoluteIndex);
                    const hasMessageOutput =
                      message.content.length > 0 || message.reasoning.length > 0;
                    const isActionCandidate =
                      absoluteIndex > 0 &&
                      !message.preview &&
                      !isContext &&
                      (hasMessageOutput || message.streaming);
                    const showActions = isActionCandidate && (!isActiveTurn || message.streaming);
                    const renderActions = showActions && actionMessageId === message.id;
                    const showTyping = message.preview || message.streaming;
                    const isCursorNode = storedNode?.id === session.activeCursorId;

                    return (
                      <React.Fragment key={message.id}>
                        <div
                          id={`chat-message-${message.id}`}
                          className={clsx(
                            isUser ? styles["chat-message-user"] : styles["chat-message"],
                            actionMessageId === message.id &&
                              styles["chat-message-actions-visible"],
                          )}
                          onPointerEnter={(event) => {
                            if (event.pointerType !== "touch") setActionMessageId(message.id);
                          }}
                          onFocusCapture={() => setActionMessageId(message.id)}
                          onPointerLeave={(event) => {
                            if (event.pointerType !== "touch") {
                              setActionMessageId((current) =>
                                current === message.id ? undefined : current,
                              );
                            }
                          }}
                          onPointerDown={(event) => {
                            if (event.pointerType === "touch") setActionMessageId(message.id);
                          }}
                          onPointerCancel={(event) => {
                            if (event.pointerType === "touch") setActionMessageId(undefined);
                          }}
                        >
                          <div className={styles["chat-message-container"]}>
                            <div className={styles["chat-message-header"]}>
                              <div className={styles["chat-message-avatar"]}>
                                {storedNode && !message.streaming && (
                                  <div className={styles["chat-message-edit"]}>
                                    <IconButton
                                      icon={<EditIcon />}
                                      aria={Locale.Chat.Actions.Edit}
                                      onClick={() => setViewingNodeId(storedNode.id)}
                                    />
                                  </div>
                                )}
                                {isUser ? (
                                  <Avatar avatar={config.avatar} />
                                ) : (
                                  <>
                                    {["system"].includes(message.role) ? (
                                      <Avatar avatar="2699-fe0f" />
                                    ) : (
                                      <MaskAvatar
                                        avatar={session.mask.avatar}
                                        model={message.model || session.mask.modelConfig.model}
                                      />
                                    )}
                                  </>
                                )}
                              </div>
                              {!isUser && (
                                <div className={styles["chat-model-name"]}>{message.model}</div>
                              )}

                              {renderActions && (
                                <div className={styles["chat-message-actions"]}>
                                  <div className={styles["chat-input-actions"]}>
                                    {message.streaming ? (
                                      <ChatAction
                                        text={Locale.Chat.Actions.Stop}
                                        icon={<StopIcon />}
                                        onClick={() => onUserStop(message.id)}
                                      />
                                    ) : (
                                      <>
                                        <ChatAction
                                          text={Locale.Chat.Actions.Retry}
                                          icon={<ResetIcon />}
                                          onClick={() => onResend(message)}
                                          disabled={!retryableMessageIds.has(message.id)}
                                        />

                                        <ChatAction
                                          text={Locale.Chat.Actions.Delete}
                                          icon={<DeleteIcon />}
                                          onClick={() => onDelete(message.id)}
                                        />

                                        <ChatAction
                                          text={Locale.Chat.Actions.Copy}
                                          icon={<CopyIcon />}
                                          onClick={() => copyToClipboard(messageText)}
                                        />
                                        {config.ttsConfig.enable && (
                                          <ChatAction
                                            text={
                                              speechStatus
                                                ? Locale.Chat.Actions.StopSpeech
                                                : Locale.Chat.Actions.Speech
                                            }
                                            icon={speechStatus ? <SpeakStopIcon /> : <SpeakIcon />}
                                            onClick={() => openaiSpeech(messageText)}
                                          />
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                            {message.tools.length === 0 && showTyping && (
                              <div className={styles["chat-message-status"]}>
                                {Locale.Chat.Typing}
                              </div>
                            )}
                            {message.tools.length > 0 && (
                              <div className={styles["chat-message-tools"]}>
                                {message.tools.map((tool) => (
                                  <div
                                    key={tool.id}
                                    title={tool.errorMsg}
                                    className={styles["chat-message-tool"]}
                                  >
                                    {tool.isError === false ? (
                                      <ConfirmIcon />
                                    ) : tool.isError === true ? (
                                      <CloseIcon />
                                    ) : (
                                      <LoadingButtonIcon />
                                    )}
                                    <span>{tool.function?.name}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className={styles["chat-message-item"]}>
                              {!isUser && (
                                <ReasoningDisclosure
                                  reasoning={message.reasoning}
                                  streaming={message.streaming}
                                  reasoningDurationMs={message.reasoningDurationMs}
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
                                    className={styles["chat-message-item-image"]}
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
                                          className={styles["chat-message-item-image-multi"]}
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
                                    (isCursorNode || actionMessageId === message.id) &&
                                      styles["chat-message-node-actions-active"],
                                  )}
                                >
                                  <ChatAction
                                    text={Locale.Chat.Graph.Branch}
                                    icon={<BranchIcon />}
                                    onClick={() => setBranchParentId(storedNode.id)}
                                  />
                                  <ChatAction
                                    text={Locale.Chat.Graph.Continue}
                                    icon={<ContinueIcon />}
                                    active={isCursorNode}
                                    onClick={() => {
                                      chatStore.continueFromNode(session.id, storedNode.id);
                                      inputRef.current?.focus();
                                    }}
                                  />
                                </div>
                              )}
                              <div className={styles["chat-message-action-date"]}>
                                {isContext ? Locale.Chat.IsContext : message.date.toLocaleString()}
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
              <PromptHints prompts={promptHints} onPromptSelect={onPromptSelect} />

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
                  [styles["chat-input-panel-inner-attach"]]: attachImages.length !== 0,
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
                                setAttachImages(attachImages.filter((_, i) => i !== index));
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
      {showExport && <ExportMessageModal onClose={() => setShowExport(false)} />}

      {isEditingMessage && (
        <EditMessageModal
          onClose={() => {
            setIsEditingMessage(false);
          }}
        />
      )}

      {showShortcutKeyModal && <ShortcutKeyModal onClose={() => setShowShortcutKeyModal(false)} />}

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

      {showGlobalMemory && <GlobalMemoryModal onClose={() => setShowGlobalMemory(false)} />}
    </>
  );
}

export function Chat() {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  return <ChatView key={session.id} />;
}
