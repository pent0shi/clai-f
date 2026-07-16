import { printResult, type SpikeResult } from "./harness.js";
import { runViewportCullingSpike } from "./viewport-culling.spike.js";
import { runStreamingMarkdownSpike } from "./streaming-markdown.spike.js";
import { runShellRenderSpike } from "./shell-render.spike.js";

// Deterministic headless OpenTUI gates. Interactive selection/autoscroll spikes
// remain manual because OpenTUI's headless renderer intentionally has no live
// mouse/render loop; treating those experiments as CI tests creates false failures.
const checks: Array<() => Promise<SpikeResult>> = [
  runViewportCullingSpike,
  runStreamingMarkdownSpike,
  runShellRenderSpike,
];

const results: SpikeResult[] = [];
for (const run of checks) {
  try {
    const result = await run();
    results.push(result);
    printResult(result);
  } catch (error) {
    results.push({
      id: run.name,
      title: "OpenTUI smoke threw",
      passed: false,
      checks: [{ label: error instanceof Error ? error.message : String(error), ok: false }],
      measurements: {},
      notes: [],
    });
  }
}

const passed = results.filter((result) => result.passed).length;
console.log(`\n==== OpenTUI CI smoke: ${passed}/${results.length} passed ====`);
process.exitCode = passed === results.length ? 0 : 1;
