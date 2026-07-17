import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  addScopeTargets,
  clearScope,
  loadScope,
  replaceScopeTargets,
  resetScopeCache,
} from "../src/store/scope.js";

describe("scope store replace", () => {
  beforeEach(async () => {
    resetScopeCache();
    await clearScope();
    resetScopeCache();
  });
  afterEach(async () => {
    resetScopeCache();
    await clearScope();
  });

  it("replaceScopeTargets keeps every target and full replace drops removed ones", async () => {
    const a = await replaceScopeTargets(["aa.example", "ss.example"]);
    expect(a?.authorizedTargets).toEqual(["aa.example", "ss.example"]);
    resetScopeCache();
    const loaded = await loadScope();
    expect(loaded?.authorizedTargets).toEqual(["aa.example", "ss.example"]);

    const b = await replaceScopeTargets(["aa.example"]);
    expect(b?.authorizedTargets).toEqual(["aa.example"]);
    resetScopeCache();
    expect((await loadScope())?.authorizedTargets).toEqual(["aa.example"]);
  });

  it("addScopeTargets merges without dropping prior entries", async () => {
    await replaceScopeTargets(["aa.example"]);
    await addScopeTargets(["ss.example"]);
    resetScopeCache();
    expect((await loadScope())?.authorizedTargets.sort()).toEqual(
      ["aa.example", "ss.example"].sort(),
    );
  });
});
