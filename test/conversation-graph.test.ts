import { describe, expect, test } from "vitest";
import {
  Conversation,
  createSourceDigest,
  type ConversationNode,
} from "../app/utils/conversation";

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
  test("accepts one same-level continuation plus multiple deeper branches", () => {
    const nodes = [
      { ...node("2A", 2), activeBranchRootId: "3A" },
      node("2B", 2, "2A"),
      node("3A", 3, "2A"),
      node("3X", 3, "2A"),
      node("3B", 3, "3A"),
    ];

    const index = Conversation({
      messages: nodes,
      rootNodeId: "2A",
      activeCursorId: "2B",
    }).validate();

    expect(index.sameLevelChildByParentId.get("2A")?.id).toBe("2B");
    expect(index.childrenByParentId.get("2A")?.map((item) => item.id)).toEqual([
      "2B",
      "3A",
      "3X",
    ]);
  });

  test("changes a node level by shifting its whole subtree", () => {
    const messages = [node("1A", 1), node("2A", 2, "1A"), node("3A", 3, "2A")];
    const changed = Conversation({
      messages,
      rootNodeId: "1A",
      activeCursorId: "3A",
    })
      .node("2A")
      .shiftLevel(-1);

    expect(
      changed.messages.map((item) => [item.id, item.outlineLevel]),
    ).toEqual([
      ["1A", 1],
      ["2A", 1],
      ["3A", 2],
    ]);
    expect(() => Conversation(changed).node("1A").shiftLevel(1)).toThrow(
      "root node",
    );
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

    expect(
      Conversation(graph)
        .projectActive()
        .map((item) => item.id),
    ).toEqual(["1", "2A", "3A", "3B", "3C", "2B"]);
    expect(
      Conversation(graph)
        .projectToCursor()
        .map((item) => item.id),
    ).toEqual(["1", "2A", "3A", "3B", "3C", "2B"]);

    graph.activeCursorId = "3B";
    expect(
      Conversation(graph)
        .projectToCursor()
        .map((item) => item.id),
    ).toEqual(["1", "2A", "3A", "3B"]);
  });

  test("returns no provider history when the cursor is outside the active branch", () => {
    const nodes = [
      { ...node("root", 1), activeBranchRootId: "active" },
      node("active", 2, "root"),
      node("inactive", 2, "root"),
    ];

    expect(
      Conversation({
        messages: nodes,
        rootNodeId: "root",
        activeCursorId: "inactive",
      }).projectToCursor(),
    ).toEqual([]);
  });

  test("rejects multiple same-level continuations and invalid active branches", () => {
    expect(() =>
      Conversation({
        messages: [node("a", 1), node("b", 1, "a"), node("c", 1, "a")],
        rootNodeId: "a",
        activeCursorId: "c",
      }).validate(),
    ).toThrow("Multiple same-level children");

    expect(() =>
      Conversation({
        messages: [
          { ...node("a", 1), activeBranchRootId: "b" },
          node("b", 1, "a"),
        ],
        rootNodeId: "a",
        activeCursorId: "b",
      }).validate(),
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
            sourceDigest: "digest",
            provenance: "generated",
          },
        },
      },
    ];

    const { graph, ids } = Conversation({
      messages: nodes,
      rootNodeId: "a",
      activeCursorId: "branch",
    }).clone(() => `new-${nextId++}`);
    const remapped = graph.messages;

    expect(graph.rootNodeId).toBe(ids.get("a"));
    expect(graph.activeCursorId).toBe(ids.get("branch"));
    expect(remapped[0].activeBranchRootId).toBe(ids.get("branch"));
    expect(remapped[1].parentId).toBe(ids.get("a"));
    expect(remapped[1].nodeSummaries?.segment?.sourceNodeIds).toEqual([
      ids.get("a"),
      ids.get("branch"),
    ]);
    expect(remapped[1].nodeSummaries?.segment?.sourceDigest).toBe(
      createSourceDigest(remapped),
    );
  });

  test("inserts a same-level node into the continuation chain", () => {
    const graph = {
      messages: [node("a", 1), node("b", 1, "a")],
      rootNodeId: "a",
      activeCursorId: "a",
    };

    const inserted = Conversation(graph).insert(node("x", 99));

    expect(
      Conversation(inserted)
        .projectActive()
        .map((item) => item.id),
    ).toEqual(["a", "x", "b"]);
    expect(inserted.messages.find((item) => item.id === "x")).toMatchObject({
      parentId: "a",
      outlineLevel: 1,
    });
    expect(inserted.messages.find((item) => item.id === "b")?.parentId).toBe(
      "x",
    );
    expect(inserted.activeCursorId).toBe("x");
  });

  test("uses a one-shot outline delta to enter and leave a branch", () => {
    let graph = Conversation({
      messages: [],
      rootNodeId: undefined,
      activeCursorId: undefined,
    }).insert(node("root", 99));
    graph = Conversation(graph).insert(node("branch", 99), 1);
    graph = Conversation(graph).insert(node("deep", 99));
    graph = Conversation(graph).insert(node("after", 99), -1);

    expect(
      Conversation(graph)
        .projectActive()
        .map((item) => item.id),
    ).toEqual(["root", "branch", "deep", "after"]);
    expect(graph.messages.find((item) => item.id === "branch")).toMatchObject({
      parentId: "root",
      outlineLevel: 2,
    });
    expect(graph.messages.find((item) => item.id === "after")).toMatchObject({
      parentId: "root",
      outlineLevel: 1,
    });
  });

  test("reparents a deeper projected neighbor when inserting before it", () => {
    const graph = {
      messages: [
        { ...node("a", 2), activeBranchRootId: "branch" },
        node("branch", 3, "a"),
      ],
      rootNodeId: "a",
      activeCursorId: "branch",
    };

    const inserted = Conversation(graph).insertProjected(
      node("x", 99),
      "a",
      "branch",
    );

    expect(
      Conversation(inserted)
        .projectActive()
        .map((item) => item.id),
    ).toEqual(["a", "x", "branch"]);
    expect(inserted.messages.find((item) => item.id === "x")).toMatchObject({
      parentId: "a",
      outlineLevel: 2,
      activeBranchRootId: "branch",
    });
    expect(
      inserted.messages.find((item) => item.id === "branch")?.parentId,
    ).toBe("x");
  });

  test("swaps only nodes in the same outline chain and carries branches", () => {
    const graph = {
      messages: [
        { ...node("a", 1), activeBranchRootId: "b" },
        node("d", 1, "a"),
        { ...node("e", 1, "d"), activeBranchRootId: "f" },
        node("h", 1, "e"),
        node("b", 2, "a"),
        node("c", 2, "b"),
        node("f", 2, "e"),
        node("g", 2, "f"),
      ],
      rootNodeId: "a",
      activeCursorId: "h",
    };

    const swapped = Conversation(graph).swap("a", "e");

    expect(
      Conversation(swapped)
        .projectActive()
        .map((item) => item.id),
    ).toEqual(["e", "f", "g", "d", "a", "b", "c", "h"]);
    expect(swapped.messages.find((item) => item.id === "b")?.parentId).toBe(
      "a",
    );
    expect(() => Conversation(graph).swap("b", "f")).toThrow(
      "same outline chain",
    );
  });

  test("deletes a same-level node but cascades its deeper branches", () => {
    const graph = {
      messages: [
        { ...node("a", 1), activeBranchRootId: "branch" },
        node("b", 1, "a"),
        node("branch", 2, "a"),
        node("deep", 2, "branch"),
      ],
      rootNodeId: "a",
      activeCursorId: "b",
    };

    const deleted = Conversation(graph).node("a").remove();

    expect(deleted.messages.map((item) => item.id)).toEqual(["b"]);
    expect(deleted.messages[0].parentId).toBeUndefined();
    expect(deleted.rootNodeId).toBe("b");
    expect(deleted.activeCursorId).toBe("b");
  });

  test("deleting a branch root cascades the branch and invalidates its cursor", () => {
    const graph = {
      messages: [
        { ...node("root", 1), activeBranchRootId: "branch" },
        node("after", 1, "root"),
        node("branch", 2, "root"),
        node("deep", 2, "branch"),
      ],
      rootNodeId: "root",
      activeCursorId: "deep",
    };

    const deleted = Conversation(graph).node("branch").remove();

    expect(deleted.messages.map((item) => item.id)).toEqual(["root", "after"]);
    expect(deleted.messages[0].activeBranchRootId).toBeUndefined();
    expect(deleted.activeCursorId).toBeUndefined();
  });

  test("branch selection preserves a main-chain cursor and moves an old branch cursor to the new branch tail", () => {
    const messages = [
      { ...node("root", 1), activeBranchRootId: "old" },
      node("after", 1, "root"),
      node("old", 2, "root"),
      node("next", 2, "root"),
      { ...node("next-tail", 2, "next"), activeBranchRootId: "nested" },
      node("nested", 3, "next-tail"),
    ];

    expect(
      Conversation({
        messages,
        rootNodeId: "root",
        activeCursorId: "after",
      })
        .node("root")
        .selectBranch("next").activeCursorId,
    ).toBe("after");
    expect(
      Conversation({
        messages,
        rootNodeId: "root",
        activeCursorId: "old",
      })
        .node("root")
        .selectBranch("next").activeCursorId,
    ).toBe("next-tail");
  });
});
