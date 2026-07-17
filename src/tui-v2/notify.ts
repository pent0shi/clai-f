/**
 * Ephemeral UI notifications via the toast stack.
 *
 * Prefer this over session.notice for chrome feedback (toggles, jumps, clear)
 * so the transcript is not filled with UI chatter. Use session.notice for
 * durable session/mode/config facts that should stay in chat history.
 */

import type { ToastController, ToastLevel } from "./controllers/toast-controller.js";

export interface NotifyTarget {
  readonly toast: ToastController;
}

export interface NotifyOptions {
  readonly level?: ToastLevel | undefined;
  readonly durationMs?: number | undefined;
  readonly key?: string | undefined;
}

/** Show a short toast. Empty messages are no-ops. */
export function notify(
  services: NotifyTarget,
  message: string,
  options: NotifyOptions = {},
): void {
  services.toast.show(message, {
    level: options.level ?? "info",
    ...(options.durationMs !== undefined
      ? { durationMs: options.durationMs }
      : {}),
    ...(options.key !== undefined ? { key: options.key } : {}),
  });
}

export function notifySuccess(
  services: NotifyTarget,
  message: string,
  options: Omit<NotifyOptions, "level"> = {},
): void {
  notify(services, message, { ...options, level: "success" });
}

export function notifyWarn(
  services: NotifyTarget,
  message: string,
  options: Omit<NotifyOptions, "level"> = {},
): void {
  notify(services, message, { ...options, level: "warn" });
}

export function notifyError(
  services: NotifyTarget,
  message: string,
  options: Omit<NotifyOptions, "level"> = {},
): void {
  notify(services, message, { ...options, level: "error" });
}
