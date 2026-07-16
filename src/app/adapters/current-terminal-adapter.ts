import type {
  ColorMode,
  TerminalCapabilities,
  TerminalPort,
} from "../ports/terminal-port.js";

function detectColorMode(): ColorMode {
  if (process.env.NO_COLOR !== undefined) return "none";
  if (/truecolor|24bit/i.test(process.env.COLORTERM ?? "")) return "truecolor";
  if (/256/.test(process.env.TERM ?? "")) return "256";
  return process.stdout.isTTY ? "16" : "none";
}


export function createCurrentTerminalPort(): TerminalPort {
  return {
    capabilities(): TerminalCapabilities {
      return {
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        colorMode: detectColorMode(),
        isTTY: Boolean(process.stdout.isTTY),
        canDistinguishShiftEnter: false,
        supportsOsc52: true,
      };
    },
  };
}
