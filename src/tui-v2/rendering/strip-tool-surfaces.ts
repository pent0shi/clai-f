/**
 * Remove tool-call surfaces from assistant display text so the TUI never
 * flashes raw ```tool JSON (or XML tool_call blocks) before tool cards appear.
 *
 * Safe for streaming: incomplete trailing fences are stripped from the cursor
 * to end-of-string so mid-fence tokens never paint.
 */

const COMPLETE_TOOL_FENCE =
  /```(?:tool|json\s*tool)\b[^\n]*\n[\s\S]*?```/gi;
const TRAILING_TOOL_FENCE = /```(?:tool|json\s*tool)\b[\s\S]*$/i;
const COMPLETE_TOOL_XML = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi;
const TRAILING_TOOL_XML = /<tool_call\b[^>]*>[\s\S]*$/i;
const COMPLETE_TOOL_DSML =
  /<[|｜]+DSML[|｜]+tool_calls\b[^>]*>[\s\S]*?<\/[|｜]+DSML[|｜]+tool_calls>/gi;
const COMPLETE_TOOL_DSML_INVOKE =
  /<[|｜]+DSML[|｜]+invoke\b[^>]*>[\s\S]*?<\/[|｜]+DSML[|｜]+invoke>/gi;
const COMPLETE_TOOL_DSML_PARAMETER =
  /<[|｜]+DSML[|｜]+parameter\b[^>]*>[\s\S]*?<\/[|｜]+DSML[|｜]+parameter>/gi;
const TRAILING_TOOL_DSML =
  /<[|｜]+DSML[|｜]+(?:tool_calls|invoke|parameter)\b[\s\S]*$/i;
const STRAY_TOOL_DSML = /<\/?[|｜]+DSML[|｜]+[A-Za-z0-9_]*\b[^>]*>/gi;
/** Kimi / sentinel-style blocks sometimes leak as prose. */
const COMPLETE_TOOL_SENTINEL =
  /(?:^|\n)\s*(?:tool_call|invoke_tool)\s*\([\s\S]*?\)\s*(?=\n|$)/gi;

export function stripToolCallSurfaces(text: string): string {
  if (!text) return text;
  let s = text;
  s = s.replace(COMPLETE_TOOL_FENCE, "");
  s = s.replace(TRAILING_TOOL_FENCE, "");
  s = s.replace(COMPLETE_TOOL_XML, "");
  s = s.replace(TRAILING_TOOL_XML, "");
  s = s.replace(COMPLETE_TOOL_DSML, "");
  s = s.replace(COMPLETE_TOOL_DSML_INVOKE, "");
  s = s.replace(COMPLETE_TOOL_DSML_PARAMETER, "");
  s = s.replace(TRAILING_TOOL_DSML, "");
  s = s.replace(STRAY_TOOL_DSML, "");
  s = s.replace(COMPLETE_TOOL_SENTINEL, "\n");
  // Collapse leftover blank runs from removed fences.
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s;
}

/** True when stripping leaves nothing meaningful for a Response card. */
export function isToolFenceOnlyText(text: string): boolean {
  return stripToolCallSurfaces(text).trim().length === 0;
}
