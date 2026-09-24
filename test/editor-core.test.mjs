// Pure helpers behind /routing edit: availability, layered nodes, the save
// engine, the builtin snapshot and project configs. No senpi, no LLM.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as r from "../extension/routing.ts"
import { BUILTIN, REGISTRY, RAW, MODELS } from "./editor-fixture.mjs"

const temp = t => {
  const dir = mkdtempSync(join(tmpdir(), "routing-editor-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const node = (nodes, key) => nodes.find(n => n.key === key)

test("renamed subscription providers keep the approved short labels; unknown providers stay verbatim", () => {
  const lines = r.buildReport({
    config: { categories: { x: { models: ["anthropic-subscription/claude-opus-5:high", "chatgpt-subscription/gpt-6-astra:max", "nvidia/nemo:low"] } } },
    profiles: [], builtin: { status: "unavailable", reason: "fixture" },
  })
  assert.ok(lines.some(line => line.includes("claude/claude-opus-5:H → codex/gpt-6-astra:X → nvidia/nemo:L")), lines.join("\n"))
})

test("splitSpec keeps model names that end like efforts and splits provider groups", () => {
  assert.deepEqual(r.splitSpec("devin/swe-2-high"), { providers: ["devin"], model: "swe-2-high" })
  assert.deepEqual(r.splitSpec("{a|b}/m:high"), { providers: ["a", "b"], model: "m", effort: "high" })
  assert.deepEqual(r.splitSpec("x/m:free"), { providers: ["x"], model: "m:free" })
  assert.equal(r.splitSpec("no-provider"), undefined)
})

test("rungView hides unconnected providers, narrows groups and flags unknown ids; no registry hides nothing", () => {
  const av = r.availabilityOf(REGISTRY)
  assert.deepEqual(av.providers, ["anthropic-subscription", "chatgpt-subscription", "devin"])
  assert.deepEqual(r.rungView("{chatgpt-subscription|openrouter}/gpt-mini:low", av), { visible: true, connected: ["chatgpt-subscription"], hidden: ["openrouter"], unknown: false })
  assert.equal(r.rungView("kimi/k3", av).visible, false)
  assert.equal(r.rungView("anthropic-subscription/claude-nope:high", av).unknown, true)
  for (const registry of [undefined, { getAvailable() { throw new Error("offline") } }, { getAvailable: () => "x" }]) {
    const unknown = r.availabilityOf(registry)
    assert.equal(unknown.known, false)
    assert.ok(unknown.reason)
    assert.deepEqual(r.rungView("kimi/k3", unknown), { visible: true, connected: ["kimi"], hidden: [], unknown: false })
  }
})

test("effortLevels: the host function wins, else the model metadata decides", async () => {
  const av = r.availabilityOf(REGISTRY)
  const opus = av.models.get("anthropic-subscription/claude-opus")
  assert.deepEqual(r.effortLevels(av.models.get("anthropic-subscription/claude-haiku")), ["off"])
  assert.deepEqual(r.effortLevels(opus), ["minimal", "low", "medium", "high", "xhigh", "max"])
  assert.deepEqual(r.effortLevels(av.models.get("chatgpt-subscription/gpt-mini")), ["minimal", "low", "medium", "high"])
  assert.deepEqual(r.effortLevels({ ...opus, source: { ...MODELS[1], thinkingLevelMap: { xhigh: null, max: "max" } } }), ["minimal", "low", "medium", "high", "max"])
  assert.deepEqual(r.effortLevels(opus, () => ["off", "high"]), ["off", "high"])
  assert.deepEqual(r.effortLevels(opus, () => { throw new Error("host") }), ["minimal", "low", "medium", "high", "xhigh", "max"])
  assert.deepEqual(r.effortLevels(undefined), ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
  // The installed OMO's own pi-ai (tests run inside omo, as the defaults tests do).
  const host = await r.hostThinkingLevels(process.env)
  assert.equal(typeof host, "function", "getSupportedThinkingLevels is importable from the installed OMO")
  assert.ok(host({ ...MODELS[1], api: "anthropic-messages" }).includes("high"))
  assert.equal(await r.hostThinkingLevels({}), undefined)
})

test("editorNodes: main, builtin and user-only nodes with each layer's own override", () => {
  const nodes = r.editorNodes({ raw: RAW, profile: "work", builtin: BUILTIN })
  assert.deepEqual(nodes.map(n => n.key), [
    "model_profiles:capable", "categories:deep", "categories:implementer", "categories:quick", "categories:writing",
    "agents:explore", "agents:reviewer",
  ])
  assert.equal(r.nodeState(node(nodes, "categories:deep"), "work"), "base")
  assert.equal(r.nodeState(node(nodes, "categories:deep")), "커스텀")
  assert.equal(r.nodeState(node(nodes, "categories:quick"), "work"), "비활성")
  assert.equal(r.nodeState(node(nodes, "categories:writing"), "work"), "빌트인")
  assert.equal(r.nodeState(node(nodes, "model_profiles:capable"), "work"), "빌트인")
  const implementer = node(nodes, "categories:implementer")
  assert.equal(implementer.userOnly, true)
  assert.equal(implementer.builtin, undefined)
  assert.equal(implementer.description, "Writes production code.")
  assert.equal(node(nodes, "agents:reviewer").effective.source, "categories")
  assert.equal(node(nodes, "categories:quick").description, "Fast small work…")
  const base = r.editorNodes({ raw: RAW, builtin: BUILTIN })
  assert.equal(base[0].readOnly !== undefined, true, "no model_profile in base: main is shown read-only")
  assert.equal(r.nodeState(node(r.editorNodes({ raw: RAW, profile: "legacy", builtin: BUILTIN }), "categories:writing"), "legacy"), "비활성")
  assert.equal(r.nodeState(node(r.editorNodes({ raw: RAW, profile: "both", builtin: BUILTIN }), "categories:writing"), "both"), "빌트인",
    "a layer's [senpi] is ignored when it has [native]")
})

test("workingChain: the layer's own chain as is, else the inherited chain without unconnected rungs", () => {
  const av = r.availabilityOf(REGISTRY)
  const nodes = r.editorNodes({ raw: RAW, profile: "work", builtin: BUILTIN })
  const quick = node(r.editorNodes({ raw: {}, builtin: BUILTIN }), "categories:quick")
  assert.deepEqual(r.workingChain(quick, undefined, av, false), ["chatgpt-subscription/gpt-mini:low", "anthropic-subscription/claude-haiku:off"])
  assert.deepEqual(r.workingChain(quick, undefined, av, true), ["chatgpt-subscription/gpt-mini:low", "openrouter/gpt-mini:low", "anthropic-subscription/claude-haiku:off"])
  assert.deepEqual(r.workingChain(node(nodes, "categories:deep"), "work", av, false), ["anthropic-subscription/claude-opus:high"])
  assert.deepEqual(r.workingChain(node(nodes, "categories:quick"), "work", av, false), ["devin/swe-2-high"])
})

test("chainWarnings: adjacent same-model rungs, unknown ids and no connected candidate", () => {
  const av = r.availabilityOf(REGISTRY)
  assert.match(r.chainWarnings(["anthropic-subscription/claude-opus:high", "anthropic-subscription/claude-opus:low"], av).join(), /1·2번: 같은 모델 claude-opus/)
  assert.match(r.chainWarnings(["anthropic-subscription/claude-nope"], av).join(), /연결된 모델 목록에 없습니다/)
  assert.match(r.chainWarnings(["kimi/k3"], av).join(), /연결된 후보가 하나도 없어/)
  assert.deepEqual(r.chainWarnings(["anthropic-subscription/claude-opus:high", "devin/swe-2-high"], av), [])
})

const SRC = `{
  // top comment
  "[native]": {
    "categories": {
      // deep is pinned
      "deep": { "model": "old/model", "models": ["anthropic-subscription/claude-opus:high"] },
      "implementer": {
        "description": "Writes code.",
        "models": ["anthropic-subscription/claude-opus:high"]
      }
    }
  },
  "categories": { "deep": { "fallback_models": ["x/y"] } },
  "profiles": {
    "work": { "[native]": { "categories": { "quick": { "models": ["devin/swe-2-high"], "disable": true } } } },
    "legacy": { "[senpi]": { "categories": {} } },
    "bare": {}
  }
}
`
const draft = (name, fields) => ({ section: "categories", name, disable: null, ...fields })

test("save engine: custom chains replace model/fallback_models in the layer, comments and style survive", () => {
  const text = r.applyDrafts(SRC, [draft("deep", { chain: ["a/b:high", "a/c", "a/b:high"] })])
  const raw = r.parseJsonc(text)
  assert.deepEqual(raw["[native]"].categories.deep, { models: ["a/b:high", "a/c"] })
  assert.deepEqual(raw.categories, {}, "the root fallback_models went, and its emptied entry with it")
  assert.match(text, /\/\/ top comment/)
  assert.match(text, /\/\/ deep is pinned/)
  assert.match(text, /"models": \["a\/b:high", "a\/c"\]/, "an inline array stays inline")
})

test("save engine: follow drops routing keys, keeps descriptions and removes emptied entries", () => {
  const raw = r.parseJsonc(r.applyDrafts(SRC, [
    draft("implementer", { chain: null }),
    { profile: "work", ...draft("quick", { chain: [] }) },
  ]))
  assert.deepEqual(raw["[native]"].categories.implementer, { description: "Writes code." })
  assert.equal(raw.profiles.work["[native]"].categories.quick, undefined, "an empty chain follows too; disable null drops the flag")
})

test("save engine: disable toggles, legacy [senpi] layers, bare profiles and the config-object mirror", () => {
  const disabled = r.applyDrafts(SRC, [draft("writing", { disable: true })])
  assert.deepEqual(r.parseJsonc(disabled)["[native]"].categories.writing, { disable: true })
  assert.equal(r.parseJsonc(r.applyDrafts(disabled, [draft("writing", { disable: null })]))["[native]"].categories.writing, undefined)
  const drafts = [
    { profile: "legacy", ...draft("quick", { chain: ["devin/swe-2-high"] }) },
    { profile: "bare", ...draft("quick", { chain: ["devin/swe-2-high"] }) },
    { profile: "work", ...draft("quick", { disable: false }) },
    draft("deep", { chain: ["a/b"] }),
  ]
  const raw = r.parseJsonc(r.applyDrafts(SRC, drafts))
  assert.deepEqual(raw.profiles.legacy["[senpi]"].categories.quick, { models: ["devin/swe-2-high"] })
  assert.deepEqual(raw.profiles.bare["[native]"].categories.quick, { models: ["devin/swe-2-high"] })
  assert.deepEqual(raw.profiles.work["[native]"].categories.quick, { models: ["devin/swe-2-high"], disable: false })
  assert.deepEqual(r.applyDraftsToConfig(r.parseJsonc(SRC), drafts), raw, "the in-memory preview equals the written file")
})

test("saveConfig: creates a missing file, keeps .bak, and needs confirmation after an external change", t => {
  const dir = temp(t)
  const created = join(dir, ".omo", "omo.jsonc")
  const first = r.saveConfig({ path: created, drafts: [draft("quick", { chain: ["devin/swe-2-high"] })] })
  assert.equal(first.status, "saved")
  assert.equal(first.backup, undefined)
  assert.deepEqual(r.parseJsonc(readFileSync(created, "utf8"))["[native]"].categories.quick.models, ["devin/swe-2-high"])

  const path = join(dir, "omo.jsonc")
  writeFileSync(path, SRC)
  const outside = SRC.replace("// top comment", "// edited elsewhere")
  writeFileSync(path, outside)
  const drafts = [draft("deep", { chain: ["a/b"] })]
  assert.deepEqual(r.saveConfig({ path, openedText: SRC, drafts }), { status: "external-change" })
  assert.equal(readFileSync(path, "utf8"), outside, "nothing written before confirmation")
  const saved = r.saveConfig({ path, openedText: SRC, drafts, confirmExternal: true })
  assert.equal(saved.status, "saved")
  assert.equal(readFileSync(`${path}.bak`, "utf8"), outside)
  assert.match(readFileSync(path, "utf8"), /edited elsewhere/, "the confirmed save applies on top of the newer file")

  const broken = "{ \"a\": [1, }"
  writeFileSync(path, broken)
  assert.equal(r.saveConfig({ path, openedText: broken, drafts }).status, "error")
  assert.equal(readFileSync(path, "utf8"), broken, "an unparsable result is never written")
})

test("a non-object [native] still hides [senpi], and a write replaces it instead of adding a twin key", () => {
  const raw = { profiles: { odd: { "[native]": null, "[senpi]": { categories: { writing: { disable: true } } } } } }
  assert.equal(r.nodeState(node(r.editorNodes({ raw, profile: "odd", builtin: BUILTIN }), "categories:writing"), "odd"), "빌트인")
  const text = r.applyDrafts(JSON.stringify(raw, null, 2), [{ profile: "odd", ...draft("quick", { chain: ["devin/swe-2-high"] }) }])
  assert.equal(text.match(/"\[native\]"/g).length, 1, text)
  assert.deepEqual(r.parseJsonc(text).profiles.odd["[native]"], { categories: { quick: { models: ["devin/swe-2-high"] } } })
  assert.deepEqual(r.applyDraftsToConfig(raw, [{ profile: "odd", ...draft("quick", { chain: ["devin/swe-2-high"] }) }]), r.parseJsonc(text))
})

const OLD = {
  ...BUILTIN,
  defaults: {
    ...BUILTIN.defaults,
    categories: { quick: BUILTIN.defaults.categories.quick, deep: [{ providers: ["chatgpt-subscription"], model: "gpt-old" }], legacy: [{ providers: ["x"], model: "y" }] },
  },
}

test("builtin snapshot: drift reports new, changed and removed nodes; unreadable sections are kept", t => {
  const current = r.builtinSnapshot(BUILTIN, "2.0")
  assert.deepEqual(current.sections.agents, { explore: ["anthropic-subscription/claude-haiku"], reviewer: ["categories: deep"] })
  assert.deepEqual(current.sections.categories.quick, ["{chatgpt-subscription|openrouter}/gpt-mini:low", "anthropic-subscription/claude-haiku:off"])
  const drift = r.snapshotDrift(r.builtinSnapshot(OLD, "1.0"), current)
  assert.equal(drift.since, "1.0")
  assert.equal(drift.count, 3)
  assert.deepEqual(drift.sections.categories.deep, { kind: "changed", before: ["chatgpt-subscription/gpt-old"], after: ["chatgpt-subscription/gpt-big:high", "kimi/k3"] })
  assert.equal(drift.sections.categories.writing.kind, "new")
  assert.equal(drift.sections.categories.legacy.kind, "removed")
  assert.equal(r.driftLine(drift), "builtin changes since last review (reviewed on OMO 1.0): new 1 (writing), changed 1 (deep), removed 1 (legacy); /routing edit to review")

  const unreadable = { ...BUILTIN, defaults: { ...BUILTIN.defaults, categories: {}, unavailable: { categories: "fixture" } } }
  const partial = r.builtinSnapshot(unreadable, "3.0")
  assert.equal(partial.sections.categories, undefined)
  assert.equal(r.snapshotDrift(current, partial).count, 0, "an unreadable section is not reported as removed")
  assert.deepEqual(r.mergeSnapshot(current, partial).sections.categories, current.sections.categories)

  const dir = temp(t)
  const file = join(dir, ".omo", "snap.json")
  r.writeSnapshot(file, current)
  assert.deepEqual(r.readSnapshot(file), current)
  writeFileSync(file, "{ not json")
  assert.equal(r.readSnapshot(file), undefined)
  writeFileSync(file, JSON.stringify({ version: 1, sections: { categories: { a: [1] } } }))
  assert.equal(r.readSnapshot(file), undefined)
})

test("projectConfigs: routing-setting project files from cwd up to, not including, home", t => {
  const home = temp(t)
  const write = (dir, value) => {
    mkdirSync(join(dir, ".omo"), { recursive: true })
    writeFileSync(join(dir, ".omo", "omo.jsonc"), value)
  }
  const proj = join(home, "work", "proj")
  write(home, JSON.stringify({ categories: {} }))
  write(join(home, "work"), JSON.stringify({ task: { default_concurrency: 1 } }))
  write(proj, `{ // comment\n "[native]": { "categories": { "quick": { "models": ["a/b"] } } } }`)
  write(join(proj, "sub"), "{ broken")
  const found = r.projectConfigs(join(proj, "sub", "deeper"), home)
  assert.deepEqual(found.map(f => [f.dir, f.problem === undefined]), [[join(proj, "sub"), false], [proj, true]])
  assert.match(r.projectNotice(found[1]), /also sets routing/)
  assert.match(r.projectNotice(found[0], true), /읽지 못했습니다/)
  assert.ok(!existsSync(join(home, "work", "proj", "sub", "deeper")))
})
