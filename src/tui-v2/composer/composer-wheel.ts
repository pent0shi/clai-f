/**
 * Wheel over the composer: scroll an overflowing draft in-place, or signal
 * that the chat transcript should scroll instead.
 */

export function composerDraftOverflows(
  contentLines: number,
  visibleRows: number,
): boolean {
  return Math.max(1, contentLines) > Math.max(1, visibleRows);
}

/** Next viewport Y for an overflowing draft; undefined if nothing to scroll. */
export function nextComposerScrollOffset(opts: {
  readonly offsetY: number;
  readonly viewportHeight: number;
  readonly totalLines: number;
  readonly direction: "up" | "down" | string;
  readonly delta?: number | undefined;
  readonly lineStep?: number | undefined;
}): number | undefined {
  const height = Math.max(1, opts.viewportHeight);
  const total = Math.max(0, opts.totalLines);
  const maxOffset = Math.max(0, total - height);
  if (maxOffset <= 0) return undefined;
  const step = Math.max(1, opts.delta ?? 1) * Math.max(1, opts.lineStep ?? 3);
  const cur = Math.max(0, Math.min(maxOffset, opts.offsetY));
  if (opts.direction === "up") return Math.max(0, cur - step);
  if (opts.direction === "down") return Math.min(maxOffset, cur + step);
  return undefined;
}

/** Minimal editor surface used for draft-internal wheel scroll. */
export interface ComposerWheelEditor {
  readonly virtualLineCount?: number;
  readonly editorView: {
    getViewport(): {
      offsetY: number;
      offsetX: number;
      height: number;
      width: number;
    };
    getTotalVirtualLineCount?: () => number;
    setViewport(
      x: number,
      y: number,
      width: number,
      height: number,
      moveCursor?: boolean,
    ): void;
  };
  moveCursorUp(): unknown;
  moveCursorDown(): unknown;
}

/**
 * Scroll the draft when it overflows the visible rows.
 * Returns true when the wheel was consumed by the composer (not chat).
 */
export function tryScrollComposerDraft(
  editor: ComposerWheelEditor,
  opts: {
    readonly contentLines: number;
    readonly visibleRows: number;
    readonly direction: "up" | "down" | string;
    readonly delta?: number | undefined;
  },
): boolean {
  if (!composerDraftOverflows(opts.contentLines, opts.visibleRows)) return false;

  try {
    const view = editor.editorView;
    const vp = view.getViewport();
    const total =
      view.getTotalVirtualLineCount?.() ??
      editor.virtualLineCount ??
      opts.contentLines;
    const nextY = nextComposerScrollOffset({
      offsetY: vp.offsetY,
      viewportHeight: vp.height || opts.visibleRows,
      totalLines: total,
      direction: opts.direction,
      delta: opts.delta,
    });
    if (nextY !== undefined) {
      view.setViewport(vp.offsetX, nextY, vp.width, vp.height, false);
      return true;
    }
  } catch {
    // Fall through to cursor-based scroll.
  }

  const steps = Math.max(1, opts.delta ?? 1) * 3;
  if (opts.direction === "up") {
    for (let i = 0; i < steps; i++) editor.moveCursorUp();
    return true;
  }
  if (opts.direction === "down") {
    for (let i = 0; i < steps; i++) editor.moveCursorDown();
    return true;
  }
  return true;
}
