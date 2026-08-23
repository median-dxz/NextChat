import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../app/locales", () => ({ default: {} }));
vi.mock("../app/icons/eye.svg", () => ({ default: () => null }));
vi.mock("../app/icons/eye-off.svg", () => ({ default: () => null }));

import { PasswordInput } from "../app/components/ui-lib";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("does not forward the visibility button label as an invalid input attribute", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const { container, getByRole } = render(
    <PasswordInput aria="Show password" aria-label="API key" />,
  );

  expect(getByRole("button", { name: "Show password" })).toBeTruthy();
  expect(container.querySelector("input")).toHaveAttribute(
    "aria-label",
    "API key",
  );
  expect(container.querySelector("input")).not.toHaveAttribute("aria");
  expect(consoleError).not.toHaveBeenCalledWith(
    expect.stringContaining("reserved for future use in React"),
  );
});
