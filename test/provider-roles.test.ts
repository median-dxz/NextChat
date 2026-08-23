import { describe, expect, test } from "vitest";

import {
  toBaiduRole,
  toGeminiRole,
  toTencentRole,
} from "../app/client/platforms/roles";

describe("provider conversation roles", () => {
  test.each([
    ["system", "user"],
    ["user", "user"],
    ["assistant", "model"],
  ] as const)("maps %s for Gemini", (role, expected) => {
    expect(toGeminiRole(role)).toBe(expected);
  });

  test.each([
    ["system", "user"],
    ["user", "user"],
    ["assistant", "assistant"],
  ] as const)("maps %s for Baidu", (role, expected) => {
    expect(toBaiduRole(role)).toBe(expected);
  });

  test("keeps only the first Tencent system message as system", () => {
    expect(toTencentRole("system", 0)).toBe("system");
    expect(toTencentRole("system", 1)).toBe("user");
    expect(toTencentRole("assistant", 1)).toBe("assistant");
  });
});
