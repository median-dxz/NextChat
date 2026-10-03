import {
  estimateRequestMessageTokens,
  getContextInputBudget,
  getEffectiveMaxOutputTokens,
} from "../context-budget";
import { planNodeConversationContext, type ContextRepresentation } from "./context-planning";
import type { MessageInput, Node } from "./node";
import type { Workspace } from "./workspace";

const CONTEXT_FRONTIER_LIMIT = 512; // 搜索状态空间上限，防止状态爆炸
const CONTEXT_TOKEN_BUCKET_SIZE = 128; // 状态聚类分桶大小，用于降维近似

export interface AssemblyOptions {
  systemInputs: MessageInput[]; // 系统预设指令集合
  pinnedInputs: MessageInput[]; // 用户置顶的高优先级消息
  globalMemoryInput?: MessageInput; // 全局记忆注入项
  budget: { contextWindowTokens: number; requestedOutputTokens: number }; // 窗口与预期输出大小
  recentRawNodeCount: number; // 期望强制保留的最新原始节点数
  summaries: "enabled" | "disabled"; // 是否启用摘要压缩支持
}

export interface ContextAssembly {
  messages: MessageInput[]; // 最终装配完成、可直接喂给模型的有序消息列表
  effectiveMaxOutputTokens: number; // 当前装配下模型还能安全生成的最大 Token 上限
}

function messageInput(message: MessageInput): MessageInput {
  // 只提纯协议层所需的角色与内容，剥离运行时元数据
  return { role: message.role, content: message.content };
}

function nonNegativeInteger(value: number) {
  // 确保传入规划算法的预算或节点计数必须是 >= 0 的有限整数
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function availableNodes(workspace: Workspace, projection: Node[]) {
  // 定义节点可用的基础条件：存在、无错误、非流式进行中
  const isAvailable = (node: Node | undefined) => Boolean(node && !node.isError && !node.streaming);
  return projection.filter((node) => {
    if (!isAvailable(node)) return false;
    // 如果是 assistant 节点且有父节点，需递归校验父 user 节点是否有效，防止孤立回复引起歧义
    if (node.role !== "assistant" || !node.parentId) return true;
    const parent = workspace.index.nodesById.get(node.parentId);
    return parent?.role !== "user" || isAvailable(parent);
  });
}

function toHistoryMessages(representations: ContextRepresentation[]): MessageInput[] {
  return (
    representations
      .map((representation) => {
        if (representation.kind === "raw") {
          return {
            order: representation.order,
            message: {
              role: representation.node.role,
              content: representation.node.content,
            } satisfies MessageInput,
          };
        }
        // 摘要形态一律作为 assistant 角色注入模型上下文
        return {
          order: representation.order,
          message: {
            role: "assistant",
            content: representation.summary.content,
          } satisfies MessageInput,
        };
      })
      // 严格按投影中的原始时间拓扑序号排序，防止跨链或摘要穿插导致逻辑颠倒
      .sort((left, right) => left.order - right.order)
      .map(({ message }) => message)
  );
}

export function Context(workspace: Workspace) {
  return {
    assemble(options: AssemblyOptions): ContextAssembly {
      // 获取当前分支的完整线性投影
      const projection = workspace.projectToCursor();
      const currentNode = projection.at(-1);

      // 校验游标必须停留在合法的用户输入节点上
      if (
        !currentNode ||
        currentNode.role !== "user" ||
        currentNode.isError ||
        currentNode.streaming
      ) {
        throw new Error("Conversation cursor must point to the current user input");
      }

      // 组装不可裁剪的刚性前缀：系统预设 + 全局记忆 + 置顶消息
      const requiredPrefix = [
        ...options.systemInputs,
        ...(options.globalMemoryInput ? [options.globalMemoryInput] : []),
        ...options.pinnedInputs,
      ].map(messageInput);

      // 组装不可裁剪的刚性后缀：当前用户提问
      const requiredSuffix = messageInput(currentNode);

      // 从上下文窗口中扣除安全留白与期望输出，计算输入总预算
      const inputBudget = getContextInputBudget(
        options.budget.contextWindowTokens,
        options.budget.requestedOutputTokens,
      );

      // 校验刚性 Token 是否超标
      const prefixTokens = requiredPrefix.reduce(
        (sum, message) => sum + estimateRequestMessageTokens(message),
        0,
      );
      const suffixTokens = estimateRequestMessageTokens(requiredSuffix);
      const requiredTokens = prefixTokens + suffixTokens;
      if (requiredTokens > inputBudget) {
        throw new Error("System prompts and current input exceed the context window");
      }

      // 将历史记录（剔除末尾当前节点）及剩余预算送入规划算法
      const historyPlan = planNodeConversationContext({
        workspace,
        projection: availableNodes(workspace, projection.slice(0, -1)),
        recentRawNodeCount: nonNegativeInteger(options.recentRawNodeCount),
        availableTokens: nonNegativeInteger(inputBudget - requiredTokens),
        includeSummaries: options.summaries === "enabled",
        frontierLimit: CONTEXT_FRONTIER_LIMIT,
        tokenBucketSize: CONTEXT_TOKEN_BUCKET_SIZE,
      });

      // 转换历史消息并完成最终拼接
      const history = toHistoryMessages(historyPlan.representations);
      const messages = [...requiredPrefix, ...history, requiredSuffix];

      return {
        messages,
        effectiveMaxOutputTokens: getEffectiveMaxOutputTokens(
          options.budget.contextWindowTokens,
          options.budget.requestedOutputTokens,
          requiredTokens + historyPlan.tokens,
        ),
      };
    },
  };
}

export type Api = ReturnType<typeof Context>;
