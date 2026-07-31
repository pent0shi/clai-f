import { renderMarkdown } from "../src/ui/markdown.js";
const md = [
  "Here is code:",
  "",
  "```ts",
  "function greet(name: string) {",
  "    if (name) {",
  "        return `hello ${name}`;   // greeting",
  "    }",
  "",
  "    return null;",
  "}",
  "```",
  "",
  "done",
].join("\n");
const out = renderMarkdown(md, 60);
console.log(out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => "[" + l + "]").join("\n"));
