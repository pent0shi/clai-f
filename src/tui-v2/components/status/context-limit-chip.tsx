/** @jsxImportSource @opentui/react */

import { useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { SessionController } from "../../../app/controllers/session-controller.js";
import type { ContextUsageSnapshot } from "../../../llm/token-usage.js";
import type { Theme } from "../../rendering/theme.js";

export type StatusDensity = "xs" | "sm" | "md" | "lg";

function formatContextK(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    if (k >= 100) {
      const r = Math.round(k);
      return r >= 1000 ? "1M" : `${r}k`;
    }
    return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = v / 1_000_000;
  if (m >= 100) return `${Math.round(m)}M`;
  return `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

export function contextChipForDensity(
  usage: ContextUsageSnapshot | undefined,
  _density: StatusDensity,
): string | undefined {
  if (!usage) return undefined;
  const used = formatContextK(usage.contextTokens);
  return usage.contextLimit > 0
    ? `ctx ${used}/${formatContextK(usage.contextLimit)}`
    : `ctx ${used}`;
}

/** Accept familiar token suffixes such as `253k` and `1m`; blank clears. */
export function parseContextLimitInput(value: string): number | undefined | null {
  const text = value.trim().toLowerCase().replace(/,/g, "");
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const tokens = Math.floor(amount * scale);
  return Number.isFinite(tokens) && tokens >= 20_000 ? tokens : null;
}

export function ContextLimitChip(props: {
  chip: string;
  theme: Theme;
  exact: boolean;
  usage: ContextUsageSnapshot;
  session: SessionController;
  /** Called when the inline editor closes so the caller can restore focus. */
  onEditingDone?: (() => void) | undefined;
}): ReactNode {
  const { chip, theme, exact, usage, session, onEditingDone } = props;
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [clickExpanded, setClickExpanded] = useState(false);
  const [value, setValue] = useState("");
  const open = (): void => {
    setValue(usage.contextLimit > 0 ? String(usage.contextLimit) : "");
    setEditing(true);
    setClickExpanded(false);
    setHovered(false);
  };
  const submit = (): void => {
    const limit = parseContextLimitInput(value);
    if (limit === null) return;
    session.setContextLimitTokens(limit);
    setEditing(false);
    onEditingDone?.();
  };
  const reset = (): void => {
    session.setContextLimitTokens(undefined);
    setValue("");
    setEditing(false);
    onEditingDone?.();
  };

  if (editing) {
    return (
      <box style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}>
        <text content="ctx limit " style={{ fg: theme.muted }} />
        <input
          focused
          value={value}
          onInput={setValue}
          onSubmit={submit}
          textColor={theme.foreground}
          backgroundColor={theme.selection}
          placeholder="1m or 253k"
          placeholderColor={theme.muted}
          style={{ width: 12, minWidth: 8 }}
        />
        <box
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            reset();
          }}
          style={{ backgroundColor: theme.chip, paddingLeft: 1, paddingRight: 1 }}
        >
          <text
            selectable={false}
            content="reset"
            style={{ fg: theme.white, attributes: TextAttributes.BOLD }}
          />
        </box>
      </box>
    );
  }

  const shown = hovered || clickExpanded;
  const label = shown ? "edit ctx limit" : chip;
  return (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
      onMouseOver={() => {
        setHovered(true);
        setClickExpanded(false);
      }}
      onMouseOut={() => {
        setHovered(false);
        setClickExpanded(false);
      }}
      style={{
        flexDirection: "row",
        flexShrink: 0,
        backgroundColor: shown ? theme.selection : theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        selectable={false}
        content={label}
        style={{
          fg: shown ? theme.white : exact ? theme.cyan : theme.muted,
          attributes: shown || exact ? TextAttributes.BOLD : TextAttributes.DIM,
        }}
      />
    </box>
  );
}

