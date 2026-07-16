import type { EngagementScope } from "../store/scope.js";
import { isScopeActive } from "../store/scope.js";

/** Compact engagement-scope block for pentest turns. */
export function scopeContextMessage(
  scope: EngagementScope | undefined,
): string | undefined {
  if (!scope || !isScopeActive(scope)) return undefined;
  const lines = ["ENGAGEMENT SCOPE (hard boundary for this session):"];
  if (scope.name?.trim()) lines.push(`name: ${scope.name.trim()}`);
  if (scope.authorizedTargets.length) {
    lines.push(`authorized: ${scope.authorizedTargets.join(", ")}`);
  }
  if (scope.excludedTargets?.length) {
    lines.push(`excluded: ${scope.excludedTargets.join(", ")}`);
  }
  if (scope.allowedPhases?.length) {
    lines.push(`phases: ${scope.allowedPhases.join(", ")}`);
  }
  if (scope.authorizationNote?.trim()) {
    lines.push(`note: ${scope.authorizationNote.trim()}`);
  }
  lines.push(
    "Do not scan or attack hosts outside authorized targets. Flag out-of-scope discoveries; do not act on them without explicit expansion.",
  );
  return lines.join("\n");
}
