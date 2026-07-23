import { describe, expect, test, vi } from "vitest";

import { ServiceProvider } from "../app/constant";
import {
  createSummaryMaintenance,
  type SummaryMaintenanceSession,
} from "../app/store/summary-maintenance";
import { Conversation } from "../app/utils/conversation";
import {
  chatSession,
  generatedSummary,
  linearConversation,
} from "./fixtures/conversation";
import { createDeferredClientApi } from "./helpers/deferred-client-api";
import { createSessionRepository } from "./helpers/session-repository";

function createHarness(session: SummaryMaintenanceSession) {
  const repository = createSessionRepository([session]);
  const provider = createDeferredClientApi();
  const maintenance = createSummaryMaintenance({
    getSession: repository.getSession,
    updateConversation: repository.updateConversation,
    getClientApi: () => provider.api,
    resolveDefaultModel: () => ["summary-model", ServiceProvider.OpenAI],
    summaryPrompt: "Summarize the conversation",
  });
  return { maintenance, provider, repository };
}

function summarySession(id: string, pairs = 1) {
  const messages = Array.from({ length: pairs }, (_, index) => [
    { id: `${id}-user-${index}`, role: "user" as const, content: `question ${index}` },
    {
      id: `${id}-assistant-${index}`,
      role: "assistant" as const,
      content: `answer ${index}`,
    },
  ]).flat();
  return chatSession(linearConversation(messages), {
    id,
    modelConfig: {
      segmentTargetSourceTokens: 0,
      checkpointTargetSegments: 1,
    },
  });
}

describe("summary maintenance", () => {
  test("coalesces one target and commits Segment before Checkpoint", async () => {
    const session = summarySession("coalesce");
    const targetNodeId = session.messages.at(-1)!.id;
    const { maintenance, provider, repository } = createHarness(session);

    const command = { sessionId: session.id, targetNodeId, force: true };
    const first = maintenance.maintain(command);
    const second = maintenance.maintain(command);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    provider.finish(0, "segment result");
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    provider.finish(1, "checkpoint result");
    await first;

    const target = repository
      .getSession(session.id)!
      .messages.find((message) => message.id === targetNodeId)!;
    expect(target.nodeSummaries?.segment?.content).toBe("segment result");
    expect(target.nodeSummaries?.checkpoint?.content).toBe("checkpoint result");
  });

  test("limits maintenance to the requested summary kind", async () => {
    const session = summarySession("segment-only");
    const targetNodeId = session.messages.at(-1)!.id;
    const { maintenance, provider, repository } = createHarness(session);

    const pending = maintenance.maintain({
      sessionId: session.id,
      targetNodeId,
      force: true,
      onlyKind: "segment",
    });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    provider.finish(0, "segment only");
    await pending;

    const target = repository
      .getSession(session.id)!
      .messages.find((message) => message.id === targetNodeId)!;
    expect(target.nodeSummaries?.segment?.content).toBe("segment only");
    expect(target.nodeSummaries?.checkpoint).toBeUndefined();
    expect(provider.requests).toHaveLength(1);
  });

  test("does not overwrite a Segment edited during generation", async () => {
    const session = summarySession("segment-edit");
    const targetNodeId = session.messages.at(-1)!.id;
    const { maintenance, provider, repository } = createHarness(session);

    const pending = maintenance.maintain({
      sessionId: session.id,
      targetNodeId,
      force: true,
      onlyKind: "segment",
    });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    repository.updateSession(session.id, (draft) => {
      draft.messages = Conversation(draft).summaries.node(targetNodeId).edit(
        "segment",
        "manual segment",
      ).state.messages;
    });
    provider.finish(0, "late generated segment");
    await pending;

    expect(
      repository
        .getSession(session.id)!
        .messages.find((message) => message.id === targetNodeId)?.nodeSummaries
        ?.segment,
    ).toMatchObject({ content: "manual segment", provenance: "user-edited" });
  });

  test("does not overwrite a Checkpoint edited during generation", async () => {
    const session = summarySession("checkpoint-edit");
    const target = session.messages.at(-1)!;
    target.nodeSummaries = {
      segment: generatedSummary(session.messages, "segment"),
    };
    const { maintenance, provider, repository } = createHarness(session);

    const pending = maintenance.maintain({
      sessionId: session.id,
      targetNodeId: target.id,
      force: true,
      onlyKind: "checkpoint",
    });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    repository.updateSession(session.id, (draft) => {
      draft.messages = Conversation(draft).summaries.node(target.id).edit(
        "checkpoint",
        "manual checkpoint",
      ).state.messages;
    });
    provider.finish(0, "late generated checkpoint");
    await pending;

    expect(
      repository
        .getSession(session.id)!
        .messages.find((message) => message.id === target.id)?.nodeSummaries
        ?.checkpoint,
    ).toMatchObject({ content: "manual checkpoint", provenance: "user-edited" });
  });

  test("serializes one Outline Chain and continues after failure", async () => {
    const session = summarySession("serial", 2);
    const firstTargetId = session.messages[1].id;
    const secondTargetId = session.messages[3].id;
    const { maintenance, provider, repository } = createHarness(session);

    const first = maintenance.maintain({
      sessionId: session.id,
      targetNodeId: firstTargetId,
      onlyKind: "segment",
    });
    const firstResult = first.catch((error) => error);
    const second = maintenance.maintain({
      sessionId: session.id,
      targetNodeId: secondTargetId,
      onlyKind: "segment",
    });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    provider.fail(0, new Error("provider failed"));
    await expect(firstResult).resolves.toMatchObject({ message: "provider failed" });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    provider.finish(1, "second segment");
    await second;

    expect(
      repository
        .getSession(session.id)!
        .messages.find((message) => message.id === secondTargetId)?.nodeSummaries
        ?.segment?.content,
    ).toBe("second segment");
  });
});
