import { produce, type Draft } from "immer";

import { estimateRequestMessageTokens } from "../context-budget";
import { hash } from "../hmac";
import { estimateTokenLength } from "../token";
import type { Index, State } from "./graph";
import { buildIndex, projectActive, validate } from "./graph";
import {
  CoverageDigestIndex,
  fingerprintNode,
  fingerprintSummary,
  type Node,
  type Summary,
  type SummaryKind,
} from "./node";

export interface OutlineChain {
  outlineLevel: number;
  nodes: Node[];
  digest: CoverageDigestIndex;
}

export type SummaryEvaluation =
  | {
      eligible: true;
      freshness: "fresh" | "stale";
      coverage: { chainIndex: number; start: number; end: number };
    }
  | {
      eligible: false;
      reason: "owner" | "missing-source" | "non-contiguous";
    };

interface ChainLocation {
  chainIndex: number;
  nodeIndex: number;
  node: Node;
}

export class SummaryIndex {
  readonly #locations = new Map<string, ChainLocation>();
  readonly #evaluations = new WeakMap<Summary, Map<string, SummaryEvaluation>>();

  constructor(readonly chains: OutlineChain[]) {
    chains.forEach((chain, chainIndex) =>
      chain.nodes.forEach((node, nodeIndex) =>
        this.#locations.set(node.id, { chainIndex, nodeIndex, node }),
      ),
    );
  }

  evaluate(owner: Node, kind: SummaryKind, summary: Summary): SummaryEvaluation {
    // Summary objects are immutable in this Workspace, so eligibility and freshness share a cache.
    const key = `${owner.id}:${kind}`;
    const cached = this.#evaluations.get(summary)?.get(key);
    if (cached) return cached;
    const result = this.#evaluate(owner, kind, summary);
    const byOwner = this.#evaluations.get(summary) ?? new Map<string, SummaryEvaluation>();
    byOwner.set(key, result);
    this.#evaluations.set(summary, byOwner);
    return result;
  }

  #evaluate(owner: Node, kind: SummaryKind, summary: Summary): SummaryEvaluation {
    if (owner.role !== "assistant" || summary.sourceNodeIds.length === 0) {
      return { eligible: false, reason: "owner" };
    }
    const resolved = summary.sourceNodeIds.map((id) => this.#locations.get(id));
    if (resolved.some((location) => !location)) {
      return { eligible: false, reason: "missing-source" };
    }
    const locations = resolved as ChainLocation[];
    const first = locations[0];
    const continuous = locations.every(
      (location, index) =>
        location.chainIndex === first.chainIndex && location.nodeIndex === first.nodeIndex + index,
    );
    const ownerIsEndpoint = locations.at(-1)?.node.id === owner.id;
    const checkpointStartsAtRoot = kind !== "checkpoint" || first.nodeIndex === 0;
    if (!continuous || !ownerIsEndpoint || !checkpointStartsAtRoot) {
      return { eligible: false, reason: "non-contiguous" };
    }
    const end = first.nodeIndex + locations.length;
    return {
      eligible: true,
      freshness:
        summary.sourceDigest === this.chains[first.chainIndex].digest.range(first.nodeIndex, end)
          ? "fresh"
          : "stale",
      coverage: { chainIndex: first.chainIndex, start: first.nodeIndex, end: end - 1 },
    };
  }
}

// A Workspace owns lazy derivations for exactly one immutable State snapshot.
// Creating a new Conversation creates a new Workspace, so identity caches never cross revisions.
export class Workspace {
  readonly state: State;
  #index?: Index;
  #validated = false;
  #activeProjection?: Node[];
  #cursorProjection?: Node[];
  readonly #targetProjections = new Map<string, Node[]>();
  readonly #chains = new WeakMap<readonly Node[], OutlineChain[]>();
  readonly #summaryIndexes = new WeakMap<readonly Node[], SummaryIndex>();
  readonly #projectionPositions = new WeakMap<readonly Node[], Map<string, number>>();
  readonly #nodeFingerprints = new WeakMap<Node, string>();
  readonly #summaryFingerprints = new WeakMap<Summary, string>();
  readonly #nodeTokens = new WeakMap<Node, number>();
  readonly #summaryTokens = new Map<string, number>();

  constructor(state: State) {
    this.state = {
      messages: state.messages,
      rootNodeId: state.rootNodeId,
      activeCursorId: state.activeCursorId,
    };
  }

  stage(recipe: (draft: Draft<State>) => void) {
    // Keep Immer drafts inside this synchronous call; async work carries plans and digests only.
    return produce(this.state, recipe);
  }

  get index() {
    return (this.#index ??= buildIndex(this.state.messages));
  }

  get validatedIndex() {
    if (!this.#validated) {
      validate(this.state, this.index);
      this.#validated = true;
    }
    return this.index;
  }

  projectActive() {
    return (this.#activeProjection ??= projectActive(this.state, this.validatedIndex));
  }

  tryProjectTo(nodeId: string) {
    const cached = this.#targetProjections.get(nodeId);
    if (cached) return cached;
    const projection = this.projectActive();
    const targetIndex = projection.findIndex((node) => node.id === nodeId);
    if (targetIndex < 0) return undefined;
    const result = projection.slice(0, targetIndex + 1);
    this.#targetProjections.set(nodeId, result);
    return result;
  }

  projectTo(nodeId: string) {
    const projection = this.tryProjectTo(nodeId);
    if (!projection) throw new Error("Conversation target must stay in the active projection");
    return projection;
  }

  projectToCursor() {
    if (this.#cursorProjection) return this.#cursorProjection;
    if (!this.state.activeCursorId) return [];
    return (this.#cursorProjection = this.projectTo(this.state.activeCursorId));
  }

  fingerprintRaw(node: Node) {
    // Nodes and summaries are immutable within a Workspace, making object identity a safe cache key.
    const cached = this.#nodeFingerprints.get(node);
    if (cached) return cached;
    const value = fingerprintNode(node);
    this.#nodeFingerprints.set(node, value);
    return value;
  }

  fingerprintSummary(summary: Summary) {
    const cached = this.#summaryFingerprints.get(summary);
    if (cached) return cached;
    const value = fingerprintSummary(summary);
    this.#summaryFingerprints.set(summary, value);
    return value;
  }

  snapshotInput(nodeId: string, kind: "raw", value: Node): string;
  snapshotInput(nodeId: string, kind: SummaryKind, value: Summary): string;
  snapshotInput(nodeId: string, kind: "raw" | SummaryKind, value: Node | Summary) {
    const fingerprint =
      kind === "raw"
        ? this.fingerprintRaw(value as Node)
        : this.fingerprintSummary(value as Summary);
    return hash(`conversation-input-v2|${kind}|${nodeId.length}:${nodeId}|${fingerprint}`);
  }

  nodeTokens(node: Node) {
    const cached = this.#nodeTokens.get(node);
    if (cached !== undefined) return cached;
    const tokens = estimateRequestMessageTokens(node);
    this.#nodeTokens.set(node, tokens);
    return tokens;
  }

  summaryTokens(content: string) {
    const cached = this.#summaryTokens.get(content);
    if (cached !== undefined) return cached;
    const tokens = estimateTokenLength(content);
    this.#summaryTokens.set(content, tokens);
    return tokens;
  }

  outlineChains(projection: readonly Node[]) {
    const cached = this.#chains.get(projection);
    if (cached) return cached;
    const locations = new Map<string, { level: number; chainIndex: number }>();
    const chains: Array<{ outlineLevel: number; nodes: Node[] }> = [];
    // Same-level parent edges continue a chain; outline transitions start a new one.
    for (const node of projection) {
      const parent = node.parentId ? locations.get(node.parentId) : undefined;
      const chainIndex =
        parent && parent.level === node.outlineLevel
          ? parent.chainIndex
          : chains.push({ outlineLevel: node.outlineLevel, nodes: [] }) - 1;
      chains[chainIndex].nodes.push(node);
      locations.set(node.id, { level: node.outlineLevel, chainIndex });
    }
    const result = chains.map((chain) => ({
      ...chain,
      digest: new CoverageDigestIndex(chain.nodes, (node) => this.fingerprintRaw(node)),
    }));
    this.#chains.set(projection, result);
    return result;
  }

  summaryIndex(projection: readonly Node[]) {
    const cached = this.#summaryIndexes.get(projection);
    if (cached) return cached;
    const result = new SummaryIndex(this.outlineChains(projection));
    this.#summaryIndexes.set(projection, result);
    return result;
  }

  projectionPositions(projection: readonly Node[]) {
    const cached = this.#projectionPositions.get(projection);
    if (cached) return cached;
    const result = new Map(projection.map((node, index) => [node.id, index]));
    this.#projectionPositions.set(projection, result);
    return result;
  }
}
