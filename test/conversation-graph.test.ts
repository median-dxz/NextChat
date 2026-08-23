import { describe, expect, test } from "vitest";
import { Conversation } from "../app/utils/conversation";
import { createCoverageDigest } from "../app/utils/conversation/node";

function node(id: string, outlineLevel: number, parentId?: string): Conversation.Node {
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
  test("returns immutable snapshots and only replaces updated node data", () => {
    const first = node("a", 1);
    const second = node("b", 1, "a");
    const original = {
      messages: [first, second],
      rootNodeId: "a",
      activeCursorId: "b",
    };
    const conversation = Conversation(original);
    const inserted = conversation.insert(node("c", 1));
    const updated = conversation.updateNodeData("b", (target) => {
      target.content = "updated";
    });

    expect(original.messages).toEqual([first, second]);
    expect(conversation.projectActive()).toEqual([first, second]);
    expect(inserted.state.messages).not.toBe(original.messages);
    expect(updated.state.messages[0]).toBe(first);
    expect(updated.state.messages[1]).not.toBe(second);
    expect(updated.state.messages[1].content).toBe("updated");
  });

  test("accepts one same-level continuation plus multiple deeper branches", () => {
    const nodes = [
      { ...node("2A", 1), activeBranchRootId: "3A" },
      node("2B", 1, "2A"),
      node("3A", 2, "2A"),
      node("3X", 2, "2A"),
      node("3B", 2, "3A"),
    ];

    const conversation = Conversation({
      messages: nodes,
      rootNodeId: "2A",
      activeCursorId: "2B",
    });
    conversation.validate();

    expect(conversation.node("2A").sameLevelSuccessor?.id).toBe("2B");
    expect(conversation.node("2A").branches.map((item) => item.id)).toEqual(["3A", "3X"]);
  });

  test("changes a node level by shifting its whole subtree", () => {
    const messages = [
      { ...node("1A", 1), activeBranchRootId: "2A" },
      node("1B", 1, "1A"),
      { ...node("2A", 2, "1A"), activeBranchRootId: "3A" },
      node("3A", 3, "2A"),
    ];
    const changed = Conversation({
      messages,
      rootNodeId: "1A",
      activeCursorId: "3A",
    })
      .node("2A")
      .shiftLevel(-1);

    expect(changed.state.messages.map((item) => [item.id, item.outlineLevel])).toEqual([
      ["1A", 1],
      ["1B", 1],
      ["2A", 1],
      ["3A", 2],
    ]);
    expect(changed.node("1B").parent?.id).toBe("2A");
    expect(changed.node("1A").value.activeBranchRootId).toBeUndefined();
    expect(() => changed.node("1A").shiftLevel(1)).toThrow("root node");
  });

  test("moves a cursor hidden by indenting a new selected branch to that branch tail", () => {
    const messages = [
      { ...node("root", 1), activeBranchRootId: "old" },
      node("later", 1, "root"),
      node("later-tail", 1, "later"),
      node("old", 2, "root"),
    ];

    const changed = Conversation({
      messages,
      rootNodeId: "root",
      activeCursorId: "old",
    })
      .node("later")
      .shiftLevel(1);

    expect(changed.node("root").value.activeBranchRootId).toBe("later");
    expect(changed.state.activeCursorId).toBe("later-tail");
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

  test("rejects missing and inactive cursors in a non-empty graph", () => {
    const nodes = [
      { ...node("root", 1), activeBranchRootId: "active" },
      node("active", 2, "root"),
      node("inactive", 2, "root"),
    ];

    expect(() =>
      Conversation({
        messages: nodes,
        rootNodeId: "root",
        activeCursorId: "inactive",
      }).validate(),
    ).toThrow("active projection");
    expect(() =>
      Conversation({
        messages: nodes,
        rootNodeId: "root",
        activeCursorId: undefined,
      }).validate(),
    ).toThrow("cursor must reference");
    expect(() =>
      Conversation({
        messages: [node("root", 2)],
        rootNodeId: "root",
        activeCursorId: "root",
      }).validate(),
    ).toThrow("outline level 1");
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
        messages: [{ ...node("a", 1), activeBranchRootId: "b" }, node("b", 1, "a")],
        rootNodeId: "a",
        activeCursorId: "b",
      }).validate(),
    ).toThrow("Invalid active branch");
  });

  test("remaps graph references and node summary sources when forking", () => {
    let nextId = 0;
    const nodes: Conversation.Node[] = [
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

    const { conversation, ids } = Conversation({
      messages: nodes,
      rootNodeId: "a",
      activeCursorId: "branch",
    }).clone(() => `new-${nextId++}`);
    const graph = conversation.state;
    const remapped = graph.messages;

    expect(graph.rootNodeId).toBe(ids.get("a"));
    expect(graph.activeCursorId).toBe(ids.get("branch"));
    expect(remapped[0].activeBranchRootId).toBe(ids.get("branch"));
    expect(remapped[1].parentId).toBe(ids.get("a"));
    expect(remapped[1].nodeSummaries?.segment?.sourceNodeIds).toEqual([
      ids.get("a"),
      ids.get("branch"),
    ]);
    expect(remapped[1].nodeSummaries?.segment?.sourceDigest).toBe(createCoverageDigest(remapped));
  });

  test("drops a cloned summary after one of its sources was deleted", () => {
    const source = node("source", 1);
    const owner = {
      ...node("owner", 1, source.id),
      nodeSummaries: {
        segment: {
          content: "summary",
          sourceNodeIds: [source.id, "owner"],
          sourceDigest: "digest",
          provenance: "generated" as const,
        },
      },
    };

    const afterDeletion = Conversation({
      messages: [source, owner],
      rootNodeId: source.id,
      activeCursorId: owner.id,
    })
      .node(source.id)
      .remove();
    expect(afterDeletion.node(owner.id).value.nodeSummaries?.segment).toBeDefined();

    const { conversation } = afterDeletion.clone(() => "cloned-owner");

    expect(conversation.state.messages[0].nodeSummaries?.segment).toBeUndefined();
  });

  test("inserts a same-level node into the continuation chain", () => {
    const graph = {
      messages: [node("a", 1), node("b", 1, "a")],
      rootNodeId: "a",
      activeCursorId: "a",
    };

    const inserted = Conversation(graph).insert(node("x", 99));

    expect(inserted.projectActive().map((item) => item.id)).toEqual(["a", "x", "b"]);
    expect(inserted.state.messages.find((item) => item.id === "x")).toMatchObject({
      parentId: "a",
      outlineLevel: 1,
    });
    expect(inserted.state.messages.find((item) => item.id === "b")?.parentId).toBe("x");
    expect(inserted.state.activeCursorId).toBe("x");
  });

  test("reparents a deeper projected neighbor when inserting before it", () => {
    const graph = {
      messages: [{ ...node("a", 1), activeBranchRootId: "branch" }, node("branch", 2, "a")],
      rootNodeId: "a",
      activeCursorId: "branch",
    };

    const inserted = Conversation(graph).insertProjected(node("x", 99), "a");

    expect(inserted.projectActive().map((item) => item.id)).toEqual(["a", "x", "branch"]);
    expect(inserted.state.messages.find((item) => item.id === "x")).toMatchObject({
      parentId: "a",
      outlineLevel: 1,
      activeBranchRootId: "branch",
    });
    expect(inserted.state.messages.find((item) => item.id === "branch")?.parentId).toBe("x");
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

    expect(swapped.projectActive().map((item) => item.id)).toEqual([
      "e",
      "f",
      "g",
      "d",
      "a",
      "b",
      "c",
      "h",
    ]);
    expect(swapped.state.messages.find((item) => item.id === "b")?.parentId).toBe("a");
    expect(() => Conversation(graph).swap("b", "f")).toThrow("same outline chain");
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

    expect(deleted.state.messages.map((item) => item.id)).toEqual(["b"]);
    expect(deleted.state.messages[0].parentId).toBeUndefined();
    expect(deleted.state.rootNodeId).toBe("b");
    expect(deleted.state.activeCursorId).toBe("b");
  });

  test("deleting a selected branch head promotes its same-level successor", () => {
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

    expect(deleted.state.messages.map((item) => item.id)).toEqual(["root", "after", "deep"]);
    expect(deleted.state.messages.find((item) => item.id === "deep")).toMatchObject({
      parentId: "root",
      outlineLevel: 2,
    });
    expect(deleted.state.messages[0].activeBranchRootId).toBe("deep");
    expect(deleted.state.activeCursorId).toBe("deep");
  });

  test("deleting a node returns a cursor from its removed child branch to the node parent", () => {
    const graph = {
      messages: [
        { ...node("root", 1), activeBranchRootId: "branch" },
        { ...node("branch", 2, "root"), activeBranchRootId: "nested" },
        node("nested", 3, "branch"),
      ],
      rootNodeId: "root",
      activeCursorId: "nested",
    };

    const deleted = Conversation(graph).node("branch").remove();

    expect(deleted.state.messages.map((item) => item.id)).toEqual(["root"]);
    expect(deleted.node("root").value.activeBranchRootId).toBeUndefined();
    expect(deleted.state.activeCursorId).toBe("root");
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
        .setBranch("next").state.activeCursorId,
    ).toBe("after");
    expect(
      Conversation({
        messages,
        rootNodeId: "root",
        activeCursorId: "old",
      })
        .node("root")
        .setBranch("next").state.activeCursorId,
    ).toBe("next-tail");
  });

  test("deactivating a branch preserves a main-chain cursor and returns a hidden cursor to the parent", () => {
    const messages = [
      { ...node("root", 1), activeBranchRootId: "branch" },
      node("after", 1, "root"),
      node("branch", 2, "root"),
    ];

    expect(
      Conversation({
        messages,
        rootNodeId: "root",
        activeCursorId: "after",
      })
        .node("root")
        .setBranch(undefined).state.activeCursorId,
    ).toBe("after");
    expect(
      Conversation({
        messages,
        rootNodeId: "root",
        activeCursorId: "branch",
      })
        .node("root")
        .setBranch(undefined).state.activeCursorId,
    ).toBe("root");
  });
});
