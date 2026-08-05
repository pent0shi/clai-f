/** @jsxImportSource @opentui/react */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import type { Theme } from "../../rendering/theme.js";

export interface ScrollbarMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportHeight: number;
  readonly y: number;
}

function readMetrics(sb: ScrollBoxRenderable | null): ScrollbarMetrics {
  if (!sb) return { scrollTop: 0, scrollHeight: 0, viewportHeight: 0, y: 0 };
  return {
    scrollTop: sb.scrollTop,
    scrollHeight: sb.scrollHeight,
    viewportHeight: sb.viewport?.height ?? 0,
    y: sb.y,
  };
}

function thumbRange(metrics: ScrollbarMetrics): { top: number; size: number } | null {
  const { scrollTop, scrollHeight, viewportHeight } = metrics;
  if (scrollHeight <= viewportHeight || viewportHeight <= 0) return null;
  const trackSize = viewportHeight;
  const ratio = Math.min(1, viewportHeight / scrollHeight);
  const size = Math.max(1, Math.floor(trackSize * ratio));
  const maxTop = trackSize - size;
  const progress = scrollHeight <= viewportHeight
    ? 0
    : Math.min(1, scrollTop / Math.max(1, scrollHeight - viewportHeight));
  return { top: Math.round(maxTop * progress), size };
}

function buildScrollContent(range: { top: number; size: number }, trackHeight: number): string {
  const lines: string[] = [];
  for (let i = 0; i < range.top; i++) lines.push("│");
  for (let i = 0; i < range.size; i++) lines.push("█");
  for (let i = range.top + range.size; i < trackHeight; i++) lines.push("│");
  return lines.join("\n");
}

export function TranscriptScrollbar(props: {
  readonly scrollRef: React.RefObject<ScrollBoxRenderable | null>;
  readonly theme: Theme;
  readonly followKey: string;
}): ReactNode {
  const { scrollRef, theme, followKey } = props;
  const [metrics, setMetrics] = useState<ScrollbarMetrics>(() =>
    readMetrics(scrollRef.current),
  );
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const dragOffset = useRef<number | undefined>(undefined);
  const lastDragUpdate = useRef(0);

  const refresh = useCallback((): void => {
    setMetrics(readMetrics(scrollRef.current));
  }, [scrollRef]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 100);
    return () => clearInterval(id);
  }, [refresh, followKey]);

  const applyScroll = useCallback(
    (relativeY: number): void => {
      const sb = scrollRef.current;
      if (!sb) return;
      const vh = sb.viewport?.height ?? 0;
      const sh = sb.scrollHeight;
      if (sh <= vh) return;
      const progress = Math.max(0, Math.min(1, relativeY / vh));
      const max = sh - vh;
      sb.scrollTo(Math.round(max * progress));
    },
    [scrollRef],
  );

  const onMouseDown = useCallback(
    (event: MouseEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const sb = scrollRef.current;
      if (!sb) return;
      const relativeY = event.y - sb.y;
      const r = thumbRange(readMetrics(sb));
      if (r) {
        const thumbCenter = r.top + Math.floor(r.size / 2);
        if (Math.abs(relativeY - thumbCenter) <= Math.ceil(r.size / 2)) {
          dragOffset.current = relativeY - r.top;
          draggingRef.current = true;
          setDragging(true);
          return;
        }
      }
      dragOffset.current = undefined;
      draggingRef.current = true;
      setDragging(true);
      applyScroll(relativeY);
    },
    [scrollRef, applyScroll],
  );

  const onMouseDrag = useCallback(
    (event: MouseEvent): void => {
      if (!draggingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const sb = scrollRef.current;
      if (!sb) return;
      const relativeY = event.y - sb.y;
      const vh = sb.viewport?.height ?? 0;
      if (dragOffset.current !== undefined) {
        const r = thumbRange(readMetrics(sb));
        const size = r?.size ?? 1;
        const maxTop = vh - size;
        const desiredTop = relativeY - dragOffset.current;
        const clamped = Math.max(0, Math.min(maxTop, desiredTop));
        const progress = maxTop > 0 ? clamped / maxTop : 0;
        const max = sb.scrollHeight - vh;
        sb.scrollTo(Math.round(max * progress));
      } else {
        applyScroll(relativeY);
      }
      const now = Date.now();
      if (now - lastDragUpdate.current > 40) {
        lastDragUpdate.current = now;
        setMetrics(readMetrics(sb));
      }
    },
    [scrollRef, applyScroll],
  );

  const onMouseUp = useCallback(
    (event: MouseEvent): void => {
      if (!draggingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      draggingRef.current = false;
      setDragging(false);
      setMetrics(readMetrics(scrollRef.current));
    },
    [scrollRef],
  );

  const range = thumbRange(metrics);
  const trackHeight = metrics.viewportHeight;
  const visible = range !== null && trackHeight > 0;
  if (!visible) return null;

  const trackColor = theme.border;
  const thumbColor = dragging ? theme.cyan : theme.muted;
  const content = buildScrollContent(range, trackHeight);

  return (
    <box
      style={{
        position: "absolute",
        top: metrics.y,
        right: 0,
        width: 1,
        height: trackHeight,
        zIndex: 50,
        flexDirection: "column",
      }}
      onMouseDown={onMouseDown}
      onMouseDrag={onMouseDrag}
      onMouseUp={onMouseUp}
    >
      <text
        selectable={false}
        content={content}
        style={{
          fg: trackColor,
          attributes: TextAttributes.DIM,
        }}
      />
      {range.size > 0 ? (
        <text
          selectable={false}
          content={"█".repeat(range.size)}
          style={{
            position: "absolute",
            top: range.top,
            right: 0,
            width: 1,
            fg: thumbColor,
            attributes: TextAttributes.BOLD,
          }}
        />
      ) : null}
    </box>
  );
}

