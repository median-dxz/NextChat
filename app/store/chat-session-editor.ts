import { Conversation } from "../utils/conversation";
import { createCoverageDigest, fingerprintSummary } from "../utils/conversation/node";

export class ExcludedNodeEditError extends Error {
  constructor() {
    super("Cannot modify a generating reply");
    this.name = "ExcludedNodeEditError";
  }
}

export type ChatSessionEditorCommand =
  | { type: "set-topic"; topic: string }
  | { type: "set-node-text"; nodeId: string; text: string }
  | { type: "set-node-role"; nodeId: string; role: Conversation.Role }
  | { type: "user-edit-summary"; nodeId: string; kind: Conversation.SummaryKind; content?: string }
  | {
      type: "update-summary";
      nodeId: string;
      kind: Conversation.SummaryKind;
      summary: Conversation.Summary;
    }
  | { type: "swap-nodes"; firstId: string; secondId: string }
  | { type: "insert-node"; previousId?: string }
  | { type: "remove-node"; nodeId: string }
  | { type: "shift-node-level"; nodeId: string; delta: -1 | 1 };

export interface ChatSessionEditor {
  readonly state: {
    readonly topic: string;
    readonly conversation: Conversation.Api;
  };
  levelOptions(nodeId: string): number[];
  apply(command: ChatSessionEditorCommand): ChatSessionEditor;
  prepareCommit(latest: ChatSessionEditor["state"]): ChatSessionEditor["state"];
}

type State = ChatSessionEditor["state"];

function text(content: Conversation.Content) {
  return typeof content === "string"
    ? content
    : (content.find((part) => part.type === "text")?.text ?? "");
}

function bindEditor(base: State, draft: State): ChatSessionEditor {
  const graph = draft.conversation;
  const excludedNodes = base.conversation.state.messages.filter((node) => node.streaming);

  return {
    state: draft,

    levelOptions(nodeId) {
      const node = graph.node(nodeId);
      const parent = node.parent;

      return ([-1, 0, 1] as const).flatMap((delta) => {
        const level = node.value.outlineLevel + delta;

        if (delta === 0) return [level];
        if (!parent) return [];
        if (level !== parent.outlineLevel && level !== parent.outlineLevel + 1) return [];

        return [level];
      });
    },

    apply(command) {
      if ("nodeId" in command && excludedNodes.some((node) => node.id === command.nodeId)) {
        throw new ExcludedNodeEditError();
      }

      let conversation = graph;
      let topic = draft.topic;

      switch (command.type) {
        case "set-topic":
          topic = command.topic;
          break;

        case "insert-node":
          conversation = conversation.insertProjected(
            Conversation.createNode({ role: "user", content: "" }),
            command.previousId,
          );
          break;

        case "set-node-text":
          conversation = conversation.updateNodeData(command.nodeId, (node) => {
            node.content = Conversation.replaceText(node.content, command.text);
          });
          break;

        case "set-node-role":
          conversation = conversation.updateNodeData(command.nodeId, (node) => {
            node.role = command.role;
          });
          break;

        case "user-edit-summary": {
          const content = command.content ?? "";
          const original = base.conversation.findNode(command.nodeId)?.value.nodeSummaries?.[
            command.kind
          ];

          if (content === (original?.content ?? "")) {
            conversation = conversation.summaries
              .node(command.nodeId)
              .update(command.kind, original);
          } else {
            const node = graph.node(command.nodeId).value;
            const snapshot = node.nodeSummaries?.[command.kind];
            const sources = [node];

            if (!snapshot && command.kind === "checkpoint") {
              let parent = graph.node(node.id).parent;

              while (parent && parent.outlineLevel === node.outlineLevel) {
                sources.unshift(parent);
                parent = graph.node(parent.id).parent;
              }
            }

            conversation = conversation.summaries.node(node.id).update(command.kind, {
              content,
              sourceNodeIds: snapshot?.sourceNodeIds ?? sources.map((source) => source.id),
              sourceDigest: snapshot?.sourceDigest ?? createCoverageDigest(sources),
              provenance: "user-edited",
            });
          }

          break;
        }

        case "update-summary":
          conversation = conversation.summaries
            .node(command.nodeId)
            .update(command.kind, command.summary);
          break;

        case "swap-nodes":
          conversation = conversation.swap(command.firstId, command.secondId);
          break;

        case "remove-node":
          conversation = conversation.node(command.nodeId).remove();
          break;

        case "shift-node-level":
          conversation = conversation.node(command.nodeId).shiftLevel(command.delta);
          break;
      }

      if (
        command.type === "insert-node" ||
        command.type === "swap-nodes" ||
        command.type === "remove-node" ||
        command.type === "shift-node-level"
      ) {
        // Only the excluded node's own connections are fixed for this editing window.
        if (
          !excludedNodes.every((node) => {
            const candidate = conversation.findNode(node.id)?.value;
            return (
              candidate &&
              candidate.parentId === node.parentId &&
              candidate.outlineLevel === node.outlineLevel &&
              candidate.activeBranchRootId === node.activeBranchRootId
            );
          })
        ) {
          throw new ExcludedNodeEditError();
        }
      }

      return bindEditor(base, { topic, conversation });
    },

    prepareCommit(latest) {
      const messages = draft.conversation.state.messages.map((node) => {
        const original = base.conversation.findNode(node.id)?.value;
        if (!original) return node;

        const current = latest.conversation.node(node.id).value;
        if (original.streaming) return current;

        return {
          ...current,
          parentId: node.parentId,
          outlineLevel: node.outlineLevel,
          activeBranchRootId: node.activeBranchRootId,
          role: node.role === original.role ? current.role : node.role,
          content:
            text(node.content) === text(original.content)
              ? current.content
              : Conversation.replaceText(current.content, text(node.content)),
        };
      });

      let conversation = Conversation({ ...draft.conversation.state, messages });

      for (const node of graph.state.messages) {
        const original = base.conversation.findNode(node.id)?.value;
        if (original?.streaming) continue;

        const current = conversation.node(node.id).value;

        if (current.role !== "assistant") {
          if (current.nodeSummaries) {
            conversation = conversation.summaries.node(node.id).remove("segment");
            conversation = conversation.summaries.node(node.id).remove("checkpoint");
          }

          continue;
        }

        for (const kind of ["segment", "checkpoint"] as const) {
          const snapshot = node.nodeSummaries?.[kind];
          const originalSummary = original?.nodeSummaries?.[kind];

          if (
            snapshot === originalSummary ||
            (snapshot &&
              originalSummary &&
              fingerprintSummary(snapshot) === fingerprintSummary(originalSummary))
          ) {
            continue;
          }

          const summary = conversation.summaries.node(node.id);

          // User confirmation binds to the merged source; generated snapshots keep their source.
          const confirmed =
            snapshot?.provenance === "user-edited" ? summary.confirm(kind, snapshot) : snapshot;

          conversation = summary.update(kind, confirmed);
        }
      }

      return {
        topic: draft.topic === base.topic ? latest.topic : draft.topic,
        conversation,
      };
    },
  };
}

export const ChatSessionEditor = {
  open(session: Conversation.State & { topic: string }): ChatSessionEditor {
    const base = { topic: session.topic, conversation: Conversation(session) };

    return bindEditor(base, base);
  },
};
