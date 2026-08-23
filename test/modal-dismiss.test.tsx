import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../app/locales", () => ({
  default: {
    UI: {
      Close: "Close",
      Maximize: "Maximize",
      Restore: "Restore",
    },
  },
}));
vi.mock("../app/icons/close.svg", () => ({ default: () => null }));
vi.mock("../app/icons/max.svg", () => ({ default: () => null }));
vi.mock("../app/icons/min.svg", () => ({ default: () => null }));

import { Modal } from "../app/components/ui-lib";

const dialogRect = {
  x: 100,
  y: 100,
  left: 100,
  top: 100,
  right: 300,
  bottom: 300,
  width: 200,
  height: 200,
  toJSON: () => ({}),
} as DOMRect;

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  cleanup();
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  vi.restoreAllMocks();
});

describe("modal light dismiss", () => {
  test("dismisses only when the pointer press and release both occur on the backdrop", () => {
    const onClose = vi.fn();
    const view = render(
      <Modal title="Node details" onClose={onClose}>
        <div data-testid="content">Selectable content</div>
      </Modal>,
    );
    const dialog = view.getByRole("dialog") as HTMLDialogElement;
    const content = view.getByTestId("content");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(dialogRect);

    fireEvent.pointerDown(content, { pointerId: 1, clientX: 150, clientY: 150 });
    fireEvent.pointerUp(dialog, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.click(dialog, { clientX: 50, clientY: 50 });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog, { pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(content, { pointerId: 2, clientX: 150, clientY: 150 });
    fireEvent.click(content, { clientX: 150, clientY: 150 });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog, { pointerId: 3, clientX: 150, clientY: 150 });
    fireEvent.pointerUp(dialog, { pointerId: 3, clientX: 150, clientY: 150 });
    fireEvent.click(dialog, { clientX: 150, clientY: 150 });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog, { pointerId: 4, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(dialog, { pointerId: 4, clientX: 50, clientY: 50 });
    fireEvent.click(dialog, { clientX: 50, clientY: 50 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("keeps platform cancel dismissal", () => {
    const onClose = vi.fn();
    const view = render(<Modal title="Node details" onClose={onClose} />);
    const dialog = view.getByRole("dialog");

    const event = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
