import { renderMarkdown } from "../src/ui/markdown.js";
const md = [
  "```ts",
  "        const message = someHelper(alpha, beta) + otherHelper(gamma, delta) + tail;",
  "```",
].join("\n");
console.log(renderMarkdown(md, 50).replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => "[" + l + "]").join("\n"));
