"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./I18nProvider";

type ConfirmTone = "default" | "danger";

interface ConfirmDialogOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

type PendingConfirm = ConfirmDialogOptions;

export function usePlanottoConfirm() {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const resolverRef = useRef<((result: boolean) => void) | null>(null);

  const closeDialog = useCallback((result: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolve?.(result);
  }, []);

  const confirm = useCallback((options: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      if (resolverRef.current) {
        resolverRef.current(false);
      }

      resolverRef.current = resolve;
      setPending({
        tone: "default",
        ...options,
      });
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, closeDialog]);

  useEffect(() => {
    return () => {
      if (resolverRef.current) {
        resolverRef.current(false);
        resolverRef.current = null;
      }
    };
  }, []);

  const confirmDialog = useMemo(() => {
    if (!pending || typeof document === "undefined") return null;
    return createPortal(
      <div
        className="menu-dialog-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={pending.title || t("common.confirmDialog.title")}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            closeDialog(false);
          }
        }}
      >
        <div className="menu-dialog planotto-confirm-dialog" style={{ maxWidth: "440px" }}>
          <h3 className="planotto-confirm-dialog__title">{pending.title || t("common.confirmDialog.title")}</h3>
          <p className="planotto-confirm-dialog__message">{pending.message}</p>
          <div className="menu-dialog__actions">
            <button
              type="button"
              className={`menu-dialog__confirm ${pending.tone === "danger" ? "planotto-confirm-dialog__confirm--danger" : ""}`.trim()}
              onClick={() => closeDialog(true)}
            >
              {pending.confirmLabel || t("common.confirmDialog.confirm")}
            </button>
            <button type="button" className="menu-dialog__cancel" onClick={() => closeDialog(false)}>
              {pending.cancelLabel || t("common.confirmDialog.cancel")}
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }, [pending, t, closeDialog]);

  return { confirm, confirmDialog };
}
