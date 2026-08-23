import type { Node, Summary } from "./node";
import type { OutlineChain, Workspace } from "./workspace";

// These references belong to one immutable Workspace and remain trusted until materialization.
export type ContextRepresentation =
  | { kind: "raw"; node: Node; order: number }
  | {
      kind: "segment" | "checkpoint";
      owner: Node;
      summary: Summary;
      chain: OutlineChain;
      start: number;
      end: number;
      freshness: "fresh" | "stale";
      order: number;
    };

// Score is the single algebra shared by chain expansion and cross-chain combination.
// Benefit fields are compared lexicographically; tokens break otherwise equal choices.
interface Score {
  tokens: number;
  covered: number;
  fresh: number;
  raw: number;
  segment: number;
  checkpoint: number;
}

type Selection =
  | { kind: "append"; previous?: Selection; representation: ContextRepresentation }
  | { kind: "combine"; left?: Selection; right?: Selection };

interface State {
  score: Score;
  // Keep a backpointer while exploring; only the winning state materializes an array.
  selection?: Selection;
}

interface Edge {
  end: number;
  score: Score;
  representation: ContextRepresentation;
}

interface Frontier {
  states: State[];
  approximated: boolean;
}

interface ContextPlanningDiagnostics {
  approximated: boolean;
  maxCandidateCount: number;
  finalFrontierSize: number;
  chainCount: number;
}

// Numeric options have already been normalized by the Context facade.
interface PlanContextArgs {
  workspace: Workspace;
  projection: Node[];
  recentRawNodeCount: number;
  availableTokens: number;
  includeSummaries: boolean;
  frontierLimit: number;
  tokenBucketSize: number;
}

const ZERO_SCORE: Score = {
  tokens: 0,
  covered: 0,
  fresh: 0,
  raw: 0,
  segment: 0,
  checkpoint: 0,
};
function addScore(left: Score, right: Score): Score {
  return {
    tokens: left.tokens + right.tokens,
    covered: left.covered + right.covered,
    fresh: left.fresh + right.fresh,
    raw: left.raw + right.raw,
    segment: left.segment + right.segment,
    checkpoint: left.checkpoint + right.checkpoint,
  };
}

function compareScore(left: Score, right: Score) {
  for (const key of ["covered", "fresh", "raw", "segment", "checkpoint"] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  return right.tokens - left.tokens;
}

function compareFidelity(left: Score, right: Score) {
  for (const key of ["fresh", "raw", "segment", "checkpoint"] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  return right.tokens - left.tokens;
}

function scoreKey(score: Score) {
  return `${score.tokens}:${score.covered}:${score.fresh}:${score.raw}:${score.segment}:${score.checkpoint}`;
}

function dominates(left: Score, right: Score) {
  return left.tokens <= right.tokens && compareScore(left, right) > 0;
}

function best(states: State[], compare: (left: Score, right: Score) => number) {
  return states.reduce((winner, candidate) =>
    compare(candidate.score, winner.score) > 0 ? candidate : winner,
  );
}

function prune(states: State[]) {
  const unique = new Map<string, State>();
  for (const state of states) {
    const key = scoreKey(state.score);
    if (!unique.has(key)) unique.set(key, state);
  }
  const candidates = [...unique.values()].sort(
    (left, right) =>
      left.score.tokens - right.score.tokens || compareScore(right.score, left.score),
  );
  const frontier: State[] = [];
  let currentBest: State | undefined;
  for (const candidate of candidates) {
    if (currentBest && dominates(currentBest.score, candidate.score)) continue;
    frontier.push(candidate);
    if (!currentBest || compareScore(candidate.score, currentBest.score) > 0) {
      currentBest = candidate;
    }
  }
  return frontier;
}

function approximate(states: State[], budget: number, limit: number, bucketSize: number) {
  const exact = prune(states);
  if (exact.length <= limit) return { states: exact, approximated: false };
  const extremes = [
    best(exact, (left, right) => right.tokens - left.tokens || compareScore(left, right)),
    best(exact, (left, right) => left.covered - right.covered || compareScore(left, right)),
    best(exact, compareFidelity),
  ];
  const retained = new Map(extremes.map((state) => [scoreKey(state.score), state]));
  const slots = Math.max(1, limit - retained.size);
  const width = Math.max(bucketSize, Math.ceil((budget + 1) / slots));
  const buckets = new Map<number, State>();
  for (const candidate of exact) {
    const bucket = Math.floor(candidate.score.tokens / width);
    const current = buckets.get(bucket);
    if (!current || compareScore(candidate.score, current.score) > 0)
      buckets.set(bucket, candidate);
  }
  for (const candidate of [...buckets.values()].sort((left, right) =>
    compareScore(right.score, left.score),
  )) {
    if (retained.size >= limit) break;
    retained.set(scoreKey(candidate.score), candidate);
  }
  return { states: [...retained.values()], approximated: true };
}

function materialize(selection?: Selection): ContextRepresentation[] {
  const result: ContextRepresentation[] = [];
  const visit = (current?: Selection) => {
    if (!current) return;
    if (current.kind === "append") {
      visit(current.previous);
      result.push(current.representation);
    } else {
      visit(current.left);
      visit(current.right);
    }
  };
  visit(selection);
  return result;
}

function buildEdges(
  workspace: Workspace,
  projection: Node[],
  chain: OutlineChain,
  nodeCount: number,
  includeSummaries: boolean,
) {
  const positions = workspace.projectionPositions(projection);
  const edges = Array.from({ length: nodeCount }, () => [] as Edge[]);
  for (let index = 0; index < nodeCount; index += 1) {
    const node = chain.nodes[index];
    edges[index].push({
      end: index + 1,
      score: { ...ZERO_SCORE, tokens: workspace.nodeTokens(node), covered: 1, fresh: 1, raw: 1 },
      representation: { kind: "raw", node, order: positions.get(node.id)! },
    });
  }
  if (!includeSummaries) return edges;
  const summaryIndex = workspace.summaryIndex(projection);
  for (const owner of chain.nodes.slice(0, nodeCount)) {
    for (const kind of ["segment", "checkpoint"] as const) {
      const summary = owner.nodeSummaries?.[kind];
      if (!summary) continue;
      const evaluation = summaryIndex.evaluate(owner, kind, summary);
      if (!evaluation.eligible || evaluation.coverage.chainIndex < 0) continue;
      const { start, end } = evaluation.coverage;
      if (summaryIndex.chains[evaluation.coverage.chainIndex] !== chain || end >= nodeCount)
        continue;
      const covered = end - start + 1;
      edges[start].push({
        end: end + 1,
        score: {
          ...ZERO_SCORE,
          tokens: workspace.summaryTokens(summary.content),
          covered,
          fresh: evaluation.freshness === "fresh" ? covered : 0,
          segment: kind === "segment" ? covered : 0,
          checkpoint: kind === "checkpoint" ? covered : 0,
        },
        representation: {
          kind,
          owner,
          summary,
          chain,
          start,
          end,
          freshness: evaluation.freshness,
          order: positions.get(chain.nodes[end].id)!,
        },
      });
    }
  }
  return edges;
}

function planChain(
  args: PlanContextArgs,
  chain: OutlineChain,
  nodeCount: number,
  budget: number,
): Frontier {
  const count = Math.max(0, Math.min(nodeCount, chain.nodes.length));
  const edges = buildEdges(args.workspace, args.projection, chain, count, args.includeSummaries);
  const statesAt = Array.from({ length: count + 1 }, () => [{ score: ZERO_SCORE } as State]);
  // An empty state at every cutoff lets a chain contribute its best suffix under the budget.
  let approximated = false;
  for (let position = 0; position < count; position += 1) {
    const current = approximate(
      statesAt[position],
      budget,
      args.frontierLimit,
      args.tokenBucketSize,
    );
    statesAt[position] = current.states;
    approximated ||= current.approximated;
    for (const state of current.states) {
      for (const edge of edges[position]) {
        const score = addScore(state.score, edge.score);
        if (score.tokens <= budget) {
          statesAt[edge.end].push({
            score,
            selection: {
              kind: "append",
              previous: state.selection,
              representation: edge.representation,
            },
          });
        }
      }
    }
  }
  const final = approximate(statesAt[count], budget, args.frontierLimit, args.tokenBucketSize);
  return { states: final.states, approximated: approximated || final.approximated };
}

function selectRecentRaw(args: PlanContextArgs) {
  const desired = args.recentRawNodeCount;
  let start = Math.max(0, args.projection.length - desired);
  let nodes = args.projection.slice(start);
  let tokens = nodes.reduce((sum, node) => sum + args.workspace.nodeTokens(node), 0);
  while (nodes.length > 0 && tokens > args.availableTokens) {
    tokens -= args.workspace.nodeTokens(nodes[0]);
    start += 1;
    nodes = args.projection.slice(start);
  }
  const positions = args.workspace.projectionPositions(args.projection);
  return {
    start,
    state: {
      score: {
        ...ZERO_SCORE,
        tokens,
        covered: nodes.length,
        fresh: nodes.length,
        raw: nodes.length,
      },
      selection: nodes.reduce<Selection | undefined>(
        (previous, node) => ({
          kind: "append",
          previous,
          representation: { kind: "raw", node, order: positions.get(node.id)! },
        }),
        undefined,
      ),
    } satisfies State,
  };
}

function combineFrontiers(frontiers: Frontier[], budget: number, args: PlanContextArgs) {
  let states: State[] = [{ score: ZERO_SCORE }];
  let approximated = frontiers.some((frontier) => frontier.approximated);
  let maxCandidateCount = 1;
  for (const frontier of frontiers) {
    const candidates: State[] = [];
    for (const left of states) {
      for (const right of frontier.states) {
        const score = addScore(left.score, right.score);
        if (score.tokens <= budget) {
          candidates.push({
            score,
            selection: { kind: "combine", left: left.selection, right: right.selection },
          });
        }
      }
    }
    maxCandidateCount = Math.max(maxCandidateCount, candidates.length);
    const reduced = approximate(candidates, budget, args.frontierLimit, args.tokenBucketSize);
    states = reduced.states;
    approximated ||= reduced.approximated;
  }
  return {
    states,
    diagnostics: {
      approximated,
      maxCandidateCount,
      finalFrontierSize: states.length,
      chainCount: frontiers.length,
    } satisfies ContextPlanningDiagnostics,
  };
}

export function planNodeConversationContext(args: PlanContextArgs) {
  const recent = selectRecentRaw(args);
  const optional = args.projection.slice(0, recent.start);
  const optionalIds = new Set(optional.map((node) => node.id));
  const optionalBudget = args.availableTokens - recent.state.score.tokens;
  const frontiers = args.workspace.outlineChains(args.projection).flatMap((chain) => {
    const firstExcluded = chain.nodes.findIndex((node) => !optionalIds.has(node.id));
    const count = firstExcluded < 0 ? chain.nodes.length : firstExcluded;
    return count > 0 ? [planChain(args, chain, count, optionalBudget)] : [];
  });
  const combined = combineFrontiers(frontiers, optionalBudget, args);
  const optionalState = best(
    combined.states.length > 0 ? combined.states : [{ score: ZERO_SCORE }],
    compareScore,
  );
  const winner: State = {
    score: addScore(optionalState.score, recent.state.score),
    selection: {
      kind: "combine",
      left: optionalState.selection,
      right: recent.state.selection,
    },
  };
  return {
    tokens: winner.score.tokens,
    representations: materialize(winner.selection),
    diagnostics: combined.diagnostics,
  };
}
