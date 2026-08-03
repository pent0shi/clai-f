#!/usr/bin/env node
// Guard against a deleted / inaccessible working directory BEFORE importing
// anything from dist. If clai was launched (or elevated via `sudo`) from a
// folder that no longer exists, process.cwd() throws ENOENT (uv_cwd) and the
// whole CLI used to crash at module-load. Relocate to a directory that
// definitely exists so startup — and every later spawn — works.
try {
  process.cwd();
} catch {
  const candidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.TMPDIR,
    "/tmp",
    "/",
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      process.chdir(dir);
      break;
    } catch {
      // try the next candidate
    }
  }
}

try {
  await import('../dist/index.js');
} catch (err) {
  // Never exit silently — always print something so the user knows what happened.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nclai: failed to start: ${msg}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.stderr.write(
    '\nIf this persists, try:\n' +
    '  • Reinstall: npm i -g @pentoshi/clai\n' +
    '  • Classic mode: clai --classic\n' +
    '  • Report: https://github.com/pentoshi007/clai/issues\n'
  );
  process.exitCode = 1;
}
