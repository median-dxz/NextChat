import type { Api, State } from "./graph";
import { type MessageInput, type Node, type Summary, type SummaryKind } from "./node";
import type { ConversationPlanningApi } from "./summary-planning";
import type { Workspace } from "./workspace";

export interface GenerationInput<K extends "raw" | SummaryKind> {
  kind: K;
  nodeId: string;
  message: MessageInput;
  tokens: number;
  snapshotDigest: string;
}

export type TargetExpectation = { state: "absent" } | { state: "present"; snapshotDigest: string };

export interface SummaryMaintenancePlan<
  K extends SummaryKind = SummaryKind,
  I extends "raw" | SummaryKind = "raw" | SummaryKind,
> {
  target: { kind: K; nodeId: string; expectation: TargetExpectation };
  // Coverage describes raw freshness; inputs may also contain background or previously summarized text.
  coverage: { nodeIds: string[]; sourceDigest: string };
  inputs: GenerationInput<I>[];
}

export type SegmentMaintenancePlan = SummaryMaintenancePlan<"segment", "raw" | "segment">;
export type CheckpointMaintenancePlan = SummaryMaintenancePlan<
  "checkpoint",
  "raw" | "segment" | "checkpoint"
>;

export interface SummaryApi<TResult> {
  edit(kind: SummaryKind, content: string): TResult;
  remove(kind: SummaryKind): TResult;
}

function bindConversationSummary<TResult>(
  graph: Api<TResult>,
  workspace: Workspace,
  commitData: (state: State) => TResult,
  plan: (nodeId: string) => ConversationPlanningApi,
) {
  const bindNode = (node: Node): SummaryApi<TResult> => {
    const position = workspace.index.positionById.get(node.id)!;
    const commitNode = (updater: (target: Node) => void) =>
      commitData(workspace.stage((draft) => updater(draft.messages[position] as unknown as Node)));
    const projection = workspace.projectTo(node.id);
    const chains = workspace.outlineChains(projection);
    const summaryIndex = workspace.summaryIndex(projection);

    return {
      edit(kind, content) {
        const value = content.trim();
        if (!value) return this.remove(kind);

        if (node.role !== "assistant") {
          throw new Error("Only assistant nodes can own summaries");
        }

        const chain = chains.find((candidate) =>
          candidate.nodes.some((candidateNode) => candidateNode.id === node.id),
        );
        const ownerIndex = chain?.nodes.findIndex((candidate) => candidate.id === node.id) ?? -1;
        if (!chain || ownerIndex < 0) {
          throw new Error(`Missing outline chain for ${node.id}`);
        }

        const sourceNodeIds =
          node.nodeSummaries?.[kind]?.sourceNodeIds ??
          (kind === "checkpoint"
            ? chain.nodes.slice(0, ownerIndex + 1).map((source) => source.id)
            : [node.id]);
        const sourceStart = chain.nodes.findIndex((source) => source.id === sourceNodeIds[0]);

        if (sourceStart < 0) {
          throw new Error(`Invalid ${kind} summary coverage for ${node.id}`);
        }

        const candidate: Summary = {
          content,
          sourceNodeIds,
          sourceDigest: chain.digest.range(sourceStart, sourceStart + sourceNodeIds.length),
          provenance: "user-edited",
        };

        if (!summaryIndex.evaluate(node, kind, candidate).eligible) {
          throw new Error(`Invalid ${kind} summary coverage for ${node.id}`);
        }

        return commitNode((target) => {
          target.nodeSummaries ??= {};
          target.nodeSummaries[kind] = candidate;
        });
      },

      remove(kind) {
        return commitNode((target) => {
          if (!target.nodeSummaries) return;
          delete target.nodeSummaries[kind];
          if (Object.keys(target.nodeSummaries).length === 0) {
            delete target.nodeSummaries;
          }
        });
      },
    };
  };

  const findNode = (nodeId: string): SummaryApi<TResult> | undefined => {
    const node = graph.findNode(nodeId)?.value;
    return node ? bindNode(node) : undefined;
  };

  return {
    plan,
    node(nodeId: string) {
      const node = findNode(nodeId);
      if (!node) throw new Error(`Missing conversation node ${nodeId}`);
      return node;
    },
    findNode,
    commitGenerated(plan: SummaryMaintenancePlan, content: string) {
      // Generation crosses an await boundary. Resolve every reference from this latest Workspace
      // and reject the whole plan if its target, coverage, or any model input changed meanwhile.
      const currentProjection = workspace.tryProjectTo(plan.target.nodeId);
      if (!currentProjection) return;
      const target = currentProjection.find((node) => node.id === plan.target.nodeId);
      if (!target || target.role !== "assistant") return;
      const chains = workspace.outlineChains(currentProjection);
      const summaryIndex = workspace.summaryIndex(currentProjection);
      const currentPositions = workspace.projectionPositions(currentProjection);
      const sourceChain = chains.find((chain) =>
        chain.nodes.some((node) => node.id === plan.coverage.nodeIds[0]),
      );
      const sourceStart =
        sourceChain?.nodes.findIndex((node) => node.id === plan.coverage.nodeIds[0]) ?? -1;
      if (!sourceChain || sourceStart < 0) return;
      const sourceNodes = sourceChain.nodes.slice(
        sourceStart,
        sourceStart + plan.coverage.nodeIds.length,
      );
      if (
        sourceNodes.length !== plan.coverage.nodeIds.length ||
        sourceNodes.some((node, index) => node.id !== plan.coverage.nodeIds[index])
      )
        return;
      const sourceDigest = sourceChain.digest.range(sourceStart, sourceStart + sourceNodes.length);
      if (sourceDigest !== plan.coverage.sourceDigest || sourceNodes.at(-1)?.id !== target.id)
        return;
      const currentSummary = target.nodeSummaries?.[plan.target.kind];
      if (plan.target.expectation.state === "absent") {
        if (currentSummary) return;
      } else if (
        !currentSummary ||
        workspace.snapshotInput(target.id, plan.target.kind, currentSummary) !==
          plan.target.expectation.snapshotDigest
      )
        return;

      if (
        !plan.inputs.every((input) => {
          if (!currentPositions.has(input.nodeId)) return false;
          const inputNode = workspace.index.nodesById.get(input.nodeId);
          if (!inputNode) return false;
          if (input.kind === "raw") {
            return workspace.snapshotInput(inputNode.id, "raw", inputNode) === input.snapshotDigest;
          }
          const inputSummary = inputNode.nodeSummaries?.[input.kind];
          if (!inputSummary) return false;
          const evaluation = summaryIndex.evaluate(inputNode, input.kind, inputSummary);
          return (
            workspace.snapshotInput(inputNode.id, input.kind, inputSummary) ===
              input.snapshotDigest &&
            evaluation.eligible &&
            evaluation.freshness === "fresh"
          );
        })
      ) {
        return;
      }

      const candidate: Summary = {
        content,
        sourceNodeIds: plan.coverage.nodeIds,
        sourceDigest,
        provenance: "generated",
      };
      if (!summaryIndex.evaluate(target, plan.target.kind, candidate).eligible) {
        return;
      }
      const targetPosition = workspace.index.positionById.get(target.id)!;
      return commitData(
        workspace.stage((draft) => {
          const current = draft.messages[targetPosition];
          current.nodeSummaries ??= {};
          current.nodeSummaries[plan.target.kind] = candidate;
        }),
      );
    },
  };
}

export type ConversationSummaryApi<TResult> = ReturnType<typeof bindConversationSummary<TResult>>;
export const ConversationSummary = bindConversationSummary;
