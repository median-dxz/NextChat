import { useEffect, useRef, useState } from "react";
import BrainIcon from "../../icons/brain.svg";
import CancelIcon from "../../icons/cancel.svg";
import DeleteIcon from "../../icons/clear.svg";
import ConfirmIcon from "../../icons/confirm.svg";
import LoadingButtonIcon from "../../icons/loading.svg";
import PinIcon from "../../icons/pin.svg";
import Locale from "../../locales";
import { getMessageText } from "../../utils";
import { Conversation } from "../../utils/conversation";
import { IconButton } from "../button";
import { Modal, Select } from "../ui-lib";
import styles from "./chat.module.scss";
import { useSessionEditor } from "./session-editor";

export function NodeViewerModal(props: {
  nodeId: string;
  onClose: () => void;
  onPin: (message: Conversation.Message) => void;
}) {
  const {
    session,
    draft,
    levelOptions,
    dispatch,
    close,
    save,
    generateSummary: requestSummary,
    generatingKinds,
  } = useSessionEditor(props.onClose);
  const node = session?.messages.find((item) => item.id === props.nodeId);
  const draftNode = draft?.conversation.findNode(props.nodeId)?.value;
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [segmentOpen, setSegmentOpen] = useState(() => Boolean(node?.nodeSummaries?.segment));
  const [checkpointOpen, setCheckpointOpen] = useState(() =>
    Boolean(node?.nodeSummaries?.checkpoint),
  );
  const [editingProperty, setEditingProperty] = useState<"outline-level" | "role">();
  const hasSegment = Boolean(draftNode?.nodeSummaries?.segment?.content.trim());
  const hasCheckpoint = Boolean(draftNode?.nodeSummaries?.checkpoint?.content.trim());

  useEffect(() => {
    if (hasSegment) setSegmentOpen(true);
  }, [hasSegment]);

  useEffect(() => {
    if (hasCheckpoint) setCheckpointOpen(true);
  }, [hasCheckpoint]);

  if (!session || !draft || !node || !draftNode) return null;
  const generating = generatingKinds.length > 0;
  const outlineLevelOptions = levelOptions(draftNode.id);
  const generateSummary = (kind: Conversation.SummaryKind) => requestSummary(draftNode.id, kind);
  const deleteSummary = (kind: Conversation.SummaryKind) => {
    dispatch({ type: "user-edit-summary", nodeId: draftNode.id, kind });
  };
  const summaryEditors = [
    {
      kind: "segment" as const,
      label: Locale.Chat.Graph.Segment,
      value: draftNode.nodeSummaries?.segment?.content ?? "",
      open: segmentOpen,
      setOpen: setSegmentOpen,
    },
    {
      kind: "checkpoint" as const,
      label: Locale.Chat.Graph.Checkpoint,
      value: draftNode.nodeSummaries?.checkpoint?.content ?? "",
      open: checkpointOpen,
      setOpen: setCheckpointOpen,
    },
  ];

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.Graph.Node}
        onClose={close}
        className={styles["node-viewer-dialog"]}
        contentClassName={styles["node-viewer-dialog-content"]}
        initialFocusRef={contentRef}
        actions={[
          <IconButton
            key="cancel"
            text={Locale.UI.Cancel}
            icon={<CancelIcon />}
            bordered
            shadow
            onClick={close}
          />,
          <IconButton
            key="save"
            type="primary"
            text={Locale.Chat.Graph.Save}
            icon={<ConfirmIcon />}
            bordered
            shadow
            disabled={generating}
            onClick={save}
          />,
        ]}
      >
        <div className={styles["node-viewer"]}>
          <div className={styles["node-viewer-properties"]}>
            <div className={styles["node-viewer-level"]}>
              <span id="node-outline-level-label">{Locale.Chat.Graph.OutlineLevel}</span>
              {editingProperty === "outline-level" ? (
                <Select
                  autoFocus
                  value={draftNode.outlineLevel}
                  aria-labelledby="node-outline-level-label"
                  disabled={generating}
                  onBlur={() => setEditingProperty(undefined)}
                  onChange={(event) => {
                    const level = Number(event.currentTarget.value);
                    const delta = level > draftNode.outlineLevel ? 1 : -1;
                    dispatch({
                      type: "shift-node-level",
                      nodeId: draftNode.id,
                      delta,
                    });
                  }}
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
                  aria-label={`${Locale.Chat.Graph.OutlineLevel}: L${draftNode.outlineLevel}`}
                  disabled={generating || outlineLevelOptions.length === 1}
                  onClick={() => setEditingProperty("outline-level")}
                >
                  L{draftNode.outlineLevel}
                </button>
              )}
            </div>
            <div className={styles["node-viewer-role"]}>
              <span id="node-role-label">{Locale.Chat.Graph.Role}</span>
              {editingProperty === "role" ? (
                <Select
                  autoFocus
                  value={draftNode.role}
                  aria-labelledby="node-role-label"
                  disabled={generating}
                  onBlur={() => setEditingProperty(undefined)}
                  onChange={(event) => {
                    const role = event.currentTarget.value as Conversation.Message["role"];
                    dispatch({ type: "set-node-role", nodeId: draftNode.id, role });
                  }}
                >
                  {Conversation.roles.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              ) : (
                <button
                  type="button"
                  className={styles["node-viewer-property-tag"]}
                  aria-label={`${Locale.Chat.Graph.Role}: ${draftNode.role}`}
                  disabled={generating}
                  onClick={() => setEditingProperty("role")}
                >
                  {draftNode.role}
                </button>
              )}
            </div>
          </div>
          <label className={styles["node-viewer-content"]}>
            <span>{Locale.Chat.Actions.Edit}</span>
            <textarea
              ref={contentRef}
              rows={5}
              value={getMessageText(draftNode.content)}
              disabled={generating}
              onChange={(event) => {
                const text = event.target.value;
                dispatch({ type: "set-node-text", nodeId: draftNode.id, text });
              }}
            />
          </label>
          <div className={styles["node-viewer-secondary-action"]}>
            <IconButton
              bordered
              text={Locale.Chat.Graph.SaveToPinned}
              icon={<PinIcon />}
              onClick={() => props.onPin(draftNode)}
            />
          </div>
          {draftNode.role === "assistant" && (
            <div className={styles["node-summary-editor"]}>
              {summaryEditors.map((summaryEditor) => (
                <details
                  key={summaryEditor.kind}
                  open={summaryEditor.open}
                  onToggle={(event) => summaryEditor.setOpen(event.currentTarget.open)}
                >
                  <summary>
                    <span>{summaryEditor.label}</span>
                    <span aria-hidden="true">{summaryEditor.open ? "−" : "+"}</span>
                  </summary>
                  <textarea
                    rows={4}
                    value={summaryEditor.value}
                    disabled={generating}
                    onChange={(event) => {
                      const content = event.currentTarget.value;
                      dispatch({
                        type: "user-edit-summary",
                        nodeId: draftNode.id,
                        kind: summaryEditor.kind,
                        content,
                      });
                    }}
                  />
                  <div className={styles["node-summary-actions"]}>
                    <IconButton
                      text={Locale.Chat.Graph.GenerateSummary}
                      icon={
                        generatingKinds.includes(summaryEditor.kind) ? (
                          <LoadingButtonIcon />
                        ) : (
                          <BrainIcon />
                        )
                      }
                      disabled={generating}
                      onClick={() => void generateSummary(summaryEditor.kind)}
                    />
                    <IconButton
                      text={Locale.Chat.Actions.Delete}
                      icon={<DeleteIcon />}
                      disabled={generating}
                      onClick={() => deleteSummary(summaryEditor.kind)}
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
