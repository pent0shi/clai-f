import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { safeCwd } from "../os/cwd.js";
import { scratchDirFor } from "../prompts/index.js";
import {
  detectModelImageMediaType,
  formatByteSize,
} from "./image-content.js";

export type ClipboardImageCapture =
  | {
      readonly ok: true;
      readonly path: string;
      readonly mediaType: "image/png";
      readonly byteLength: number;
    }
  | { readonly ok: false; readonly reason: string };

const CAPTURE_TIMEOUT_MS = 4_000;
const MAX_CAPTURE_BYTES = 67_108_864;
const MAX_CAPTURE_BUFFER = MAX_CAPTURE_BYTES + 1;

function captureCommand(command: string, args: string[]): Buffer | undefined {
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: MAX_CAPTURE_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: CAPTURE_TIMEOUT_MS,
  });
  if (
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length === 0
  ) {
    return undefined;
  }
  return result.stdout;
}

function captureLinuxPng(): Buffer | undefined {
  const attempts: Array<[string, string[]]> = [
    ["wl-paste", ["--no-newline", "--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [command, args] of attempts) {
    const bytes = captureCommand(command, args);
    if (bytes && detectModelImageMediaType(bytes) === "image/png") return bytes;
  }
  return undefined;
}

function writeMacClipboardFormat(
  destination: string,
  clipboardClass: "PNGf" | "TIFF",
): boolean {
  const script = [
    "on run argv",
    "set destinationPath to item 1 of argv",
    "try",
    `set imageData to the clipboard as «class ${clipboardClass}»`,
    "on error",
    "return \"NO_IMAGE\"",
    "end try",
    "set destinationFile to open for access POSIX file destinationPath with write permission",
    "try",
    "set eof destinationFile to 0",
    "write imageData to destinationFile",
    "close access destinationFile",
    "on error errorMessage",
    "try",
    "close access destinationFile",
    "end try",
    "error errorMessage",
    "end try",
    "return destinationPath",
    "end run",
  ].join("\n");
  try {
    const output = execFileSync("osascript", ["-e", script, destination], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CAPTURE_TIMEOUT_MS,
    }).trim();
    return output !== "NO_IMAGE" && existsSync(destination);
  } catch {
    return false;
  }
}

function captureMacPng(destination: string): boolean {
  if (writeMacClipboardFormat(destination, "PNGf")) return true;
  const tiffPath = `${destination}.tiff`;
  if (!writeMacClipboardFormat(tiffPath, "TIFF")) return false;
  try {
    execFileSync(
      "sips",
      ["-s", "format", "png", tiffPath, "--out", destination],
      {
        stdio: "ignore",
        timeout: CAPTURE_TIMEOUT_MS,
      },
    );
    return existsSync(destination);
  } catch {
    return false;
  } finally {
    rmSync(tiffPath, { force: true });
  }
}

function captureWindowsPng(destination: string): boolean {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$image = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $image) { exit 3 }",
    "$image.Save($env:CLAI_CLIPBOARD_IMAGE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)",
    "$image.Dispose()",
  ].join("; ");
  for (const command of ["powershell.exe", "pwsh.exe", "pwsh"]) {
    const result = spawnSync(
      command,
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, CLAI_CLIPBOARD_IMAGE_PATH: destination },
        stdio: ["ignore", "ignore", "ignore"],
        timeout: CAPTURE_TIMEOUT_MS,
      },
    );
    if (result.status === 0 && existsSync(destination)) return true;
  }
  return false;
}

function validateCapturedPng(destination: string): ClipboardImageCapture {
  try {
    const stat = statSync(destination);
    if (stat.size === 0) {
      return { ok: false, reason: "The clipboard does not contain an image." };
    }
    if (stat.size > MAX_CAPTURE_BYTES) {
      return {
        ok: false,
        reason: `Clipboard image is ${formatByteSize(stat.size)}, above the ${formatByteSize(MAX_CAPTURE_BYTES)} capture ceiling.`,
      };
    }
    const bytes = readFileSync(destination);
    if (detectModelImageMediaType(bytes) !== "image/png") {
      return {
        ok: false,
        reason: "Clipboard image could not be converted to PNG.",
      };
    }
    return {
      ok: true,
      path: destination,
      mediaType: "image/png",
      byteLength: stat.size,
    };
  } catch {
    return { ok: false, reason: "Clipboard image could not be read." };
  }
}

export function captureClipboardImage(
  baseDir: string = safeCwd(),
): ClipboardImageCapture {
  const attachmentDir = join(scratchDirFor(baseDir), "attachments");
  const destination = join(
    attachmentDir,
    `clipboard-${Date.now()}-${randomUUID().slice(0, 8)}.png`,
  );
  try {
    mkdirSync(attachmentDir, { recursive: true });
  } catch {
    return { ok: false, reason: "Could not create the attachment directory." };
  }

  let captured = false;
  const os = platform();
  if (os === "darwin") {
    captured = captureMacPng(destination);
  } else if (os === "linux") {
    const bytes = captureLinuxPng();
    if (bytes) {
      try {
        writeFileSync(destination, bytes, { mode: 0o600 });
        captured = true;
      } catch {
        captured = false;
      }
    }
  } else if (os === "win32") {
    captured = captureWindowsPng(destination);
  }

  if (!captured) {
    rmSync(destination, { force: true });
    return {
      ok: false,
      reason:
        os === "linux"
          ? "Clipboard has no PNG image, or wl-paste/xclip is unavailable."
          : os === "darwin" || os === "win32"
            ? "The clipboard does not contain a supported image."
            : `Image clipboard paste is not supported on ${os}.`,
    };
  }

  const result = validateCapturedPng(destination);
  if (!result.ok) rmSync(destination, { force: true });
  return result;
}
