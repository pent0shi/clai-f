/** @jsxImportSource @opentui/react */

import { useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { SessionController } from "../../../app/controllers/session-controller.js";
import {
  formatTokenCount,
  type ContextUsageSnapshot,
} from "../../../llm/token-usage.js";
import type { Theme } from "../../rendering/theme.js";

export type StatusDensity = "xs" | "sm" | "md" | "lg";

/** Raw current context-token count; show a denominator only when explicitly set. */
export function contextChipForDensity(
  usage: ContextUsageSnapshot | undefined,
  _density: StatusDensity,
): string | undefined {
  if (!usage) return undefined;
  const used = formatTokenCount(usage.contextTokens);
  return usage.contextLimit > 0
    ? `ctx ${used}/${formatTokenCount(usage.contextLimit, true)}`
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
}): ReactNode {
  const { chip, theme, exact, usage, session } = props;
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [value, setValue] = useState("");
  const open = (): void => {
    setValue(usage.contextLimit > 0 ? String(usage.contextLimit) : "");
    setEditing(true);
  };
  const submit = (): void => {
    const limit = parseContextLimitInput(value);
    if (limit === null) return;
    session.setContextLimitTokens(limit);
    setEditing(false);
  };
  const reset = (): void => {
    session.setContextLimitTokens(undefined);
    setValue("");
    setEditing(false);
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

  const label = hovered ? "edit ctx limit" : chip;
  return (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      style={{
        flexDirection: "row",
        flexShrink: 0,
        backgroundColor: hovered ? theme.selection : theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        selectable={false}
        content={label}
        style={{
          fg: hovered ? theme.white : exact ? theme.cyan : theme.muted,
          attributes: hovered || exact ? TextAttributes.BOLD : TextAttributes.DIM,
        }}
      />
    </box>
  );
}
