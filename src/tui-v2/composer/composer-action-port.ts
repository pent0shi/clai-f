/**
 * Bridge so chrome outside the composer (status chips) can clear the draft
 * without holding a React ref to the textarea.
 */

type ClearHandler = () => void;

let clearHandler: ClearHandler | undefined;

export const composerActionPort = {
  /** Register the active composer's clear implementation. Returns unregister. */
  registerClear(handler: ClearHandler): () => void {
    clearHandler = handler;
    return () => {
      if (clearHandler === handler) clearHandler = undefined;
    };
  },

  /** Clear the composer draft if a handler is registered. */
  clear(): void {
    clearHandler?.();
  },
};
