"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import clsx from "clsx";

import { showImageModal } from "./ui-lib";

export function MermaidRenderer({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!ref.current) return;

    setHasError(false);
    void mermaid
      .run({
        nodes: [ref.current],
        suppressErrors: true,
      })
      .catch((error: unknown) => {
        setHasError(true);
        console.error(
          "[Mermaid]",
          error instanceof Error ? error.message : error,
        );
      });
  }, [code]);

  function viewSvgInNewWindow() {
    const svg = ref.current?.querySelector("svg");
    if (!svg) return;

    const text = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([text], { type: "image/svg+xml" });
    showImageModal(URL.createObjectURL(blob));
  }

  if (hasError) return null;

  return (
    <div
      className={clsx("no-dark", "mermaid")}
      style={{ cursor: "pointer", overflow: "auto" }}
      ref={ref}
      onClick={viewSvgInNewWindow}
    >
      {code}
    </div>
  );
}
