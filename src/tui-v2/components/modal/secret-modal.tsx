/** @jsxImportSource @opentui/react */
/**
 * Masked secret entry (INPUT-009, CORE-002, V2-073).
 *
 * Docked above the composer — same chrome as confirmations (no full-screen
 * black wash). Value only leaves via onSubmit / answerSecret.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InputRenderable, KeyEvent } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";
import type { SecretRequestView } from "../../controllers/overlay-controller.js";

export interface SecretModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: SecretRequestView;
  readonly docked?: boolean | undefined;
}

const BLOCKED_CHORDS = new Set(["left", "right", "home", "end", "up", "down"]);
const ACCENT = "#e0b000";

export function SecretModal(props: SecretModalProps): ReactNode {
  const { services, theme, request, docked } = props;
  const inputRef = useRef<InputRenderable>(null);
  const [length, setLength] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function onKeyDown(key: KeyEvent): void {
    const chord = chordFromKeyEvent(key);
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.answerSecret(undefined);
      return;
    }
    if (BLOCKED_CHORDS.has(chord)) key.preventDefault();
  }

  function submit(): void {
    const value = inputRef.current?.plainText ?? "";
    services.overlay.answerSecret(value.length > 0 ? value : undefined);
  }

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: docked ? "100%" : "70%",
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
          {` SECURE · ${request.title.toUpperCase()} `}
        </text>
        <text content=" " />
        <text style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          never logged or echoed
        </text>
      </box>
      <text style={{ fg: theme.foreground }}>{request.prompt}</text>
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text style={{ fg: ACCENT, attributes: TextAttributes.BOLD }}>password › </text>
        <text style={{ fg: theme.foreground }}>{"•".repeat(Math.max(length, 0))}</text>
        <input
          ref={inputRef}
          focused
          onContentChange={() => setLength(inputRef.current?.plainText.length ?? 0)}
          onSubmit={submit}
          onKeyDown={onKeyDown}
          textColor={theme.statusBackground}
          backgroundColor={theme.statusBackground}
          style={{ width: 1 }}
        />
      </box>
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text style={{ fg: theme.cyan, attributes: TextAttributes.BOLD }}>› </text>
        <text style={{ fg: theme.cyan }}>enter submit  ·  esc cancel</text>
      </box>
    </box>
  );
}
