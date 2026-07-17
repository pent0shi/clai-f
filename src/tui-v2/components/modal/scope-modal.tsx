/** @jsxImportSource @opentui/react */
/**
 * Engagement scope editor — multi-row target inputs docked above the composer.
 *
 * Empty targets = scoping disabled. Add more rows with + / Ctrl+A.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type InputRenderable, type KeyEvent } from "@opentui/core";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";
import type { ScopeEditorRequest } from "../../controllers/overlay-controller.js";

export interface ScopeModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: ScopeEditorRequest;
  readonly docked?: boolean | undefined;
}

const ACCENT = "#2EEBFF";

export function ScopeModal(props: ScopeModalProps): ReactNode {
  const { services, theme, request, docked } = props;
  const seed =
    request.initialTargets.length > 0 ? [...request.initialTargets, ""] : [""];
  const [rowCount, setRowCount] = useState(seed.length);
  const [focusIdx, setFocusIdx] = useState(0);
  /** Live text mirrors for display / save (inputs are uncontrolled via ref). */
  const [drafts, setDrafts] = useState<string[]>(seed);
  const inputRefs = useRef<Array<InputRenderable | null>>([]);

  useEffect(() => {
    queueMicrotask(() => {
      const el = inputRefs.current[focusIdx];
      el?.focus();
      // Prefill from seed once the ref is live.
      if (el && drafts[focusIdx] && el.plainText !== drafts[focusIdx]) {
        try {
          el.setText?.(drafts[focusIdx]!);
        } catch {
          /* setText may be unavailable on some builds */
        }
      }
    });
  }, [focusIdx, rowCount]);

  function readTargets(): string[] {
    const out: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      const fromRef = inputRefs.current[i]?.plainText?.trim() ?? "";
      const fromDraft = (drafts[i] ?? "").trim();
      const v = fromRef || fromDraft;
      if (v) out.push(v);
    }
    return out;
  }

  function syncDraft(index: number): void {
    const text = inputRefs.current[index]?.plainText ?? "";
    setDrafts((prev) => {
      const next = [...prev];
      while (next.length < rowCount) next.push("");
      next[index] = text;
      return next;
    });
  }

  function addRow(): void {
    setRowCount((n) => n + 1);
    setDrafts((prev) => [...prev, ""]);
    setFocusIdx(rowCount);
  }

  function submit(): void {
    services.overlay.answerScope(readTargets());
  }

  function clearAll(): void {
    services.overlay.answerScope([]);
  }

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.answerScope(undefined);
      return;
    }
    if (chord === "ctrl+a") {
      key.preventDefault();
      addRow();
      return;
    }
    if (chord === "ctrl+enter" || chord === "meta+enter") {
      key.preventDefault();
      submit();
      return;
    }
    if (chord === "enter") {
      key.preventDefault();
      syncDraft(focusIdx);
      const cur =
        inputRefs.current[focusIdx]?.plainText?.trim() ??
        (drafts[focusIdx] ?? "").trim();
      if (focusIdx === rowCount - 1 && cur.length > 0) {
        addRow();
        return;
      }
      submit();
    }
  });

  const liveTargets = readTargets();
  const scopingOff = liveTargets.length === 0;

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
          {" SCOPE "}
        </text>
        <text content=" " />
        <text style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          authorized targets · empty = scoping disabled
        </text>
      </box>

      {scopingOff ? (
        <text
          content="Scoping disabled — no authorized targets. Active recon is unrestricted until you add hosts."
          style={{ fg: theme.mode, attributes: TextAttributes.DIM }}
        />
      ) : (
        <text
          content={`Will authorize: ${liveTargets.join(", ")}`}
          style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
        />
      )}

      {Array.from({ length: rowCount }, (_, index) => (
        <box
          key={index}
          style={{ flexDirection: "row", width: "100%" }}
        >
          <text
            content={`${index + 1}. `}
            style={{ fg: theme.muted, width: 4, flexShrink: 0 }}
          />
          <input
            ref={(el: InputRenderable | null) => {
              inputRefs.current[index] = el;
            }}
            focused={focusIdx === index}
            placeholder="host or domain (e.g. example.com)"
            onContentChange={() => {
              syncDraft(index);
              setFocusIdx(index);
            }}
            backgroundColor={theme.background}
            textColor={theme.foreground}
            focusedBackgroundColor={theme.background}
            focusedTextColor={theme.foreground}
            cursorColor={ACCENT}
            style={{ flexGrow: 1, minWidth: 24 }}
          />
        </box>
      ))}

      <box style={{ flexDirection: "row", width: "100%" }}>
        <text
          content=" + add "
          style={{
            fg: theme.background,
            bg: theme.chip,
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
          content=" Clear (disable) "
          style={{
            fg: theme.white,
            bg: theme.failedBg,
            attributes: TextAttributes.BOLD,
          }}
          onMouseDown={() => clearAll()}
        />
        <text content=" " />
        <text
          content=" Cancel "
          style={{ fg: theme.foreground, bg: theme.chip }}
          onMouseDown={() => services.overlay.answerScope(undefined)}
        />
      </box>

      <text
        content="enter:save  ·  ^a / +:add row  ·  clear:disable scope  ·  esc:cancel"
        style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
      />
    </box>
  );
}
