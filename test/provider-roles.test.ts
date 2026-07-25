import { describe, expect, test } from "vitest";

import {
  toBaiduRole,
  toOpenAICompatibleRole,
  toTencentRole,
} from "../app/client/platforms/roles";

describe("provider model input roles", () => {
  test.each([
    ["instruction", "system"],
    ["user", "user"],
    ["model", "assistant"],
  ] as const)("maps %s for OpenAI-compatible providers", (role, expected) => {
    expect(toOpenAICompatibleRole(role)).toBe(expected);
  });

  test.each([
    ["instruction", "user"],
    ["user", "user"],
    ["model", "assistant"],
  ] as const)("maps %s for Baidu", (role, expected) => {
    expect(toBaiduRole(role)).toBe(expected);
  });

  test("keeps only the first Tencent instruction as system", () => {
    expect(toTencentRole("instruction", 0)).toBe("system");
    expect(toTencentRole("instruction", 1)).toBe("user");
    expect(toTencentRole("model", 1)).toBe("assistant");
  });
});
