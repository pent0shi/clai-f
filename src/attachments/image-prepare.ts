import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { platform } from "node:os";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { findExecutableSync } from "../os/command.js";
import { safeCwd } from "../os/cwd.js";
import { scratchDirFor } from "../prompts/index.js";
import {
  detectConvertibleImageFormat,
  detectModelImageMediaType,
  formatByteSize,
  imageBudgetFor,
  readImageDimensions,
  type ImageBudget,
  type ImageDimensions,
  type ModelImageMediaType,
} from "./image-content.js";

export { imageBudgetFor };
export type { ImageBudget };

const HEADER_PROBE_BYTES = 262_144;
const ABSOLUTE_MAX_SOURCE_BYTES = 268_435_456;
const MIN_TARGET_DIMENSION = 320;
const TRANSCODE_TIMEOUT_MS = 30_000;

export interface PreparedImage {
  readonly ok: true;
  readonly path: string;
  readonly sourcePath: string;
  readonly mediaType: ModelImageMediaType;
  readonly byteLength: number;
  readonly dimensions?: ImageDimensions | undefined;
  readonly transcoded: boolean;
  readonly resized?: boolean | undefined;
}

export interface RejectedImage {
  readonly ok: false;
  readonly sourcePath: string;
  readonly reason: string;
  readonly recoverable: boolean;
}

export type ImagePreparation = PreparedImage | RejectedImage;

interface ImageProbe {
  readonly byteLength: number;
  readonly mediaType: ModelImageMediaType | undefined;
  readonly format: ReturnType<typeof detectConvertibleImageFormat>;
  readonly dimensions: ImageDimensions | undefined;
}

function readHead(path: string, length: number): Buffer {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(handle);
  }
}

function probeImage(path: string, byteLength: number): ImageProbe {
  const head = readHead(path, Math.min(byteLength, HEADER_PROBE_BYTES));
  return {
    byteLength,
    mediaType: detectModelImageMediaType(head),
    format: detectConvertibleImageFormat(head),
    dimensions: readImageDimensions(head),
  };
}

interface Transcoder {
  readonly id: string;
  readonly available: () => boolean;
  readonly run: (
    source: string,
    destination: string,
    target: TranscodeTarget,
  ) => boolean;
}

interface TranscodeTarget {
  readonly format: "png" | "jpeg";
  readonly maxDimension: number;
  readonly quality: number;
  readonly shrinks: boolean;
}

function resolveBinary(command: string): string | undefined {
  return findExecutableSync(command);
}

function hasBinary(command: string): boolean {
  return resolveBinary(command) !== undefined;
}

function runQuiet(command: string, argv: string[]): boolean {
  const executable = resolveBinary(command);
  if (!executable) return false;
  const result = spawnSync(executable, argv, {
    stdio: "ignore",
    timeout: TRANSCODE_TIMEOUT_MS,
  });
  return result.status === 0 && !result.error;
}

const transcoders: Transcoder[] = [
  {
    id: "magick",
    available: () => hasBinary("magick"),
    run: (source, destination, target) =>
      runQuiet("magick", magickArgv(source, destination, target)),
  },
  {
    id: "convert",
    available: () => platform() !== "win32" && hasBinary("convert"),
    run: (source, destination, target) =>
      runQuiet("convert", magickArgv(source, destination, target)),
  },
  {
    id: "sips",
    available: () => platform() === "darwin" && hasBinary("sips"),
    run: (source, destination, target) => {
      const argv = ["-s", "format", target.format === "png" ? "png" : "jpeg"];
      if (target.format === "jpeg") {
        argv.push("-s", "formatOptions", String(target.quality));
      }
      if (target.shrinks) argv.push("-Z", String(target.maxDimension));
      argv.push(source, "--out", destination);
      return runQuiet("sips", argv);
    },
  },
  {
    id: "ffmpeg",
    available: () => hasBinary("ffmpeg"),
    run: (source, destination, target) => {
      if (target.format !== "png") return false;
      return runQuiet("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-i",
        source,
        "-vf",
        `scale=w=min(iw\\,${target.maxDimension}):h=min(ih\\,${target.maxDimension}):force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1",
        destination,
      ]);
    },
  },
];

function magickArgv(
  source: string,
  destination: string,
  target: TranscodeTarget,
): string[] {
  const argv = [`${source}[0]`, "-auto-orient", "-strip"];
  if (target.shrinks) {
    argv.push("-resize", `${target.maxDimension}x${target.maxDimension}>`);
  }
  if (target.format === "jpeg") {
    argv.push("-background", "white", "-alpha", "remove", "-alpha", "off");
    argv.push("-quality", String(target.quality));
  } else {
    argv.push("-define", "png:compression-level=9");
  }
  argv.push(destination);
  return argv;
}

function externalDimensions(path: string): ImageDimensions | undefined {
  const parse = (stdout: string): ImageDimensions | undefined => {
    const width = /pixelWidth:\s*(\d+)/.exec(stdout)?.[1];
    const height = /pixelHeight:\s*(\d+)/.exec(stdout)?.[1];
    if (width && height) {
      return { width: Number(width), height: Number(height) };
    }
    const pair = /^(\d+)\s+(\d+)/.exec(stdout.trim());
    return pair ? { width: Number(pair[1]), height: Number(pair[2]) } : undefined;
  };
  const attempts: Array<[string, string[]]> = [];
  if (hasBinary("magick")) {
    attempts.push(["magick", ["identify", "-format", "%w %h", `${path}[0]`]]);
  }
  if (platform() !== "win32" && hasBinary("identify")) {
    attempts.push(["identify", ["-format", "%w %h", `${path}[0]`]]);
  }
  if (platform() === "darwin" && hasBinary("sips")) {
    attempts.push(["sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]]);
  }
  for (const [command, argv] of attempts) {
    const executable = resolveBinary(command);
    if (!executable) continue;
    const result = spawnSync(executable, argv, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || typeof result.stdout !== "string") continue;
    const dimensions = parse(result.stdout);
    if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
      return dimensions;
    }
  }
  return undefined;
}

function availableTranscoders(): Transcoder[] {
  return transcoders.filter((transcoder) => transcoder.available());
}

export function hasImageTranscoder(): boolean {
  return availableTranscoders().length > 0;
}

export function imageTranscoderHint(): string {
  return platform() === "darwin"
    ? "install ImageMagick (brew install imagemagick) or resize it with sips"
    : platform() === "win32"
      ? "install ImageMagick (scoop install imagemagick) and retry"
      : "install ImageMagick (apt install imagemagick / dnf install ImageMagick) and retry";
}

function scale(dimension: number, factor: number): number {
  return Math.max(MIN_TARGET_DIMENSION, Math.round(dimension * factor));
}

function ladderFor(budget: ImageBudget, probe: ImageProbe): TranscodeTarget[] {
  const longestEdge = probe.dimensions
    ? Math.max(probe.dimensions.width, probe.dimensions.height)
    : undefined;
  const base =
    longestEdge === undefined
      ? budget.maxDimension
      : Math.max(
          MIN_TARGET_DIMENSION,
          Math.min(budget.maxDimension, longestEdge),
        );
  const photographic =
    probe.format === "image/jpeg" ||
    probe.format === "image/heic" ||
    probe.format === "image/avif";
  const dimensions = photographic
    ? [base, scale(base, 0.75), scale(base, 0.5), 1280, 1024, 800]
    : [base, base, base, scale(base, 0.75), scale(base, 0.75), 1280, 1024, 800];
  const plan: Array<[TranscodeTarget["format"], number, number]> = photographic
    ? [
        ["jpeg", dimensions[0]!, 88],
        ["jpeg", dimensions[1]!, 84],
        ["jpeg", dimensions[2]!, 78],
      ]
    : [
        ["png", dimensions[0]!, 100],
        ["jpeg", dimensions[1]!, 92],
        ["jpeg", dimensions[2]!, 80],
        ["png", dimensions[3]!, 100],
        ["jpeg", dimensions[4]!, 85],
      ];
  plan.push(
    ["jpeg", Math.min(base, 1280), 78],
    ["jpeg", Math.min(base, 1024), 70],
    ["jpeg", Math.min(base, 800), 58],
  );
  const seen = new Set<string>();
  const targets: TranscodeTarget[] = [];
  for (const [format, maxDimension, quality] of plan) {
    const key = `${format}:${maxDimension}:${quality}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      format,
      maxDimension,
      quality,
      shrinks: longestEdge === undefined || longestEdge > maxDimension,
    });
  }
  return targets;
}

function fittedDirectory(baseDir: string): string {
  const directory = join(scratchDirFor(baseDir), "attachments", "fitted");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function stemFor(path: string): string {
  const extension = extname(path);
  const stem = basename(path, extension)
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 60);
  return stem || "image";
}

function transcodeToBudget(
  source: string,
  probe: ImageProbe,
  budget: ImageBudget,
  baseDir: string,
): PreparedImage | undefined {
  const tools = availableTranscoders();
  if (tools.length === 0) return undefined;
  const directory = fittedDirectory(baseDir);
  const fingerprint = createHash("sha1")
    .update(`${source}|${probe.byteLength}|${budget.maxBytes}|${budget.maxDimension}`)
    .digest("hex")
    .slice(0, 12);
  const stem = stemFor(source);
  let best: PreparedImage | undefined;
  for (const target of ladderFor(budget, probe)) {
    const extension = target.format === "png" ? "png" : "jpg";
    const destination = join(
      directory,
      `${fingerprint}-${target.maxDimension}q${target.quality}-${stem}.${extension}`,
    );
    for (const tool of tools) {
      rmSync(destination, { force: true });
      if (!tool.run(source, destination, target)) continue;
      let byteLength = 0;
      try {
        byteLength = statSync(destination).size;
      } catch {
        continue;
      }
      if (byteLength === 0) {
        rmSync(destination, { force: true });
        continue;
      }
      const head = readHead(destination, Math.min(byteLength, HEADER_PROBE_BYTES));
      const mediaType = detectModelImageMediaType(head);
      if (!mediaType) {
        rmSync(destination, { force: true });
        continue;
      }
      const dimensions = readImageDimensions(head);
      const sourceEdge = probe.dimensions
        ? Math.max(probe.dimensions.width, probe.dimensions.height)
        : undefined;
      const outputEdge = dimensions
        ? Math.max(dimensions.width, dimensions.height)
        : undefined;
      const candidate: PreparedImage = {
        ok: true,
        path: destination,
        sourcePath: source,
        mediaType,
        byteLength,
        dimensions,
        transcoded: true,
        resized:
          sourceEdge === undefined ||
          outputEdge === undefined ||
          outputEdge < sourceEdge,
      };
      if (byteLength <= budget.maxBytes) return candidate;
      if (!best || byteLength < best.byteLength) best = candidate;
      break;
    }
  }
  if (best && best.byteLength <= budget.hardMaxBytes) return best;
  return undefined;
}

const preparationCache = new Map<string, ImagePreparation>();

function cacheKey(
  path: string,
  mtimeMs: number,
  size: number,
  budget: ImageBudget,
): string {
  return `${path}|${Math.round(mtimeMs)}|${size}|${budget.maxBytes}|${budget.hardMaxBytes}|${budget.maxDimension}`;
}

export function clearImagePreparationCache(): void {
  preparationCache.clear();
}

function reject(
  sourcePath: string,
  reason: string,
  recoverable = false,
): RejectedImage {
  return { ok: false, sourcePath, reason, recoverable };
}

export function prepareImageForModel(
  sourcePath: string,
  budget: ImageBudget,
  baseDir: string = safeCwd(),
): ImagePreparation {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(sourcePath);
  } catch (error) {
    return reject(
      sourcePath,
      `could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!info.isFile()) return reject(sourcePath, "is not a regular file");
  if (info.size === 0) return reject(sourcePath, "is empty (0 bytes)");
  if (info.size > ABSOLUTE_MAX_SOURCE_BYTES) {
    return reject(
      sourcePath,
      `is ${formatByteSize(info.size)}, far beyond any model image limit`,
    );
  }

  const key = cacheKey(sourcePath, info.mtimeMs, info.size, budget);
  const cached = preparationCache.get(key);
  if (cached && (!cached.ok || existsSync(cached.path))) return cached;

  const outcome = prepare(sourcePath, info.size, budget, baseDir);
  preparationCache.set(key, outcome);
  return outcome;
}

function prepare(
  sourcePath: string,
  size: number,
  budget: ImageBudget,
  baseDir: string,
): ImagePreparation {
  let probe: ImageProbe;
  try {
    probe = probeImage(sourcePath, size);
  } catch (error: unknown) {
    return reject(
      sourcePath,
      `could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const format = probe.format;
  if (!format) {
    return reject(
      sourcePath,
      "its bytes are not a supported image (expected PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC or AVIF)",
    );
  }

  if (
    !probe.dimensions &&
    (probe.mediaType === undefined || size > budget.maxBytes)
  ) {
    const external = externalDimensions(sourcePath);
    if (external) probe = { ...probe, dimensions: external };
  }

  const oversizedDimensions = probe.dimensions
    ? Math.max(probe.dimensions.width, probe.dimensions.height) >
      budget.maxDimension
    : false;
  const nativeAndFitting =
    probe.mediaType !== undefined &&
    size <= budget.maxBytes &&
    !oversizedDimensions;

  if (nativeAndFitting) {
    return {
      ok: true,
      path: sourcePath,
      sourcePath,
      mediaType: probe.mediaType!,
      byteLength: size,
      dimensions: probe.dimensions,
      transcoded: false,
    };
  }

  const fitted = transcodeToBudget(sourcePath, probe, budget, baseDir);
  if (fitted) return fitted;

  if (probe.mediaType && size <= budget.hardMaxBytes) {
    return {
      ok: true,
      path: sourcePath,
      sourcePath,
      mediaType: probe.mediaType,
      byteLength: size,
      dimensions: probe.dimensions,
      transcoded: false,
    };
  }

  if (!probe.mediaType) {
    return reject(
      sourcePath,
      `is ${format.replace("image/", "").toUpperCase()}, which models cannot read, and no converter is installed — ${imageTranscoderHint()}`,
      true,
    );
  }

  return reject(
    sourcePath,
    `is ${formatByteSize(size)}, above the ${formatByteSize(budget.hardMaxBytes)} per-image limit for ${budget.label} models` +
      (hasImageTranscoder()
        ? " and could not be downscaled far enough"
        : ` and no downscaler is installed — ${imageTranscoderHint()}`),
    true,
  );
}

export function describePreparedImage(prepared: PreparedImage): string {
  const size = formatByteSize(prepared.byteLength);
  const dimensions = prepared.dimensions
    ? `${prepared.dimensions.width}x${prepared.dimensions.height}`
    : "unknown size";
  const format = prepared.mediaType.replace("image/", "").toUpperCase();
  if (!prepared.transcoded) return `${dimensions} ${format} (${size})`;
  return prepared.resized
    ? `resized to ${dimensions} ${format} (${size}) to fit the model input limit`
    : `converted to ${dimensions} ${format} (${size}) so the model can read it`;
}
