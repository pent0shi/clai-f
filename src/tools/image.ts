import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ToolResult } from "../types.js";
import { detectConvertibleImageFormat } from "../attachments/image-content.js";
import {
  LANG_PATTERN,
  MIN_RELIABLE_CONFIDENCE,
  meaningfulCharCount,
  runOcr,
} from "./ocr.js";

export interface ImageToolRunOptions {
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

async function isDecodableImage(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return detectConvertibleImageFormat(header.subarray(0, bytesRead)) !== undefined;
  } finally {
    await handle.close();
  }
}

export async function imageOcr(
  args: Record<string, unknown>,
  options: ImageToolRunOptions = {},
): Promise<ToolResult> {
  const rawPath = optionalString(args, "path");
  if (!rawPath) {
    return {
      ok: false,
      output: 'image.ocr expects { "path": "/path/to/image.png" }',
      exitCode: 1,
    };
  }

  const lang = optionalString(args, "lang") ?? "eng";
  if (!LANG_PATTERN.test(lang)) {
    return {
      ok: false,
      output: "image.ocr: lang may contain only letters, digits, _, +, or -",
      exitCode: 1,
    };
  }

  const psmRaw = optionalNumber(args, "psm");
  let psmCandidates = [6, 3, 11];
  if (psmRaw !== undefined) {
    const psm = Math.floor(psmRaw);
    if (!Number.isFinite(psmRaw) || psm < 0 || psm > 13) {
      return {
        ok: false,
        output: "image.ocr: psm must be an integer from 0 to 13",
        exitCode: 1,
      };
    }
    psmCandidates = [psm];
  }

  const path = resolve(expandHome(rawPath));
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return {
        ok: false,
        output: `image.ocr: not a regular file: ${path}`,
        exitCode: 1,
      };
    }
    if (info.size === 0) {
      return {
        ok: false,
        output: `image.ocr: ${path} is empty (0 bytes)`,
        exitCode: 1,
      };
    }
    if (!(await isDecodableImage(path))) {
      return {
        ok: false,
        output: `image.ocr: ${path} is not a decodable image (expected PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC or AVIF). For PDFs use pdf.read instead.`,
        exitCode: 1,
      };
    }
  } catch (error) {
    return {
      ok: false,
      output: `image.ocr: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }

  const result = await runOcr({
    path,
    lang,
    psmCandidates,
    timeoutMs: optionalNumber(args, "timeoutMs") ?? 60_000,
    preprocess: optionalBoolean(args, "preprocess") ?? true,
    signal: options.signal,
    onOutput: options.onOutput,
  });

  if (!result.ok) {
    return {
      ok: false,
      output: `image.ocr failed on ${path}: ${result.error ?? "unknown error"}`,
      exitCode: 1,
    };
  }

  if (meaningfulCharCount(result.text) === 0) {
    return {
      ok: true,
      output: `image.ocr: no text was recognized in ${path}. The image may contain no text, or the text may be too small or low-contrast for OCR — if the active model supports vision, inspect the image directly instead.`,
    };
  }

  if (!result.reliable) {
    return {
      ok: true,
      output:
        `image.ocr: no reliable text in ${path} (mean confidence ${result.confidence}%, below the ${MIN_RELIABLE_CONFIDENCE}% threshold). ` +
        "The candidate output was discarded because it is OCR noise, not text — do NOT guess at the image contents from it. " +
        "This usually means the image is a photo, diagram or UI capture without clean machine-readable text. " +
        "If the active model supports vision, inspect the attached image directly instead.",
    };
  }

  const header =
    `[image.ocr ${path} — psm ${result.psm}, confidence ${result.confidence}%` +
    (result.preprocessed ? ", upscaled for OCR" : "") +
    "]";
  return { ok: true, output: `${header}\n\n${result.text}` };
}
