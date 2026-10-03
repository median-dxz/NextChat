import type { Node, Summary } from "./node";
import {
  type GenerationInput,
  type CheckpointMaintenancePlan,
  type SegmentMaintenancePlan,
} from "./summary";
import { type OutlineChain, type SummaryEvaluation, Workspace } from "./workspace";

export interface PlanSummaryOptions {
  tokenTarget: number;
  itemTarget: number;
  inputBudget: number;
  force?: boolean;
}

interface PlanningContext {
  workspace: Workspace;
  projection: Node[];
  targetChain: OutlineChain;
  targetIndex: number;
}

interface SummaryInterval {
  start: number;
  end: number;
  owner: Node;
  summary: Summary;
  evaluation: SummaryEvaluation;
}

function collectSummaryIntervals(
  workspace: Workspace,
  projection: Node[],
  chain: OutlineChain,
  kind: "segment" | "checkpoint",
) {
  return chain.nodes.flatMap((owner): SummaryInterval[] => {
    const summary = owner.nodeSummaries?.[kind];
    if (!summary) return [];
    const evaluation = workspace.summaryIndex(projection).evaluate(owner, kind, summary);
    if (!evaluation.eligible) return [];
    return [
      {
        start: evaluation.coverage.start,
        end: evaluation.coverage.end,
        owner,
        summary,
        evaluation,
      },
    ];
  });
}

function buildSegmentBackground(
  context: PlanningContext,
  sourceStartIndex: number,
  availableTokens: number,
): GenerationInput<"raw" | "segment">[] {
  if (availableTokens <= 0) return [];
  const { workspace, projection, targetChain } = context;
  const projectionOrder = workspace.projectionPositions(projection);
  const sourceStart = targetChain.nodes[sourceStartIndex];
  const sourceProjectionIndex = projectionOrder.get(sourceStart.id)!;
  const candidates: GenerationInput<"raw" | "segment">[] = [];

  for (const owner of targetChain.nodes.slice(0, sourceStartIndex)) {
    const summary = owner.nodeSummaries?.segment;
    if (!summary) continue;
    const evaluation = workspace.summaryIndex(projection).evaluate(owner, "segment", summary);
    if (!evaluation.eligible || evaluation.freshness !== "fresh") {
      continue;
    }
    candidates.push({
      kind: "segment",
      nodeId: owner.id,
      message: { role: "assistant", content: summary.content },
      tokens: workspace.summaryTokens(summary.content),
      snapshotDigest: workspace.snapshotInput(owner.id, "segment", summary),
    });
  }

  for (const node of projection.slice(0, sourceProjectionIndex)) {
    if (node.outlineLevel >= targetChain.outlineLevel) continue;
    candidates.push({
      kind: "raw",
      nodeId: node.id,
      message: { role: node.role, content: node.content },
      tokens: workspace.nodeTokens(node),
      snapshotDigest: workspace.snapshotInput(node.id, "raw", node),
    });
  }

  candidates.sort(
    (left, right) => projectionOrder.get(left.nodeId)! - projectionOrder.get(right.nodeId)!,
  );
  const selected: GenerationInput<"raw" | "segment">[] = [];
  let tokens = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (tokens + candidate.tokens > availableTokens) continue;
    selected.unshift(candidate);
    tokens += candidate.tokens;
  }
  return selected;
}

function createSegmentPlan(
  context: PlanningContext,
  sourceNodes: Node[],
  owner: Node,
  inputBudget: number,
  expectedSummary?: Summary,
): SegmentMaintenancePlan | undefined {
  const { workspace, targetChain } = context;
  const sourceTokens = sourceNodes.reduce((tokens, node) => tokens + workspace.nodeTokens(node), 0);
  if (sourceTokens > inputBudget) return;
  const sourceStartIndex = targetChain.nodes.findIndex((node) => node.id === sourceNodes[0].id);
  return {
    target: {
      kind: "segment",
      nodeId: owner.id,
      expectation: expectedSummary
        ? {
            state: "present",
            snapshotDigest: workspace.snapshotInput(owner.id, "segment", expectedSummary),
          }
        : { state: "absent" },
    },
    coverage: {
      nodeIds: sourceNodes.map((node) => node.id),
      sourceDigest: targetChain.digest.range(
        sourceStartIndex,
        sourceStartIndex + sourceNodes.length,
      ),
    },
    inputs: [
      ...buildSegmentBackground(context, sourceStartIndex, inputBudget - sourceTokens),
      ...sourceNodes.map((node) => ({
        kind: "raw" as const,
        nodeId: node.id,
        message: { role: node.role, content: node.content },
        tokens: workspace.nodeTokens(node),
        snapshotDigest: workspace.snapshotInput(node.id, "raw", node),
      })),
    ],
  };
}

function planSegmentMaintenance(
  context: PlanningContext,
  options: PlanSummaryOptions,
): SegmentMaintenancePlan | undefined {
  const { workspace, projection, targetChain, targetIndex } = context;
  const target = targetChain.nodes[targetIndex];
  const intervals = collectSummaryIntervals(workspace, projection, targetChain, "segment")
    .filter((interval) => interval.end <= targetIndex)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (options.force && target.nodeSummaries?.segment) {
    const current = target.nodeSummaries.segment;
    const evaluation = workspace.summaryIndex(projection).evaluate(target, "segment", current);
    const sourceNodes = evaluation.eligible
      ? workspace
          .outlineChains(projection)
          [evaluation.coverage.chainIndex].nodes.slice(
            evaluation.coverage.start,
            evaluation.coverage.end + 1,
          )
      : [target];
    return createSegmentPlan(context, sourceNodes, target, options.inputBudget, current);
  }

  const staleGenerated = intervals.find(
    (interval) =>
      interval.summary.provenance === "generated" &&
      interval.evaluation.eligible &&
      interval.evaluation.freshness === "stale",
  );
  if (staleGenerated) {
    const refreshPlan = createSegmentPlan(
      context,
      staleGenerated.evaluation.eligible
        ? workspace
            .outlineChains(projection)
            [staleGenerated.evaluation.coverage.chainIndex].nodes.slice(
              staleGenerated.evaluation.coverage.start,
              staleGenerated.evaluation.coverage.end + 1,
            )
        : [],
      staleGenerated.owner,
      options.inputBudget,
      staleGenerated.summary,
    );
    if (refreshPlan) return refreshPlan;
  }

  const nextSourceIndex = intervals.reduce(
    (nextIndex, interval) => Math.max(nextIndex, interval.end + 1),
    0,
  );
  if (nextSourceIndex > targetIndex || target.nodeSummaries?.segment) return;

  const uncoveredTail = targetChain.nodes.slice(nextSourceIndex, targetIndex + 1);
  const tailTokens = uncoveredTail.reduce((tokens, node) => tokens + workspace.nodeTokens(node), 0);
  const thresholdReached =
    tailTokens >= options.tokenTarget || uncoveredTail.length >= options.itemTarget;
  if (!options.force && !thresholdReached) return;

  let sourceTokens = 0;
  let lastAssistantIndex = -1;
  for (let index = 0; index < uncoveredTail.length && index < options.itemTarget; index += 1) {
    const node = uncoveredTail[index];
    const nodeTokens = workspace.nodeTokens(node);
    if (sourceTokens + nodeTokens > options.inputBudget) break;
    sourceTokens += nodeTokens;
    if (node.role !== "assistant") continue;

    lastAssistantIndex = index;
  }
  if (lastAssistantIndex < 0) return;

  const sourceNodes = uncoveredTail.slice(0, lastAssistantIndex + 1);
  return createSegmentPlan(context, sourceNodes, sourceNodes.at(-1)!, options.inputBudget);
}

interface CheckpointInputs {
  inputs: GenerationInput<"raw" | "segment" | "checkpoint">[];
  segmentCount: number;
}

function buildCheckpointInputs(
  workspace: Workspace,
  targetChain: OutlineChain,
  segments: SummaryInterval[],
  start: number,
  end: number,
  base?: SummaryInterval,
): CheckpointInputs {
  const inputs: GenerationInput<"raw" | "segment" | "checkpoint">[] = [];
  if (base) {
    inputs.push({
      kind: "checkpoint",
      nodeId: base.owner.id,
      message: { role: "assistant", content: base.summary.content },
      tokens: workspace.summaryTokens(base.summary.content),
      snapshotDigest: workspace.snapshotInput(base.owner.id, "checkpoint", base.summary),
    });
  }

  const segmentsByStart = new Map<number, SummaryInterval[]>();
  for (const segment of segments) {
    if (
      segment.start < start ||
      segment.end > end ||
      !segment.evaluation.eligible ||
      segment.evaluation.freshness !== "fresh"
    ) {
      continue;
    }
    const candidates = segmentsByStart.get(segment.start) ?? [];
    candidates.push(segment);
    candidates.sort((left, right) => right.end - left.end);
    segmentsByStart.set(segment.start, candidates);
  }

  let segmentCount = 0;
  let cursor = start;
  while (cursor <= end) {
    const segment = segmentsByStart.get(cursor)?.[0];
    if (segment) {
      inputs.push({
        kind: "segment",
        nodeId: segment.owner.id,
        message: { role: "assistant", content: segment.summary.content },
        tokens: workspace.summaryTokens(segment.summary.content),
        snapshotDigest: workspace.snapshotInput(segment.owner.id, "segment", segment.summary),
      });
      segmentCount += 1;
      cursor = segment.end + 1;
      continue;
    }

    const node = targetChain.nodes[cursor];
    inputs.push({
      kind: "raw",
      nodeId: node.id,
      message: { role: node.role, content: node.content },
      tokens: workspace.nodeTokens(node),
      snapshotDigest: workspace.snapshotInput(node.id, "raw", node),
    });
    cursor += 1;
  }

  return { inputs, segmentCount };
}

function createCheckpointPlan(
  workspace: Workspace,
  targetChain: OutlineChain,
  ownerIndex: number,
  inputs: GenerationInput<"raw" | "segment" | "checkpoint">[],
  inputBudget: number,
  expectedSummary?: Summary,
): CheckpointMaintenancePlan | undefined {
  if (
    inputs.length === 0 ||
    inputs.reduce((tokens, input) => tokens + input.tokens, 0) > inputBudget
  ) {
    return;
  }
  const sourceNodes = targetChain.nodes.slice(0, ownerIndex + 1);
  return {
    target: {
      kind: "checkpoint",
      nodeId: targetChain.nodes[ownerIndex].id,
      expectation: expectedSummary
        ? {
            state: "present",
            snapshotDigest: workspace.snapshotInput(
              targetChain.nodes[ownerIndex].id,
              "checkpoint",
              expectedSummary,
            ),
          }
        : { state: "absent" },
    },
    coverage: {
      nodeIds: sourceNodes.map((node) => node.id),
      sourceDigest: targetChain.digest.range(0, ownerIndex + 1),
    },
    inputs,
  };
}

function planCheckpointMaintenance(
  context: PlanningContext,
  options: PlanSummaryOptions,
): CheckpointMaintenancePlan | undefined {
  const { workspace, projection, targetChain, targetIndex } = context;
  const target = targetChain.nodes[targetIndex];
  const segments = collectSummaryIntervals(workspace, projection, targetChain, "segment")
    .filter((interval) => interval.end <= targetIndex)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const checkpoints = collectSummaryIntervals(workspace, projection, targetChain, "checkpoint")
    .filter((checkpoint) => checkpoint.end <= targetIndex)
    .sort((left, right) => left.end - right.end);

  const forcedSummary = options.force ? target.nodeSummaries?.checkpoint : undefined;
  const staleGenerated = checkpoints.find(
    (checkpoint) =>
      checkpoint.summary.provenance === "generated" &&
      checkpoint.evaluation.eligible &&
      checkpoint.evaluation.freshness === "stale",
  );
  const forcedCheckpoint = forcedSummary
    ? {
        end: targetIndex,
        owner: target,
        summary: forcedSummary,
      }
    : undefined;
  const refresh = forcedCheckpoint ?? staleGenerated;
  if (refresh) {
    const base = checkpoints
      .filter(
        (checkpoint) =>
          checkpoint.end < refresh.end &&
          checkpoint.evaluation.eligible &&
          checkpoint.evaluation.freshness === "fresh",
      )
      .at(-1);
    const checkpointInputs = buildCheckpointInputs(
      workspace,
      targetChain,
      segments,
      (base?.end ?? -1) + 1,
      refresh.end,
      base,
    );
    return createCheckpointPlan(
      workspace,
      targetChain,
      refresh.end,
      checkpointInputs.inputs,
      options.inputBudget,
      refresh.summary,
    );
  }

  const base = checkpoints
    .filter(
      (checkpoint) => checkpoint.evaluation.eligible && checkpoint.evaluation.freshness === "fresh",
    )
    .at(-1);
  const start = (base?.end ?? -1) + 1;
  const availableSegments = segments.filter(
    (segment) =>
      segment.start >= start &&
      segment.end <= targetIndex &&
      segment.evaluation.eligible &&
      segment.evaluation.freshness === "fresh",
  );
  if (availableSegments.length === 0) return;
  const ownerIndex = Math.max(...availableSegments.map((segment) => segment.end));
  const owner = targetChain.nodes[ownerIndex];
  if (owner.nodeSummaries?.checkpoint) return;
  const checkpointInputs = buildCheckpointInputs(
    workspace,
    targetChain,
    segments,
    start,
    ownerIndex,
    base,
  );
  const inputTokens = checkpointInputs.inputs.reduce((tokens, input) => tokens + input.tokens, 0);
  const thresholdReached =
    checkpointInputs.segmentCount >= options.itemTarget || inputTokens >= options.tokenTarget;
  if (!options.force && !thresholdReached) return;
  return createCheckpointPlan(
    workspace,
    targetChain,
    ownerIndex,
    checkpointInputs.inputs,
    options.inputBudget,
  );
}

export interface ConversationPlanningApi {
  segment(options: PlanSummaryOptions): SegmentMaintenancePlan | undefined;
  checkpoint(options: PlanSummaryOptions): CheckpointMaintenancePlan | undefined;
}

export function ConversationPlanning(
  workspace: Workspace,
  targetNodeId: string,
): ConversationPlanningApi {
  const resolveContext = (): PlanningContext | undefined => {
    const projection = workspace.tryProjectTo(targetNodeId);
    if (!projection) return undefined;
    const target = projection.find((node) => node.id === targetNodeId);
    if (!target || target.role !== "assistant") return undefined;
    const targetChain = workspace
      .outlineChains(projection)
      .find((chain) => chain.nodes.some((node) => node.id === target.id));
    if (!targetChain) return undefined;
    const targetIndex = targetChain.nodes.findIndex((node) => node.id === target.id);
    if (targetIndex < 0) return undefined;
    return {
      workspace,
      projection,
      targetChain,
      targetIndex,
    };
  };

  return {
    segment: (options) => {
      const context = resolveContext();
      if (!context) return undefined;
      return planSegmentMaintenance(context, {
        tokenTarget: Math.max(0, options.tokenTarget),
        itemTarget: Math.max(1, Math.floor(options.itemTarget)),
        inputBudget: Math.max(0, options.inputBudget),
        force: options.force,
      });
    },
    checkpoint: (options) => {
      const context = resolveContext();
      if (!context) return undefined;
      return planCheckpointMaintenance(context, {
        tokenTarget: Math.max(0, options.tokenTarget),
        itemTarget: Math.max(1, Math.floor(options.itemTarget)),
        inputBudget: Math.max(0, options.inputBudget),
        force: options.force,
      });
    },
  };
}
