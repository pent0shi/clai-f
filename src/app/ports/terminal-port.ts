export type ColorMode = "truecolor" | "256" | "16" | "none";


export interface TerminalCapabilities {
  readonly columns: number;
  readonly rows: number;
  readonly colorMode: ColorMode;
  readonly isTTY: boolean;
  readonly canDistinguishShiftEnter: boolean;
  readonly supportsOsc52: boolean;
}

export interface TerminalPort {
  capabilities(): TerminalCapabilities;
}
