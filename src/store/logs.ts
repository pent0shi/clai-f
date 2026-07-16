import { mkdir, readdir, rename, stat, appendFile, readFile, writeFile, rm, chown } from 'node:fs/promises';
import { fixOwner, handlePermissionError } from '../os/permissions.js';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../llm/provider.js';
import { getArtifactDir, getLogsDirRoot } from './paths.js';

const logsDir = getLogsDirRoot();
const maxLogBytes = 10 * 1024 * 1024;

function today(): string {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

export function getLogPath(): string {
  return join(logsDir, `clai-${today()}.log`);
}

async function rotateIfNeeded(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const info = await stat(path);
  if (info.size < maxLogBytes) return;
  const siblings = await readdir(logsDir).catch(() => []);
  const count = siblings.filter((name) => name.startsWith(`clai-${today()}.log.`)).length + 1;
  const newPath = `${path}.${count}`;
  await rename(path, newPath);
  await fixOwner(newPath);
}

export async function auditLog(event: string, payload: unknown = {}): Promise<void> {
  try {
    await mkdir(logsDir, { recursive: true });
    await fixOwner(logsDir);
    const path = getLogPath();
    await rotateIfNeeded(path);
    const entry = redactSecrets(JSON.stringify({ at: new Date().toISOString(), event, payload }));
    await appendFile(path, `${entry}\n`, 'utf8');
    await fixOwner(path);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export async function clearAuditLogs(): Promise<{ removed: number }> {
  if (!existsSync(logsDir)) return { removed: 0 };
  const entries = await readdir(logsDir).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith('clai-')) continue;
    try {
      await rm(join(logsDir, entry), { force: true });
      removed += 1;
    } catch {
      // best-effort: keep going
    }
  }
  return { removed };
}

export function getLogsDir(): string {
  return logsDir;
}

export async function clearArtifacts(): Promise<{ removed: number }> {
  const dir = getArtifactDir();
  if (!existsSync(dir)) return { removed: 0 };
  const entries = await readdir(dir).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    try {
      await rm(join(dir, entry), { force: true, recursive: true });
      removed += 1;
    } catch {
      // best-effort
    }
  }
  return { removed };
}

const diagnosticKeyAllowed = (key: string): boolean =>
  /(?:id|ids|status|state|reason|level|phase|capability|allowed|ok|exitCode|signal|bytes|count|duration|freshness|revision|version)$/i.test(key);

function diagnosticMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(diagnosticMetadata);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (diagnosticKeyAllowed(key)) output[key] = diagnosticMetadata(child);
  }
  return output;
}

/** Export local, metadata-only diagnostics. User prompts, project code, commands, and tool output are excluded by default. */
export async function exportDiagnostics(destination: string): Promise<{ path: string; events: number }> {
  const entries = (await readdir(logsDir).catch(() => []))
    .filter((name) => name.startsWith("clai-") && name.includes(".log"))
    .sort()
    .slice(-5);
  const events: Array<{ at?: string; event?: string; payload?: unknown }> = [];
  for (const entry of entries) {
    const text = await readFile(join(logsDir, entry), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { at?: string; event?: string; payload?: unknown };
        const row: { at?: string; event?: string; payload?: unknown } = {};
        if (typeof parsed.at === "string") row.at = parsed.at;
        if (typeof parsed.event === "string") row.event = parsed.event;
        if (parsed.payload !== undefined) row.payload = diagnosticMetadata(parsed.payload);
        events.push(row);
      } catch { /* Ignore partial/corrupt log lines. */ }
    }
  }
  const report = redactSecrets(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    privacy: "metadata-only; prompts, code, commands, secrets, and tool output omitted",
    events: events.slice(-10_000),
  }, null, 2));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${report}\n`, { mode: 0o600 });
  return { path: destination, events: Math.min(events.length, 10_000) };
}
