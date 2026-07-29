import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { commandAvailable } from "../os/pkgmgr.js";
import { readImageDimensions } from "../attachments/image-content.js";
import { spawnArgv } from "./shell.js";

export const LANG_PATTERN = /^[A-Za-z0-9_+-]+$/;

const PREPROCESS_TARGET_EDGE = 2400;
const PREPROCESS_MIN_EDGE = 1600;
const PREPROCESS_MAX_SCALE = 4;
const GOOD_ENOUGH_SCORE = 40;

export interface OcrRequest {
  readonly path: string;
  readonly lang: string;
  readonly psmCandidates: readonly number[];
  readonly timeoutMs: number;
  readonly dpi?: number | undefined;
  readonly preprocess?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onOutput?:
    | ((chunk: string, stream: "stdout" | "stderr") => void)
    | undefined;
}

export interface OcrResult {
  readonly ok: boolean;
  readonly text: string;
  readonly psm: number;
  readonly preprocessed: boolean;
  readonly confidence: number;
  readonly reliable: boolean;
  readonly error?: string | undefined;
}

export const MIN_RELIABLE_CONFIDENCE = 55;
const MIN_RELIABLE_WORDS = 2;

export function stripCommandEcho(output: string): string {
  return output.replace(/^\$ [^\n]*\n?/, "");
}

export function meaningfulCharCount(text: string): number {
  return (text.match(/[A-Za-z0-9]/g) ?? []).length;
}

export function scoreOcrText(text: string): number {
  const alphanumeric = meaningfulCharCount(text);
  const words = (text.match(/\b[A-Za-z]{2,}\b/g) ?? []).length;
  const noise = (text.match(/[^\w\s.,:;!?'"()\[\]{}<>@#$%&*+/\\|=~^-]/g) ?? [])
    .length;
  return alphanumeric + words * 3 - noise * 2;
}

interface WordConfidence {
  readonly confidence: number;
  readonly text: string;
}

function parseTsvWords(tsv: string): WordConfidence[] {
  const words: WordConfidence[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    const columns = line.split("\t");
    if (columns.length < 12 || columns[0] !== "5") continue;
    const confidence = Number(columns[10]);
    const text = (columns[11] ?? "").trim();
    if (!Number.isFinite(confidence) || confidence < 0 || text.length === 0) {
      continue;
    }
    words.push({ confidence, text });
  }
  return words;
}

function meanConfidence(words: readonly WordConfidence[]): number {
  let weight = 0;
  let total = 0;
  for (const word of words) {
    const length = Math.max(1, word.text.replace(/\s+/g, "").length);
    weight += length;
    total += word.confidence * length;
  }
  return weight === 0 ? 0 : total / weight;
}

function looksLikeRealText(words: readonly WordConfidence[]): boolean {
  const wordLike = words.filter(
    (word) =>
      /^[A-Za-z][A-Za-z'’-]{1,}$/.test(word.text) && /[aeiouy]/i.test(word.text),
  );
  const numeric = words.filter((word) => /^[$€£]?\d[\d.,:/%-]*$/.test(word.text));
  const trusted = wordLike.length + numeric.length;
  if (trusted < MIN_RELIABLE_WORDS) return false;
  return trusted / words.length >= 0.4;
}

const MISSING_RECHECK_MS = 15_000;

let tesseractPresent = false;
let tesseractCheckedAt = 0;

export async function tesseractUnavailableReason(): Promise<string | undefined> {
  if (tesseractPresent) return undefined;
  if (Date.now() - tesseractCheckedAt < MISSING_RECHECK_MS) {
    return missingTesseractHint();
  }
  tesseractCheckedAt = Date.now();
  tesseractPresent = await commandAvailable("tesseract");
  return tesseractPresent ? undefined : missingTesseractHint();
}

function missingTesseractHint(): string {
  return platform() === "darwin"
    ? "tesseract is not installed. Install it with `brew install tesseract` (add `brew install tesseract-lang` for non-English), then retry."
    : platform() === "win32"
      ? "tesseract is not installed. Install it with `scoop install tesseract` or `choco install tesseract`, then retry."
      : "tesseract is not installed. Install it with `apt install tesseract-ocr` (or `dnf install tesseract`), then retry.";
}

let cachedLanguages: Set<string> | undefined;

async function installedLanguages(): Promise<Set<string> | undefined> {
  if (cachedLanguages) return cachedLanguages;
  const result = await spawnArgv({
    command: "tesseract",
    argv: ["--list-langs"],
    timeoutMs: 10_000,
    noArtifact: true,
    maxModelBytes: 32_000,
  });
  if (!result.ok) return undefined;
  const lines = stripCommandEcho(result.output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/[:\s]/.test(line));
  if (lines.length === 0) return undefined;
  cachedLanguages = new Set(lines);
  return cachedLanguages;
}

export async function languageUnavailableReason(
  lang: string,
): Promise<string | undefined> {
  const installed = await installedLanguages();
  if (!installed) return undefined;
  const missing = lang
    .split("+")
    .map((code) => code.trim())
    .filter((code) => code.length > 0 && !installed.has(code));
  if (missing.length === 0) return undefined;
  const hint =
    platform() === "darwin"
      ? "install the data with `brew install tesseract-lang`"
      : platform() === "win32"
        ? "download the .traineddata files into the tessdata directory"
        : `install the data with \`apt install tesseract-ocr-${missing[0]}\``;
  return `tesseract has no training data for ${missing.join(", ")} (installed: ${[...installed].slice(0, 12).join(", ")}). Use one of the installed codes or ${hint}.`;
}

export function resetOcrEnvironmentCache(): void {
  tesseractPresent = false;
  tesseractCheckedAt = 0;
  cachedLanguages = undefined;
}

async function readHeader(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function preprocessForOcr(
  source: string,
  workDir: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let longestEdge = 0;
  try {
    const header = await readHeader(source, 65_536);
    const dimensions = readImageDimensions(header);
    if (dimensions) {
      longestEdge = Math.max(dimensions.width, dimensions.height);
    }
  } catch {
    return undefined;
  }
  if (longestEdge === 0 || longestEdge >= PREPROCESS_MIN_EDGE) return undefined;

  const target = Math.min(
    PREPROCESS_TARGET_EDGE,
    Math.round(longestEdge * PREPROCESS_MAX_SCALE),
  );
  const destination = join(workDir, "upscaled.png");

  if (await commandAvailable("magick")) {
    const result = await spawnArgv({
      command: "magick",
      argv: [
        `${source}[0]`,
        "-colorspace",
        "Gray",
        "-filter",
        "Lanczos",
        "-resize",
        `${target}x${target}`,
        "-normalize",
        "-sharpen",
        "0x1",
        destination,
      ],
      timeoutMs,
      signal,
      noArtifact: true,
      maxModelBytes: 4_000,
    });
    if (result.ok && (await fileHasBytes(destination))) return destination;
  }

  if (platform() === "darwin" && (await commandAvailable("sips"))) {
    const result = await spawnArgv({
      command: "sips",
      argv: [
        "-s",
        "format",
        "png",
        "-Z",
        String(target),
        source,
        "--out",
        destination,
      ],
      timeoutMs,
      signal,
      noArtifact: true,
      maxModelBytes: 4_000,
    });
    if (result.ok && (await fileHasBytes(destination))) return destination;
  }

  return undefined;
}

async function fileHasBytes(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function runOcr(request: OcrRequest): Promise<OcrResult> {
  const fail = (error: string): OcrResult => ({
    ok: false,
    text: "",
    psm: -1,
    preprocessed: false,
    confidence: 0,
    reliable: false,
    error,
  });
  const unavailable = await tesseractUnavailableReason();
  if (unavailable) return fail(unavailable);
  const languageIssue = await languageUnavailableReason(request.lang);
  if (languageIssue) return fail(languageIssue);

  const candidates =
    request.psmCandidates.length > 0 ? [...request.psmCandidates] : [3];
  let workDir: string | undefined;
  let input = request.path;
  let preprocessed = false;
  try {
    if (request.preprocess !== false) {
      workDir = await mkdtemp(join(tmpdir(), "clai-ocrpre-"));
      const upscaled = await preprocessForOcr(
        request.path,
        workDir,
        Math.min(request.timeoutMs, 30_000),
        request.signal,
      );
      if (upscaled) {
        input = upscaled;
        preprocessed = true;
      }
    }

    if (!workDir) workDir = await mkdtemp(join(tmpdir(), "clai-ocr-"));
    let best: OcrResult | undefined;
    let lastError: string | undefined;
    for (const [attempt, psm] of candidates.entries()) {
      if (request.signal?.aborted) break;
      const base = join(workDir, `pass-${attempt}`);
      const argv = [input, base, "-l", request.lang, "--psm", String(psm)];
      if (request.dpi) argv.push("--dpi", String(request.dpi));
      argv.push("-c", "preserve_interword_spaces=1", "txt", "tsv");
      const result = await spawnArgv({
        command: "tesseract",
        argv,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        onOutput: request.onOutput,
        noArtifact: true,
        maxModelBytes: 8_000,
      });
      if (!result.ok) {
        lastError =
          stripCommandEcho(result.output).trim() ||
          `tesseract exited with code ${result.exitCode ?? 1}`;
        continue;
      }
      const text = (await readTextFile(`${base}.txt`))
        .replace(/^Estimating resolution as \d+\s*$/gim, "")
        .replace(/^Warning[^\n]*$/gim, "")
        .replace(/\f/g, "")
        .trimEnd();
      const words = parseTsvWords(await readTextFile(`${base}.tsv`));
      const confidence = meanConfidence(words);
      const reliable =
        words.length > 0 &&
        confidence >= MIN_RELIABLE_CONFIDENCE &&
        looksLikeRealText(words);
      const candidate: OcrResult = {
        ok: true,
        text: text.trim(),
        psm,
        preprocessed,
        confidence: Math.round(confidence),
        reliable,
      };
      if (!best || isBetterOcr(candidate, best)) best = candidate;
      if (reliable && scoreOcrText(candidate.text) >= GOOD_ENOUGH_SCORE) break;
    }

    if (best) return best;
    return {
      ok: false,
      text: "",
      psm: candidates[0] ?? 3,
      preprocessed,
      confidence: 0,
      reliable: false,
      error: lastError ?? "tesseract produced no output",
    };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isBetterOcr(candidate: OcrResult, current: OcrResult): boolean {
  if (candidate.reliable !== current.reliable) return candidate.reliable;
  return scoreOcrText(candidate.text) > scoreOcrText(current.text);
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
