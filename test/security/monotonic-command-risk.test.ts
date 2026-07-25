import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyShellCommand } from "../../src/safety/classifier.js";
import { networkScanTools } from "../../src/safety/patterns.js";

const ORDER = { safe: 0, confirm: 1, block: 2 } as const;

function level(command: string): number {
  return ORDER[classifyShellCommand(command).level];
}

const MUTATORS = [
  "rm -rf build",
  "cp a b",
  "mv a b",
  "chmod 777 secret.key",
  "npm install lodash",
  "apt-get install -y netcat",
  "tee /etc/hosts",
  "sed -i s/a/b/ file.txt",
  "find . -delete",
  "git push origin main",
];

describe("SEC-003 scanner tokens never lower command risk", () => {
  it("keeps compound mutating commands out of the safe bucket", () => {
    for (const mutator of MUTATORS) {
      for (const scanner of networkScanTools) {
        const withScanner = `${scanner} -p 80 10.0.0.1 && ${mutator}`;
        expect(level(withScanner)).toBeGreaterThanOrEqual(level(mutator));
        expect(classifyShellCommand(withScanner).level).not.toBe("safe");

        const piped = `${scanner} -p 80 10.0.0.1 | ${mutator}`;
        expect(classifyShellCommand(piped).level).not.toBe("safe");

        const prefixed = `${mutator}; ${scanner} 10.0.0.1`;
        expect(classifyShellCommand(prefixed).level).not.toBe("safe");
      }
    }
  });

  it("confirms scanner output redirected into a sensitive path", () => {
    expect(classifyShellCommand("nmap -oN /etc/hosts 10.0.0.1").level).toBe(
      "confirm",
    );
    expect(classifyShellCommand("nmap 10.0.0.1 > /etc/crontab").level).toBe(
      "confirm",
    );
  });

  it("still auto-runs ordinary scanner invocations and read-only pipelines", () => {
    expect(classifyShellCommand("nmap -sV -p- 10.0.0.5").level).toBe("safe");
    expect(classifyShellCommand("nmap -p 80 10.0.0.5 | grep open").level).toBe(
      "safe",
    );
    expect(
      classifyShellCommand("ffuf -u https://example.com/FUZZ -w list.txt > out.json")
        .level,
    ).toBe("safe");
  });

  it("property: appending a segment never lowers the risk level", () => {
    const segment = fc.constantFrom(
      "nmap 10.0.0.1",
      "ls -la",
      "grep foo bar.txt",
      "rm -rf build",
      "npm install left-pad",
      "cat notes.md",
      "masscan -p80 10.0.0.0/8",
      "chmod 600 id_rsa",
    );
    fc.assert(
      fc.property(
        segment,
        segment,
        fc.constantFrom("&&", "||", ";", "|"),
        (first, second, joiner) => {
          const combined = `${first} ${joiner} ${second}`;
          expect(level(combined)).toBeGreaterThanOrEqual(
            Math.max(level(first), level(second)),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
