/** @jsxImportSource @opentui/react */
/**
 * Multi-row API key editor for one LLM provider (/set).
 *
 * Existing keys show as masked placeholders — typing replaces that slot.
 * Empty save on an existing row keeps the stored secret. Mirrors ScopeModal
 * layout (docked above composer).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type InputRenderable, type KeyEvent } from "@opentui/core";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";
import type { KeysEditorRequest } from "../../controllers/overlay-controller.js";
import { MAX_PROVIDER_KEYS } from "../../../llm/key-rotation.js";

export interface KeysModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: KeysEditorRequest;
  readonly docked?: boolean | undefined;
}

const ACCENT = "#e0b000";

interface KeyRow {
  readonly id: number;
  /** Existing storage slot id (keep value when input empty). */
  readonly slotId?: string | undefined;
  /** Placeholder when existing (masked). */
  readonly placeholder: string;
  /** Live typed text (replacement or new). */
  readonly text: string;
}

let nextRowId = 1;

function rowsFromRequest(request: KeysEditorRequest): KeyRow[] {
  if (request.initialKeys.length === 0) {
    return [{ id: nextRowId++, placeholder: "paste API key", text: "" }];
  }
  return [
    ...request.initialKeys.map((k) => ({
      id: nextRowId++,
      slotId: k.id,
      placeholder: k.masked,
      text: "",
    })),
    { id: nextRowId++, placeholder: "paste another API key", text: "" },
  ];
}

export function KeysModal(props: KeysModalProps): ReactNode {
  const { services, theme, request, docked } = props;
  const [rows, setRows] = useState<KeyRow[]>(() => rowsFromRequest(request));
  // With N stored keys we render N rows + one trailing empty — focus that empty
  // row so the user can paste a new key without editing an existing slot first.
  // With no keys, a single empty row is focused at index 0.
  const [focusIdx, setFocusIdx] = useState(() =>
    Math.max(0, request.initialKeys.length),
  );
  const inputRefs = useRef<Map<number, InputRenderable | null>>(new Map());
  const prefilled = useRef(false);

  function applyTextToInputs(list: KeyRow[]): void {
    for (const row of list) {
      const el = inputRefs.current.get(row.id);
      if (!el) continue;
      try {
        if (el.plainText !== row.text) {
          el.setText(row.text);
        }
      } catch {
        /* ignore */
      }
    }
  }

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      applyTextToInputs(rows);
      prefilled.current = true;
      // Always honor focusIdx (initial open targets the trailing empty row when
      // existing keys are present — never force rows[0]).
      const idx = Math.max(0, Math.min(focusIdx, rows.length - 1));
      const focused = rows[idx];
      if (focused) inputRefs.current.get(focused.id)?.focus();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [rows.map((r) => r.id).join(","), focusIdx]);

  function syncFromInputs(): KeyRow[] {
    return rows.map((row) => {
      const el = inputRefs.current.get(row.id);
      const live = el?.plainText;
      return {
        ...row,
        text: live !== undefined ? live : row.text,
      };
    });
  }

  function updateRowText(id: number, text: string): void {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, text } : r)));
  }

  function addRow(): void {
    const synced = syncFromInputs();
    const nonEmpty = synced.filter(
      (r) => r.slotId || r.text.trim().length > 0,
    );
    if (nonEmpty.length >= MAX_PROVIDER_KEYS) {
      services.session.notice(
        "warn",
        `at most ${MAX_PROVIDER_KEYS} API keys per provider`,
      );
      return;
    }
    const next = [
      ...synced,
      { id: nextRowId++, placeholder: "paste another API key", text: "" },
    ];
    setRows(next);
    setFocusIdx(next.length - 1);
  }

  function removeRow(index: number): void {
    const synced = syncFromInputs();
    if (synced.length <= 1) {
      const only = {
        id: nextRowId++,
        placeholder: "paste API key",
        text: "",
      };
      setRows([only]);
      setFocusIdx(0);
      queueMicrotask(() => applyTextToInputs([only]));
      return;
    }
    const removed = synced[index];
    if (removed) inputRefs.current.delete(removed.id);
    const next = synced.filter((_, i) => i !== index);
    setRows(next);
    setFocusIdx(Math.max(0, Math.min(index, next.length - 1)));
    queueMicrotask(() => applyTextToInputs(next));
  }

  function submit(): void {
    const synced = syncFromInputs();
    const out: { slotId?: string; value: string }[] = [];
    for (const row of synced) {
      const value = row.text.trim();
      if (row.slotId) {
        // Existing: empty value keeps stored secret; typed value replaces.
        out.push({ slotId: row.slotId, value });
      } else if (value) {
        out.push({ value });
      }
    }
    services.overlay.answerKeys({ action: "save", rows: out });
  }

  function resetAll(): void {
    services.overlay.answerKeys({ action: "reset" });
  }

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.answerKeys(undefined);
      return;
    }
    if (chord === "ctrl+a") {
      key.preventDefault();
      addRow();
      return;
    }
    // Single-letter 'r' only when not typing in an input with content — use
    // explicit chord: bare "r" when all inputs empty is awkward; use Ctrl+R.
    if (chord === "ctrl+r") {
      key.preventDefault();
      resetAll();
      return;
    }
    if (chord === "ctrl+enter" || chord === "meta+enter" || chord === "enter") {
      key.preventDefault();
      submit();
    }
  });

  const existingCount = request.initialKeys.length;
  const typedCount = rows.filter((r) => r.text.trim().length > 0).length;

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: docked ? "100%" : "80%",
        borderColor: ACCENT,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text
          style={{
            fg: theme.background,
            bg: ACCENT,
            attributes: TextAttributes.BOLD,
          }}
        >
          {" KEYS "}
        </text>
        <text content=" " />
        <text style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          {request.provider} · multi API keys · empty existing = keep
        </text>
      </box>

      <text
        content={
          existingCount > 0
            ? `${existingCount} stored · type to replace a slot · + adds another (max ${MAX_PROVIDER_KEYS})`
            : `No keys yet · paste one or more keys (max ${MAX_PROVIDER_KEYS})`
        }
        style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
      />

      {rows.map((row, index) => (
        <box
          key={row.id}
          style={{ flexDirection: "row", width: "100%", alignItems: "center" }}
        >
          <text
            content={`${index + 1}. `}
            style={{ fg: theme.muted, width: 4, flexShrink: 0 }}
          />
          <input
            ref={(el: InputRenderable | null) => {
              inputRefs.current.set(row.id, el);
            }}
            focused={focusIdx === index}
            placeholder={row.placeholder}
            onContentChange={() => {
              const el = inputRefs.current.get(row.id);
              updateRowText(row.id, el?.plainText ?? "");
              setFocusIdx(index);
            }}
            backgroundColor={theme.background}
            textColor={theme.foreground}
            focusedBackgroundColor={theme.background}
            focusedTextColor={theme.foreground}
            cursorColor={ACCENT}
            style={{ flexGrow: 1, minWidth: 20 }}
          />
          <text content=" " />
          <text
            content=" ✕ "
            style={{
              fg: theme.white,
              bg: theme.failedBg,
              attributes: TextAttributes.BOLD,
              flexShrink: 0,
            }}
            onMouseDown={() => removeRow(index)}
          />
        </box>
      ))}

      <box style={{ flexDirection: "row", width: "100%" }}>
        <text
          content=" + add "
          style={{
            fg: theme.background,
            bg: ACCENT,
            attributes: TextAttributes.BOLD,
          }}
          onMouseDown={() => addRow()}
        />
        <text content=" " />
        <text
          content=" Save "
          style={{
            fg: theme.background,
            bg: theme.success,
            attributes: TextAttributes.BOLD,
          }}
          onMouseDown={() => submit()}
        />
        <text content=" " />
        <text
          content=" Reset all "
          style={{
            fg: theme.white,
            bg: theme.failedBg,
            attributes: TextAttributes.BOLD,
          }}
          onMouseDown={() => resetAll()}
        />
        <text content=" " />
        <text
          content=" Cancel "
          style={{ fg: theme.foreground, bg: theme.chip }}
          onMouseDown={() => services.overlay.answerKeys(undefined)}
        />
      </box>

      <text
        content={`enter:save  ·  ^a / +:add  ·  ✕:remove  ·  ^r:reset all  ·  esc:cancel${typedCount ? `  ·  ${typedCount} new/edited` : ""}`}
        style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
      />
    </box>
  );
}
