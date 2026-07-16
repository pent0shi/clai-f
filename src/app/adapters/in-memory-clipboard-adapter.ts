import type { ClipboardPort } from "../ports/clipboard-port.js";

export interface InMemoryClipboard extends ClipboardPort {
  readonly lastText: string | undefined;
}


export function createInMemoryClipboardPort(): InMemoryClipboard {
  let last: string | undefined;
  return {
    get lastText() {
      return last;
    },
    async writeText(text: string) {
      last = text;
    },
    async readText() {
      return last;
    },
  };
}
