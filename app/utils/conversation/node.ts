import { nanoid } from "nanoid";

import type { ModelType } from "@/app/store/config";
import { hash } from "../hmac";

export const roles = ["system", "user", "assistant"] as const;
export type Role = (typeof roles)[number];

export type ContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type Content = string | ContentPart[];

export interface MessageInput {
  role: Role;
  content: Content;
}

export interface MessageTool {
  id: string;
  index?: number;
  type?: string;
  function?: { name: string; arguments?: string };
  content?: string;
  isError?: boolean;
  errorMsg?: string;
}

export interface Message extends MessageInput {
  date: string;
  reasoning?: string;
  reasoningDurationMs?: number;
  streaming?: boolean;
  isError?: boolean;
  id: string;
  model?: ModelType;
  tools?: MessageTool[];
  audio_url?: string;
  isMcpResponse?: boolean;
}

export type SummaryKind = "segment" | "checkpoint";
export type SummaryProvenance = "generated" | "user-edited";
export type SummaryFreshness = "fresh" | "stale";

export interface Summary {
  content: string;
  sourceNodeIds: string[];
  sourceDigest: string;
  provenance: SummaryProvenance;
}

export interface Node extends Message {
  parentId?: string;
  outlineLevel: number;
  activeBranchRootId?: string;
  nodeSummaries?: Partial<Record<SummaryKind, Summary>>;
}

// This is an explicit mutation capability list: new Message fields are read-only until opted in.
export type NodeDraft = Pick<
  Message,
  | "date"
  | "role"
  | "content"
  | "reasoning"
  | "reasoningDurationMs"
  | "streaming"
  | "isError"
  | "model"
  | "tools"
  | "audio_url"
  | "isMcpResponse"
>;

export function createMessage(override: Partial<Message>): Message {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

export function createNode(override: Partial<Node>): Node {
  // 在 createMessage 内本来就会展开 override，不需要再显式覆盖 Node 的独有字段
  return { outlineLevel: 1, ...createMessage(override) };
}

function encodeField(value: string) {
  // Length prefixes keep adjacent fields unambiguous even when content contains separators.
  return `${value.length}:${value}`;
}

function encodeContent(content: Content) {
  if (typeof content === "string") return `string:${encodeField(content)}`;
  return `parts:${content
    .map((part) =>
      part.type === "text"
        ? `text:${encodeField(part.text)}`
        : `image_url:${encodeField(part.image_url.url)}`,
    )
    .join("|")}`;
}

export function fingerprintNode(node: Node) {
  return hash(`conversation-node-v2|${node.role}|${encodeContent(node.content)}`);
}

export function fingerprintSummary(summary: Summary) {
  return hash(
    [
      "conversation-summary-v2",
      encodeField(summary.content),
      summary.sourceNodeIds.map(encodeField).join(""),
      summary.sourceDigest,
      summary.provenance,
    ].join("|"),
  );
}

const DIGEST_BASE_A = 0x9e3779b1;
const DIGEST_BASE_B = 0x85ebca77;

function digestLabel(length: number, left: number, right: number) {
  return `coverage-v2:${length}:${left.toString(16).padStart(8, "0")}${right
    .toString(16)
    .padStart(8, "0")}`;
}

export class CoverageDigestIndex {
  readonly #prefixA: number[] = [0];
  readonly #prefixB: number[] = [0];
  readonly #powersA: number[] = [1];
  readonly #powersB: number[] = [1];

  constructor(
    readonly nodes: readonly Node[],
    getFingerprint: (node: Node) => string = fingerprintNode,
  ) {
    for (const node of nodes) {
      const value = hash(
        `conversation-coverage-node-v2|${encodeField(node.id)}|${getFingerprint(node)}`,
      );
      const wordA = Number.parseInt(value.slice(0, 8), 16) >>> 0;
      const wordB = Number.parseInt(value.slice(8, 16), 16) >>> 0;
      this.#prefixA.push((Math.imul(this.#prefixA.at(-1)!, DIGEST_BASE_A) + wordA) >>> 0);
      this.#prefixB.push((Math.imul(this.#prefixB.at(-1)!, DIGEST_BASE_B) + wordB) >>> 0);
      this.#powersA.push(Math.imul(this.#powersA.at(-1)!, DIGEST_BASE_A) >>> 0);
      this.#powersB.push(Math.imul(this.#powersB.at(-1)!, DIGEST_BASE_B) >>> 0);
    }
  }

  range(start: number, end: number) {
    const length = end - start;
    if (start < 0 || end < start || end > this.nodes.length) {
      throw new Error(`Invalid coverage range ${start}:${end}`);
    }
    // Prefix subtraction removes the preceding polynomial, so contiguous coverage is O(1).
    // Two independent 32-bit lanes reduce collision risk without relying on bigint arithmetic.
    const left =
      (this.#prefixA[end] - Math.imul(this.#prefixA[start], this.#powersA[length])) >>> 0;
    const right =
      (this.#prefixB[end] - Math.imul(this.#prefixB[start], this.#powersB[length])) >>> 0;
    return digestLabel(length, left, right);
  }
}

export function createCoverageDigest(nodes: readonly Node[]) {
  return new CoverageDigestIndex(nodes).range(0, nodes.length);
}
