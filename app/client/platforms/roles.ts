import type { Conversation } from "@/app/utils/conversation";

export function toGeminiRole(role: Conversation.Role): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

export function toBaiduRole(role: Conversation.Role): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

export function toTencentRole(
  role: Conversation.Role,
  index: number,
): "system" | "user" | "assistant" {
  if (role === "assistant") return "assistant";
  if (role === "system" && index === 0) return "system";
  return "user";
}
