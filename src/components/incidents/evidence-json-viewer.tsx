"use client";

import { useEffect, useId, useRef, useState } from "react";

import { UiIcon } from "@/components/ui/ui-icon";
import type { EvidenceResponse } from "@/lib/agent-runtime/view-models";

type CopyState = "idle" | "copied" | "failed";

export function EvidenceJsonViewer({
  evidenceKind,
  payload,
}: {
  evidenceKind: string;
  payload: EvidenceResponse["payload"];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [dialogOpen, setDialogOpen] = useState(false);
  const payloadText = JSON.stringify(payload, null, 2);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }

    document.documentElement.classList.add("dialog-scroll-locked");
    return () =>
      document.documentElement.classList.remove("dialog-scroll-locked");
  }, [dialogOpen]);

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(payloadText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const copyLabel =
    copyState === "copied"
      ? "JSON 已复制"
      : copyState === "failed"
        ? "JSON 复制失败"
        : "复制 JSON";
  const copyFailed = copyState === "failed";
  const copyStatus = copyState === "idle" ? "" : copyLabel;

  function openDialog() {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) {
      setCopyState("idle");
      dialog.showModal();
      setDialogOpen(true);
    }
  }

  function closeDialog() {
    dialogRef.current?.close();
    setDialogOpen(false);
  }

  return (
    <>
      <div className="evidence-code-frame">
        <div className="evidence-code-toolbar">
          <span>JSON</span>
          <div className="evidence-code-actions">
            <button
              type="button"
              onClick={copyPayload}
              aria-label={copyLabel}
              title={copyLabel}
              className={copyFailed ? "is-copy-failed" : undefined}
              data-feedback={copyFailed ? "复制失败" : undefined}
            >
              <UiIcon
                name={
                  copyState === "copied"
                    ? "check"
                    : "copy"
                }
              />
            </button>
            <button
              type="button"
              aria-label="展开 JSON"
              title="展开 JSON"
              onClick={openDialog}
            >
              <UiIcon name="expand" />
            </button>
          </div>
        </div>
        <pre className="evidence-payload">
          <code className="language-json">{payloadText}</code>
        </pre>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {dialogOpen ? "" : copyStatus}
      </span>

      <dialog
        ref={dialogRef}
        className="evidence-dialog"
        aria-labelledby={titleId}
        onClose={() => setDialogOpen(false)}
      >
        <div className="evidence-dialog__surface">
          <header className="evidence-dialog__header">
            <div>
              <span className="eyebrow">JSON Evidence</span>
              <h2 id={titleId}>{evidenceKind} JSON</h2>
            </div>
            <div className="evidence-code-actions">
              <button
                type="button"
                onClick={copyPayload}
                aria-label={copyLabel}
                title={copyLabel}
                className={copyFailed ? "is-copy-failed" : undefined}
                data-feedback={copyFailed ? "复制失败" : undefined}
              >
                <UiIcon
                  name={
                    copyState === "copied"
                      ? "check"
                      : "copy"
                  }
                />
              </button>
              <button
                type="button"
                onClick={closeDialog}
                aria-label="关闭"
                title="关闭"
              >
                <UiIcon name="close" />
              </button>
            </div>
          </header>
          <pre className="evidence-dialog__payload">
            <code className="language-json">{payloadText}</code>
          </pre>
          <span className="sr-only" role="status" aria-live="polite">
            {dialogOpen ? copyStatus : ""}
          </span>
        </div>
      </dialog>
    </>
  );
}
