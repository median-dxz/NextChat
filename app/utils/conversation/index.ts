import { Context, type Api as ContextApi } from "./context";
import type * as ContextTypes from "./context";
import { Graph, type Api as GraphApi } from "./graph";
import type * as GraphTypes from "./graph";
import * as NodeInternal from "./node";
import { ConversationPlanning } from "./summary-planning";
import { ConversationSummary, type ConversationSummaryApi } from "./summary";
import { Workspace } from "./workspace";

export function Conversation(state: Conversation.State): Conversation.Api {
  let conversation: Conversation.Api;
  const workspace = new Workspace(state);
  const graph = Graph(workspace, Conversation);

  conversation = Object.assign(graph, {
    summaries: ConversationSummary(graph, workspace, Conversation, (nodeId) =>
      ConversationPlanning(workspace, nodeId),
    ),
    context: Context(workspace),
    updateNodeData(nodeId: string, updater: (node: NodeInternal.NodeDraft) => void) {
      const position = workspace.index.positionById.get(nodeId);
      if (position === undefined) return conversation;
      return Conversation(
        workspace.stage((draft) => {
          updater(draft.messages[position] as NodeInternal.NodeDraft);
        }),
      );
    },
  });
  // The public seam accepts persisted data, so establish the State invariant once per Workspace.
  conversation.validate();
  return conversation;
}

export namespace Conversation {
  export type Role = NodeInternal.Role;
  export type ContentPart = NodeInternal.ContentPart;
  export type Content = NodeInternal.Content;
  export type MessageInput = NodeInternal.MessageInput;
  export type Message = NodeInternal.Message;
  export type SerializedMessage = NodeInternal.SerializedMessage;
  export type SerializedNode = NodeInternal.SerializedNode;
  export type MessageTool = NodeInternal.MessageTool;
  export type Node = NodeInternal.Node;
  export type NodeDraft = NodeInternal.NodeDraft;
  export type Summary = NodeInternal.Summary;
  export type SummaryKind = NodeInternal.SummaryKind;
  export type SummaryProvenance = NodeInternal.SummaryProvenance;
  export type SummaryFreshness = NodeInternal.SummaryFreshness;
  export type State = GraphTypes.State;
  export type GlobalMemory = GraphTypes.GlobalMemory;
  export type ContextAssembly = ContextTypes.ContextAssembly;

  export interface Api extends GraphApi<Api> {
    readonly summaries: ConversationSummaryApi<Api>;
    readonly context: ContextApi;
    updateNodeData(nodeId: string, updater: (node: NodeDraft) => void): Api;
  }

  export const roles = NodeInternal.roles;
  export const createMessage = NodeInternal.createMessage;
  export const createSerializedMessage = NodeInternal.createSerializedMessage;
  export const createNode = NodeInternal.createNode;
  export const serializeMessage = NodeInternal.serializeMessage;
  export const serializeNode = NodeInternal.serializeNode;
  export const deserializeMessage = NodeInternal.deserializeMessage;
  export const deserializeNode = NodeInternal.deserializeNode;
  export const replaceText = NodeInternal.replaceText;
  export const createMemory = Graph.createMemory;
}
