import { describe, expect, test } from "vitest";
import type { ConversationNode } from "../app/utils/conversation-graph";
import {
  projectActiveConversation,
  projectConversationToCursor,
  remapConversationNodes,
  toLevelOneConversationNodes,
  validateConversationGraph,
} from "../app/utils/conversation-graph";

function node(
  id: string,
  outlineLevel: number,
  parentId?: string,
): ConversationNode {
  return {
    id,
    date: "",
    role: "user",
    content: id,
    outlineLevel,
    parentId,
  };
}

describe("conversation graph storage", () => {
  test("migrates a linear message list into a level-one parent chain", () => {
    const nodes = toLevelOneConversationNodes([
      { id: "a", date: "", role: "user", content: "A" },
      { id: "deleted", date: "", role: "assistant", content: "", deletedAt: 1 },
      { id: "b", date: "", role: "assistant", content: "B" },
    ]);

    expect(nodes.map(({ id, parentId, outlineLevel }) => ({ id, parentId, outlineLevel }))).toEqual([
      { id: "a", parentId: undefined, outlineLevel: 1 },
      { id: "b", parentId: "a", outlineLevel: 1 },
    ]);
    expect(() =>
      validateConversationGraph({
        messages: nodes,
        rootNodeId: "a",
        activeCursorId: "b",
      }),
    ).not.toThrow();
  });

  test("accepts one same-level continuation plus multiple deeper branches", () => {
    const nodes = [
      { ...node("2A", 2), activeBranchRootId: "3A" },
      node("2B", 2, "2A"),
      node("3A", 3, "2A"),
      node("3X", 3, "2A"),
      node("3B", 3, "3A"),
    ];

    const index = validateConversationGraph({
      messages: nodes,
      rootNodeId: "2A",
      activeCursorId: "2B",
    });

    expect(index.sameLevelChildByParentId.get("2A")?.id).toBe("2B");
    expect(index.childrenByParentId.get("2A")?.map((item) => item.id)).toEqual([
      "2B",
      "3A",
      "3X",
    ]);
  });

  test("projects the active deeper branch before the same-level continuation", () => {
    const nodes = [
      { ...node("1", 1), activeBranchRootId: "2A" },
      { ...node("2A", 2, "1"), activeBranchRootId: "3A" },
      node("2B", 2, "2A"),
      node("3A", 3, "2A"),
      node("3B", 3, "3A"),
      node("3C", 3, "3B"),
    ];
    const graph = {
      messages: nodes,
      rootNodeId: "1",
      activeCursorId: "2B",
    };

    expect(projectActiveConversation(graph).map((item) => item.id)).toEqual([
      "1",
      "2A",
      "3A",
      "3B",
      "3C",
      "2B",
    ]);
    expect(projectConversationToCursor(graph).map((item) => item.id)).toEqual([
      "1",
      "2A",
      "3A",
      "3B",
      "3C",
      "2B",
    ]);

    graph.activeCursorId = "3B";
    expect(projectConversationToCursor(graph).map((item) => item.id)).toEqual([
      "1",
      "2A",
      "3A",
      "3B",
    ]);
  });

  test("returns no provider history when the cursor is outside the active branch", () => {
    const nodes = [
      { ...node("root", 1), activeBranchRootId: "active" },
      node("active", 2, "root"),
      node("inactive", 2, "root"),
    ];

    expect(
      projectConversationToCursor({
        messages: nodes,
        rootNodeId: "root",
        activeCursorId: "inactive",
      }),
    ).toEqual([]);
  });

  test("rejects multiple same-level continuations and invalid active branches", () => {
    expect(() =>
      validateConversationGraph({
        messages: [node("a", 1), node("b", 1, "a"), node("c", 1, "a")],
        rootNodeId: "a",
        activeCursorId: "c",
      }),
    ).toThrow("Multiple same-level children");

    expect(() =>
      validateConversationGraph({
        messages: [
          { ...node("a", 1), activeBranchRootId: "b" },
          node("b", 1, "a"),
        ],
        rootNodeId: "a",
        activeCursorId: "b",
      }),
    ).toThrow("Invalid active branch");
  });

  test("remaps graph references and node summary sources when forking", () => {
    let nextId = 0;
    const nodes: ConversationNode[] = [
      { ...node("a", 1), activeBranchRootId: "branch" },
      {
        ...node("branch", 2, "a"),
        nodeSummaries: {
          segment: {
            content: "summary",
            sourceNodeIds: ["a", "branch"],
            tokenCount: 2,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
    ];

    const { nodes: remapped, ids } = remapConversationNodes(
      nodes,
      () => `new-${nextId++}`,
    );

    expect(remapped[0].activeBranchRootId).toBe(ids.get("branch"));
    expect(remapped[1].parentId).toBe(ids.get("a"));
    expect(remapped[1].nodeSummaries?.segment?.sourceNodeIds).toEqual([
      ids.get("a"),
      ids.get("branch"),
    ]);
  });
});
