import type { ModelInputRole } from "../api";

export function toOpenAICompatibleRole(role: ModelInputRole): "system" | "user" | "assistant" {
  if (role === "instruction") return "system";
  if (role === "model") return "assistant";
  return "user";
}

export function toGeminiRole(role: ModelInputRole): "user" | "model" {
  return role === "model" ? "model" : "user";
}

export function toBaiduRole(role: ModelInputRole): "user" | "assistant" {
  return role === "model" ? "assistant" : "user";
}

export function toTencentRole(
  role: ModelInputRole,
  index: number,
): "system" | "user" | "assistant" {
  if (role === "model") return "assistant";
  if (role === "instruction" && index === 0) return "system";
  return "user";
}
