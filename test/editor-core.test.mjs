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

test("hostThinkingLevels: a bun global install hoists pi-ai beside omo-ai; senpi's own copy wins", async t => {
  const modules = join(temp(t), "node_modules")
  const piAi = (dir, level) => {
    const pkg = join(dir, "@earendil-works", "pi-ai")
    mkdirSync(join(pkg, "dist"), { recursive: true })
    writeFileSync(join(pkg, "package.json"), '{"type":"module"}')
    writeFileSync(join(pkg, "dist", "models.js"), `export const getSupportedThinkingLevels = () => [${JSON.stringify(level)}]\n`)
  }
  mkdirSync(join(modules, "omo-ai", "bin"), { recursive: true })
  const env = { OMO_BIN: join(modules, "omo-ai", "bin", "omo.js") }
  piAi(modules, "hoisted")
  assert.deepEqual((await r.hostThinkingLevels(env))?.(), ["hoisted"])
  piAi(join(modules, "@code-yeongyu", "senpi", "node_modules"), "senpi")
  assert.deepEqual((await r.hostThinkingLevels(env))?.(), ["senpi"])
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

test("workingChain: an agent that follows its categories starts from the configured category chains, as the list row shows", () => {
  const av = r.availabilityOf(REGISTRY)
  const reviewer = node(r.editorNodes({ raw: RAW, profile: "work", builtin: BUILTIN }), "agents:reviewer")
  assert.equal(reviewer.effective.source, "categories")
  assert.deepEqual(r.workingChain(reviewer, "work", av, true), ["anthropic-subscription/claude-opus:high"])
  assert.deepEqual(r.workingChain(reviewer, undefined, av, true), ["anthropic-subscription/claude-opus:high"])
  assert.deepEqual(r.workingChain(reviewer, undefined, av, false), reviewer.effective.display)
  // Nothing configured: the categories' builtin chains, hidden rungs only on request.
  const plain = node(r.editorNodes({ raw: {}, builtin: BUILTIN }), "agents:reviewer")
  assert.deepEqual(r.workingChain(plain, undefined, av, true), ["chatgpt-subscription/gpt-big:high", "kimi/k3"])
  assert.deepEqual(r.workingChain(plain, undefined, av, false), ["chatgpt-subscription/gpt-big:high"])
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

test("save engine: removing entries or keys never takes a neighbour's comment with it", () => {
  const src = `{
  "[native]": {
    "categories": {
      "quick": { "models": ["a/quick"] }, // quick: cheap on purpose
      "writing": { "models": ["a/writing"] },
      // deep: pinned on purpose
      "deep": {
        "model": "old/model",
        // shown in the delegate prompt
        "description": "Deep work.",
        "models": ["a/deep"]
      },
      "last": { "models": ["a/last"] }
    }
  }
}
`
  const text = r.applyDrafts(src, [
    draft("writing", { chain: null }),
    draft("last", { chain: null }),
    draft("deep", { chain: ["a/new"] }),
  ])
  for (const comment of ["// quick: cheap on purpose", "// deep: pinned on purpose", "// shown in the delegate prompt"])
    assert.ok(text.includes(comment), `${comment} survives:\n${text}`)
  assert.deepEqual(r.parseJsonc(text)["[native]"].categories, {
    quick: { models: ["a/quick"] },
    deep: { description: "Deep work.", models: ["a/new"] },
  })
  assert.doesNotMatch(text, /^\s*$\n^\s*$/m, "no blank lines are left behind")
  assert.equal(r.removeJsoncPath(`{ "a": 1, "b": 2, "c": 3 }`, ["b"]), `{ "a": 1, "c": 3 }`, "inline objects stay tidy")
})

test("save engine: agents chains write efforts as { model, variant } objects, categories keep strings", () => {
  const chain = ["chatgpt-subscription/gpt-mini:low", "devin/swe-2-high", "chatgpt-subscription/gpt-mini:low"]
  const drafts = [{ section: "agents", name: "librarian", disable: null, chain }, draft("quick", { chain })]
  const text = r.applyDrafts(SRC, drafts)
  const raw = r.parseJsonc(text)
  assert.deepEqual(raw["[native]"].agents.librarian, { models: [{ model: "chatgpt-subscription/gpt-mini", variant: "low" }, "devin/swe-2-high"] })
  assert.deepEqual(raw["[native]"].categories.quick, { models: ["chatgpt-subscription/gpt-mini:low", "devin/swe-2-high"] })
  assert.deepEqual(r.applyDraftsToConfig(r.parseJsonc(SRC), drafts), raw, "the in-memory preview equals the written file")
  assert.deepEqual(r.chainOf(raw["[native]"].agents.librarian), ["chatgpt-subscription/gpt-mini:low", "devin/swe-2-high"], "the editor reads it back unchanged")
})

test("the in-memory preview never writes through __proto__", () => {
  const raw = JSON.parse(`{ "profiles": { "__proto__": { "[native]": {} } } }`)
  assert.throws(() => r.applyDraftsToConfig(raw, [{ profile: "__proto__", ...draft("deep", { chain: ["z/z"] }) }]), /refusing to edit through the key __proto__/)
  assert.equal(({})["[native]"], undefined, "Object.prototype stays clean")
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
  assert.match(r.projectNotice(found[1]), /도 라우팅을 정합니다/)
  assert.match(r.projectNotice(found[0]), /읽지 못했습니다/)
  assert.ok(!existsSync(join(home, "work", "proj", "sub", "deeper")))
})

const SNAP = `{
  // keep
  "[native]": { "categories": {
    "deep":    { "models": ["anthropic-subscription/claude-opus:high"] },
    "writing": { "models": ["a/w"] } } },
  "profiles": { "work": { "[native]": { "model_profile": "capable" } } }
}
`
const withoutProfile = (raw, name) => {
  const copy = structuredClone(raw)
  delete copy.profiles[name]
  return copy
}
const SNAP_DRAFTS = [
  { profile: "work", section: "categories", name: "quick", chain: ["devin/swe-2-high"], disable: null },
  { section: "categories", name: "deep", chain: ["a/b:high"], disable: null },
  { profile: "work", section: "categories", name: "writing", chain: null, disable: true },
]

test("snapshot: the new profile resolves to the editor's preview, drafts on both layers included; source, base and comments stay", () => {
  const before = r.parseJsonc(SNAP)
  const snapshot = r.snapshotRouting(before, SNAP_DRAFTS, "work")
  assert.deepEqual(snapshot.routing, {
    model_profile: "capable",
    categories: { deep: { models: ["a/b:high"] }, quick: { models: ["devin/swe-2-high"] }, writing: { models: ["a/w"], disable: true } },
  })
  assert.deepEqual(before, r.parseJsonc(SNAP), "the input config is not mutated")
  const after = r.applySnapshot(SNAP, "frozen", snapshot.routing)
  assert.match(after, /\/\/ keep/)
  const parsed = r.parseJsonc(after)
  assert.deepEqual(withoutProfile(parsed, "frozen"), before, "base and the source profile are byte-for-byte what they were, as data")
  assert.deepEqual(parsed.profiles.frozen, { "[native]": snapshot.routing })
  const preview = r.applyProfile(r.applyDraftsToConfig(before, SNAP_DRAFTS), "work").config
  const resolved = r.applyProfile(parsed, "frozen").config
  for (const key of ["model_profile", "model_profiles", "categories", "agents"]) assert.deepEqual(resolved[key], preview[key], key)
  // Viewing base (Tab) snapshots the base preview: the work-only draft stays out of it.
  const base = r.snapshotRouting(before, SNAP_DRAFTS, undefined)
  assert.deepEqual(base.routing.categories, { deep: { models: ["a/b:high"] }, writing: { models: ["a/w"] } })
  assert.equal(base.routing.model_profile, undefined)
})

test("snapshot: hidden providers, metadata and object rungs are copied verbatim; nothing builtin is materialized; empty routing is valid", () => {
  const raw = {
    "[native]": { agents: { librarian: { description: "d", models: [{ model: "kimi/k3", variant: "high" }, "nowhere/ghost:max"] } }, model_profiles: { capable: { models: ["kimi/k3:high"] } } },
    categories: { deep: { fallback_models: ["x/y"] } },
  }
  const { routing } = r.snapshotRouting(raw, [], undefined)
  assert.deepEqual(routing, {
    model_profiles: { capable: { models: ["kimi/k3:high"] } },
    categories: { deep: { fallback_models: ["x/y"] } },
    agents: { librarian: { description: "d", models: [{ model: "kimi/k3", variant: "high" }, "nowhere/ghost:max"] } },
  })
  const text = r.applySnapshot("{\n}\n", "empty", {})
  assert.deepEqual(r.parseJsonc(text), { profiles: { empty: { "[native]": {} } } })
  assert.deepEqual(r.snapshotRouting({}, [], undefined), { routing: {} })
})

test("snapshot: a removal an overlay cannot express is refused, never approximated", () => {
  const raw = r.parseJsonc(SNAP)
  const follow = [{ section: "categories", name: "deep", chain: null, disable: null }]
  const refused = r.snapshotRouting(raw, follow, undefined)
  assert.match(refused.error, /프로필로 표현할 수 없습니다 \(categories\.deep\)/)
  // The same check guards the write itself, against the text as it is then.
  assert.throws(() => r.applySnapshot(SNAP, "gone", { categories: { writing: { models: ["a/w"] } } }), /표현할 수 없습니다/)
})

test("validateProfileName: trimmed, no reserved keys, separators, whitespace, controls, duplicates or broken containers", () => {
  const raw = r.parseJsonc(SNAP)
  for (const bad of ["", "__proto__", "constructor", "prototype", "[native]", "[senpi]", "a/b", "a\\b", "a b", " a", "a\tb", "a\u0001", "a\u009b", "work"])
    assert.ok(r.validateProfileName(bad, raw), JSON.stringify(bad))
  for (const good of ["frozen", "WORK", "작업복사본", "a.b", "-x"]) assert.equal(r.validateProfileName(good, raw), undefined, good)
  for (const profiles of [[], null, "x", 3]) {
    const broken = { profiles }
    assert.match(r.validateProfileName("new", broken), /profiles가 객체가 아니라/)
    assert.throws(() => r.applySnapshot(JSON.stringify(broken), "new", {}), /profiles가 객체가 아니라/)
  }
  assert.throws(() => r.applySnapshot(SNAP, "work", {}), /이미 있습니다/)
})

test("saveConfig profile: external-change guard, one pre-session .bak, duplicates revalidated on the file itself, missing file created", t => {
  const dir = temp(t)
  const path = join(dir, "omo.jsonc")
  writeFileSync(path, SNAP)
  const outside = SNAP.replace("// keep", "// edited elsewhere")
  writeFileSync(path, outside)
  const routing = { categories: { deep: { models: ["anthropic-subscription/claude-opus:high"] }, writing: { models: ["a/w"] } } }
  const profile = { name: "frozen", routing }
  assert.deepEqual(r.saveConfig({ path, openedText: SNAP, drafts: [], profile }), { status: "external-change" })
  assert.equal(readFileSync(path, "utf8"), outside, "nothing written before confirmation")
  assert.ok(!existsSync(path + ".bak"))
  // Someone added the same name meanwhile: the confirmed write refuses and leaves the file as it is.
  const taken = outside.replace('"work":', '"frozen": { "[native]": {} }, "work":')
  writeFileSync(path, taken)
  const clash = r.saveConfig({ path, openedText: SNAP, drafts: [], profile, confirmExternal: true })
  assert.equal(clash.status, "error")
  assert.match(clash.message, /프로필 "frozen"이 이미 있습니다/)
  assert.equal(readFileSync(path, "utf8"), taken)
  assert.ok(!existsSync(path + ".bak"), "a refused write backs nothing up")
  writeFileSync(path, outside)
  const saved = r.saveConfig({ path, openedText: SNAP, drafts: [], profile, confirmExternal: true })
  assert.equal(saved.status, "saved")
  assert.equal(saved.count, 0)
  assert.equal(readFileSync(path + ".bak", "utf8"), outside)
  assert.match(readFileSync(path, "utf8"), /edited elsewhere/)
  const second = r.saveConfig({ path, openedText: saved.text, drafts: [], profile: { name: "again", routing }, backup: false })
  assert.equal(second.status, "saved")
  assert.equal(readFileSync(path + ".bak", "utf8"), outside, "backup: false keeps the pre-session file")
  assert.deepEqual(Object.keys(r.parseJsonc(readFileSync(path, "utf8")).profiles), ["work", "frozen", "again"])

  const created = join(dir, ".omo", "omo.jsonc")
  assert.equal(r.saveConfig({ path: created, drafts: [], profile: { name: "first", routing: {} } }).status, "saved")
  assert.deepEqual(r.parseJsonc(readFileSync(created, "utf8")), { profiles: { first: { "[native]": {} } } })
  const odd = join(dir, "odd.jsonc")
  writeFileSync(odd, '{ "profiles": [] }')
  assert.equal(r.saveConfig({ path: odd, openedText: '{ "profiles": [] }', drafts: [], profile }).status, "error")
  assert.equal(readFileSync(odd, "utf8"), '{ "profiles": [] }', "a malformed profiles container is never written over")
})
