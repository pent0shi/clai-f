import { describe, expect, it } from "vitest";
import { parseLegacyFlags } from "../../src/tools/validate.js";
import { toolRegistry } from "../../src/tools/registry.js";

const DANGEROUS = [
  "-oN /etc/crontab",
  "-oN=/etc/crontab",
  "-oA loot",
  "-oX out.xml",
  "-oG out.grep",
  "-oS out",
  "--append-output",
  "--stylesheet http://evil/x.xsl",
  "--webxml",
  "-iL /etc/passwd",
  "-iL=/etc/passwd",
  "-iR 1000",
  "--resume out",
  "--datadir /tmp/evil",
  "--servicedb /tmp/evil",
  "--versiondb /tmp/evil",
  "--script=/tmp/evil.nse",
  "--script ../../evil",
  "--script all,*",
  "--script-args httpput.file=/tmp/x",
  "--script-help all",
  "--interactive",
];

describe("SEC-004 net.scan legacy flags are name-validated", () => {
  it("rejects output, input, script, and datadir flags in both forms", () => {
    for (const flags of DANGEROUS) {
      expect(() => parseLegacyFlags(flags)).toThrow();
    }
  });

  it("accepts documented scan flags", () => {
    expect(parseLegacyFlags("-sV -Pn -T4 --top-ports 100")).toEqual([
      "-sV",
      "-Pn",
      "-T4",
      "--top-ports",
      "100",
    ]);
    expect(parseLegacyFlags("--max-retries=2 -p 22,80")).toEqual([
      "--max-retries",
      "2",
      "-p",
      "22,80",
    ]);
  });

  it("rejects bare positional tokens and metacharacters", () => {
    expect(() => parseLegacyFlags("10.0.0.1")).toThrow();
    expect(() => parseLegacyFlags("`id`")).toThrow();
    expect(() => parseLegacyFlags("-sV; rm -rf /")).toThrow();
  });

  it("fails net.scan before spawning or escalating privilege", async () => {
    await expect(
      toolRegistry["net.scan"]!({
        target: "scanme.example.com",
        flags: "-oN /etc/crontab",
      }),
    ).rejects.toThrow(/Rejected nmap flag/i);
  });

  it("keeps safe NSE script names working through the legacy path", () => {
    expect(parseLegacyFlags("--script=banner")).toEqual(["--script=banner"]);
    expect(parseLegacyFlags("--script default,safe")).toEqual([
      "--script",
      "default,safe",
    ]);
  });
});
