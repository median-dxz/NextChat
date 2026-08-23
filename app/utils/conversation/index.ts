import { Context, type Api as ContextApi } from "./context";
import type * as ContextTypes from "./context";
import { Graph, type Api as GraphApi } from "./graph";
import type * as GraphTypes from "./graph";
import {
  createMessage as makeMessage,
  createNode as makeNode,
  roles as conversationRoles,
  type NodeDraft,
} from "./node";
import type * as NodeTypes from "./node";
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
    updateNodeData(nodeId: string, updater: (node: NodeDraft) => void) {
      const position = workspace.index.positionById.get(nodeId);
      if (position === undefined) return conversation;
      return Conversation(
        workspace.stage((draft) => {
          updater(draft.messages[position] as NodeDraft);
        }),
      );
    },
  });
  // The public seam accepts persisted data, so establish the State invariant once per Workspace.
  conversation.validate();
  return conversation;
}

export namespace Conversation {
  export type Role = NodeTypes.Role;
  export type ContentPart = NodeTypes.ContentPart;
  export type Content = NodeTypes.Content;
  export type MessageInput = NodeTypes.MessageInput;
  export type Message = NodeTypes.Message;
  export type MessageTool = NodeTypes.MessageTool;
  export type Node = NodeTypes.Node;
  export type NodeDraft = NodeTypes.NodeDraft;
  export type Summary = NodeTypes.Summary;
  export type SummaryKind = NodeTypes.SummaryKind;
  export type SummaryProvenance = NodeTypes.SummaryProvenance;
  export type SummaryFreshness = NodeTypes.SummaryFreshness;
  export type State = GraphTypes.State;
  export type GlobalMemory = GraphTypes.GlobalMemory;
  export type ContextAssembly = ContextTypes.ContextAssembly;

  export interface Api extends GraphApi<Api> {
    readonly summaries: ConversationSummaryApi<Api>;
    readonly context: ContextApi;
    updateNodeData(nodeId: string, updater: (node: NodeDraft) => void): Api;
  }

  export const roles = conversationRoles;
  export const createMessage = makeMessage;
  export const createNode = makeNode;
  export const createMemory = Graph.createMemory;
}
