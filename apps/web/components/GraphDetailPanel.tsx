"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Non-modal inspector contained by the shared graph canvas. */
export function GraphDetailPanel({
  children,
  onClose,
  title = "Production step",
}: {
  title?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <aside
      className="graph-detail-panel"
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="graph-detail-toolbar">
        <span className="eyebrow">{title}</span>
        <button
          ref={closeButton}
          type="button"
          className="text-button"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      {children}
    </aside>
  );
}
