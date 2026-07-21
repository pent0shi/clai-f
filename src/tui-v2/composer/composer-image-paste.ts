import { captureClipboardImage } from "../../attachments/clipboard-image.js";
import { formatAttachmentReference } from "../../ui/mentions.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { notify } from "../notify.js";

interface ComposerEditor {
  readonly plainText: string;
  readonly cursorOffset: number;
  insertText(text: string): void;
  focus(): void;
}

interface EditorRef {
  readonly current: ComposerEditor | null;
}

interface PreventableEvent {
  preventDefault(): void;
}

interface ComposerImagePaste {
  handleChord(
    chord: string,
    overlayKind: string,
    key: PreventableEvent,
  ): boolean;
  handlePaste(text: string, event: PreventableEvent): boolean;
}

const activePastes = new WeakSet<AppServices>();

export function createComposerImagePaste(
  services: AppServices,
  editorRef: EditorRef,
  refresh: () => void,
): ComposerImagePaste {
  const pasteImage = (): void => {
    if (activePastes.has(services)) return;
    activePastes.add(services);
    setImmediate(() => {
      const result = captureClipboardImage();
      activePastes.delete(services);
      if (!result.ok) {
        notify(services, result.reason, {
          key: "image-paste",
          level: "warn",
          durationMs: 2600,
        });
        return;
      }
      const editor = editorRef.current;
      if (!editor) return;
      const before = editor.plainText[editor.cursorOffset - 1] ?? "";
      const leadingSpace = before && !/\s/.test(before) ? " " : "";
      const reference = formatAttachmentReference(result.path);
      editor.insertText(`${leadingSpace}${reference} `);
      services.focus.focusRegion("composer");
      editor.focus();
      notify(services, "Image attached from clipboard", {
        key: "image-paste",
        durationMs: 1600,
      });
      queueMicrotask(refresh);
    });
  };

  return {
    handleChord(chord, overlayKind, key) {
      if (overlayKind !== "none" || chord !== "ctrl+v") return false;
      key.preventDefault();
      services.focus.focusRegion("composer");
      editorRef.current?.focus();
      pasteImage();
      return true;
    },
    handlePaste(text, event) {
      if (text.trim()) return false;
      event.preventDefault();
      pasteImage();
      return true;
    },
  };
}
