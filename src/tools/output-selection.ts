export type ResponsePart = "full" | "headers" | "body";

export interface OutputSelection {
  topLines?: number | undefined;
  bottomLines?: number | undefined;
  maxOutputBytes?: number | undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  if (maxBytes <= 0) return "";

  const marker = "\n... (output truncated by maxOutputBytes)";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let prefix = encoded.subarray(0, contentBudget).toString("utf8");
  const suffix = markerBytes <= maxBytes ? marker : "";

  // Buffer boundaries can bisect a multi-byte code point. Enforce the ceiling
  // after decoding as well, removing complete code points until it fits.
  while (Buffer.byteLength(prefix + suffix, "utf8") > maxBytes) {
    prefix = prefix.slice(0, -1);
  }
  if (suffix) return `${prefix}${suffix}`;

  let compact = encoded.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(compact, "utf8") > maxBytes) {
    compact = compact.slice(0, -1);
  }
  return compact;
}

/** Apply model-requested line windows, then a strict UTF-8 byte ceiling. */
export function selectOutput(
  text: string,
  selection: OutputSelection,
): string {
  const top = nonNegativeInteger(selection.topLines);
  const bottom = nonNegativeInteger(selection.bottomLines);
  let selected = text;

  if (top !== undefined || bottom !== undefined) {
    const lines = text.split("\n");
    if (top !== undefined && bottom !== undefined) {
      if (top + bottom >= lines.length) {
        selected = text;
      } else {
        selected = [
          ...lines.slice(0, top),
          `... (${lines.length - top - bottom} lines omitted)`,
          ...lines.slice(lines.length - bottom),
        ].join("\n");
      }
    } else if (top !== undefined) {
      selected = lines.slice(0, top).join("\n");
    } else if (bottom !== undefined) {
      selected = lines.slice(Math.max(0, lines.length - bottom)).join("\n");
    }
  }

  const maxBytes = nonNegativeInteger(selection.maxOutputBytes);
  return maxBytes === undefined ? selected : truncateUtf8(selected, maxBytes);
}
