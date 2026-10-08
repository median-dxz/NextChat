import React, { useEffect, useMemo, useRef, useState } from "react";
import BrainIcon from "../../icons/brain.svg";
import SettingsIcon from "../../icons/chat-settings.svg";
import ImageIcon from "../../icons/image.svg";
import LoadingButtonIcon from "../../icons/loading.svg";
import MaskIcon from "../../icons/mask.svg";
import PromptIcon from "../../icons/prompt.svg";
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
import { ModelType, useAppConfig, useChatStore, usePluginStore } from "../../store";
import {
  getModelSizes,
  isDalle3,
  isVisionModel,
  showPlugins,
  supportsCustomSize,
  useMobileScreen,
} from "../../utils";
import Locale from "../../locales";
import { DalleQuality, DalleStyle, ModelSize } from "../../typing";
import styles from "./chat.module.scss";
import { useNavigate } from "react-router";
import { Path, ServiceProvider } from "../../constant";
import { useChatControllerStore } from "../../store/chat-controller";
import { useAllModels } from "../../utils/hooks";
import { Selector, showToast } from "../ui-lib";
import { getAvailableClientsCount, isMcpEnabled } from "@/app/mcp/actions";
import clsx from "clsx";
import { getModelProvider } from "../../utils/model";
import { useEnsureAvailableModel } from "./chat-model-hooks";

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
