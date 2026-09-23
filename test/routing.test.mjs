// Fake `pi` harness: no senpi, no LLM. Run: node --test test/
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouting, stripJsonc, parseJsonc, mergeConfig, applyProfile, resolveProfileName, chainOf, profileNames, fitLines, setJsoncPath, removeJsoncPath, parseEditArgs, resolveTarget, applyChainEdit } from "../extension/routing.ts"

const OMO_JSONC = `{
  // a comment
  "[senpi]": {
    "model_profile": "unified",
    "model_profiles": { "unified": { "models": ["openai-codex/gpt-5.6-sol:high", "github-copilot/gpt-5.6-sol:high"] }, "capacity-main": { "models": ["openai-codex/gpt-5.6-sol:medium"] } },
    "agents": { "plan-reviewer": { "models": ["devin/swe-2-max", "github-copilot/gpt-6-astra:high"] } },
    "categories": {
      "architect": { "models": ["claude-sdk-oauth/claude-fable-5-1:max", "github-copilot/claude-fable-5.1:max"] },
      "quick": { "models": ["devin/swe-2-low"] }
    },
    "task": { "provider_concurrency": { "openai-codex": 2 } }
  },
  /* block comment */
  "profiles": {
    "capacity": {
      "[senpi]": {
        "model_profile": "capacity-main",
        "categories": { "quick": { "models": ["openai-codex/gpt-5.6-terra:medium"] } }
      }
    },
    "swe2-balanced": { "[senpi]": {} }
  }
}`

function harness({ env = {}, home = mkdtempSync(join(tmpdir(), "routing-home-")), model, writeConfig = true, widget = true } = {}) {
  const commands = {}
  const notes = []
  const widgets = {}
  const events = {}
  const pi = { registerCommand: (name, def) => { commands[name] = def }, on: (name, fn) => { events[name] = fn } }
  const ctx = { ui: { notify: (m, k) => notes.push({ m, k }), ...(widget ? { setWidget: (k, content, opts) => { if (content === undefined) delete widgets[k]; else widgets[k] = { lines: typeof content === "function" ? content({}, {}).render(400) : content, opts } } } : {}) }, model }
  if (writeConfig) {
    mkdirSync(join(home, ".omo"), { recursive: true })
    writeFileSync(join(home, ".omo", "omo.jsonc"), OMO_JSONC)
  }
  createRouting(pi, { env, home })
  const run = (args = "") => commands.routing.handler(args, ctx)
  const fire = (name) => events[name]({}, ctx)
  const cfgPath = join(home, ".omo", "omo.jsonc")
  const readCfg = () => readFileSync(cfgPath, "utf8")
  return { commands, ctx, notes, widgets, run, fire, home, cfgPath, readCfg }
}

// Table rows are `카테고리명  설명  라우팅  변경여부`, cells separated by two or
// more spaces. This harness has no installed OMO source, so 변경여부 is 확인 불가.
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const rowPattern = (name, routing, { description = "-", status = "확인 불가" } = {}) =>
  new RegExp(`^${escape(name)} +${escape(description)} +${escape(routing)} +${status}$`, "m")
const columnStarts = line => [...line.matchAll(/(?<=^|\s{2})\S/gu)].map(match => match.index)

test("stripJsonc removes line and block comments, keeps strings", () => {
  const src = `{"a": "x//y", /* c */ "b": 1} // tail`
  assert.equal(parseJsonc(src).a, "x//y")
  assert.equal(parseJsonc(src).b, 1)
  assert.match(stripJsonc(`// gone\n{"a":1}`), /{"a":1}/)
})

test("mergeConfig: objects deep-merge, arrays replace, proto keys skipped", () => {
  assert.deepEqual(mergeConfig({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3, z: 4 }, list: [9] }), { a: { x: 1, y: 3, z: 4 }, list: [9] })
  const polluted = mergeConfig({}, JSON.parse(`{"__proto__": {"pwned": true}}`))
  assert.equal({}.pwned, undefined)
  assert.equal(polluted.__proto__.pwned, undefined)
})

test("resolveProfileName precedence: OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR", () => {
  assert.equal(resolveProfileName({ OMO_PROFILE: "a", OCX_PROFILE: "b" }), "a")
  assert.equal(resolveProfileName({ OCX_PROFILE: "b" }), "b")
  assert.equal(resolveProfileName({ OPENCODE_CONFIG_DIR: "C:\\x\\profiles\\cap" }), "cap")
  assert.equal(resolveProfileName({ OMO_PROFILE: "" }), undefined)
})

test("applyProfile: profile [senpi] overrides base [senpi]; missing profile warns", () => {
  const raw = parseJsonc(OMO_JSONC)
  assert.deepEqual(profileNames(raw), ["capacity", "swe2-balanced"])
  const base = applyProfile(raw, undefined)
  assert.equal(base.config.model_profile, "unified")
  assert.equal(base.config.categories.quick.models[0], "devin/swe-2-low")
  const cap = applyProfile(raw, "capacity")
  assert.equal(cap.profile, "capacity")
  assert.equal(cap.config.model_profile, "capacity-main")
  assert.equal(cap.config.categories.quick.models[0], "openai-codex/gpt-5.6-terra:medium")
  assert.equal(cap.config.categories.architect.models[0], "claude-sdk-oauth/claude-fable-5-1:max", "untouched keys survive")
  const missing = applyProfile(raw, "nope")
  assert.equal(missing.profile, undefined)
  assert.match(missing.warning, /does not exist/)
})

test("chainOf: model + models, object specs, empty", () => {
  assert.deepEqual(chainOf({ model: "a/b", models: ["c/d:e", { model: "f/g", variant: "high" }] }), ["a/b", "c/d:e", "f/g:high"])
  assert.deepEqual(chainOf({}), [])
  assert.deepEqual(chainOf("x"), [])
})

test("/routing with no args shows the current profile (base when none is set)", async () => {
  const h = harness({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } })
  await h.run()
  const out = h.widgets.routing.lines.join("\n")
  assert.equal(h.notes.length, 0, "widget host gets no toast")
  assert.equal(h.widgets.routing.opts.placement, "aboveEditor")
  assert.match(out, /^config profile: base .*available profiles: capacity, swe2-balanced$/m)
  assert.match(out, /^main model chain \(model_profile\): unified$/m)
  assert.doesNotMatch(out, /^model:|^provider_concurrency:/m)
  assert.match(out, /^카테고리명 +설명 +라우팅 +변경여부$/m)
  assert.match(out, rowPattern("main (unified)", "codex/gpt-5.6-sol:H → gh/gpt-5.6-sol:H [configured]"))
  assert.match(out, rowPattern("architect", "claude/claude-fable-5-1:X → gh/claude-fable-5.1:X [configured]"))
  assert.match(out, rowPattern("quick", "devin/swe-2-low [configured]"))
  assert.match(out, new RegExp(`^agents:\\n${rowPattern("plan-reviewer", "devin/swe-2-max → gh/gpt-6-astra:H [configured]").source}`, "m"))
  const rows = out.split("\n").filter(l => l.includes("[configured]"))
  assert.equal(rows.length, 4)
  assert.equal(new Set(rows.map(l => JSON.stringify(columnStarts(l)))).size, 1, "every row uses the same four columns")
})

test("/routing with no args follows OMO_PROFILE; no widget => full report in the toast", async () => {
  const h = harness({ env: { OMO_PROFILE: "capacity" }, widget: false })
  await h.run()
  const out = h.notes.at(-1).m
  assert.match(out, /^config profile: capacity /m)
  assert.match(out, /^main model chain \(model_profile\): capacity-main$/m)
  assert.match(out, rowPattern("quick", "codex/gpt-5.6-terra:M [configured]"))
  assert.equal(h.widgets.routing, undefined)
})

test("/routing <profile> overrides the env; /routing base drops the overlay", async () => {
  const h = harness({ env: { OMO_PROFILE: "swe2-balanced" }, widget: false })
  await h.run("capacity")
  assert.match(h.notes.at(-1).m, /^main model chain \(model_profile\): capacity-main$/m)
  await h.run("base")
  assert.match(h.notes.at(-1).m, /^main model chain \(model_profile\): unified$/m)
  assert.match(h.notes.at(-1).m, rowPattern("quick", "devin/swe-2-low [configured]"))
})

test("fitLines wraps wide rows at → boundaries, indented to the chain column", () => {
  const row = "deep      a/b:max → c/d:high → e/f:low"
  assert.deepEqual(fitLines([row], 100), [row])
  assert.deepEqual(fitLines([row, "profile: x"], 24), ["deep      a/b:max →", "          c/d:high →", "          e/f:low", "profile: x"])
  assert.deepEqual(fitLines([row], 0), [row])
})

test("/routing toggles the widget off; /routing off hides it; a profile arg always shows", async () => {
  const h = harness()
  await h.run()
  assert.ok(h.widgets.routing)
  assert.equal(h.widgets.routing.lines.at(-1), "(/routing again or /routing off to hide)")
  await h.run()
  assert.equal(h.widgets.routing, undefined, "second bare /routing hides")
  await h.run("capacity")
  assert.match(h.widgets.routing.lines[0], /^config profile: capacity /)
  await h.run("capacity")
  assert.match(h.widgets.routing.lines[0], /^config profile: capacity /, "profile arg re-shows, never toggles")
  await h.run("off")
  assert.equal(h.widgets.routing, undefined)
  await h.run("off")
  assert.equal(h.widgets.routing, undefined, "off is idempotent")
  assert.equal(h.notes.length, 0)
})

test("session_before_reload and session_start clear the widget so the next /routing shows, not hides", async () => {
  const h = harness()
  await h.run()
  assert.ok(h.widgets.routing)
  await h.fire("session_before_reload")
  assert.equal(h.widgets.routing, undefined)
  await h.run()
  assert.ok(h.widgets.routing, "after reload-clear, bare /routing shows")
  await h.fire("session_start")
  assert.equal(h.widgets.routing, undefined)
  await h.run()
  assert.ok(h.widgets.routing)
})

test("/routing <unknown> errors and lists profiles", async () => {
  const h = harness()
  await h.run("bogus")
  assert.equal(h.notes.at(-1).k, "error")
  assert.match(h.notes.at(-1).m, /no profile "bogus".*available profiles: capacity, swe2-balanced/)
})

test("OMO_PROFILE naming a missing profile warns and shows base", async () => {
  const h = harness({ env: { OMO_PROFILE: "gone" }, widget: false })
  await h.run()
  assert.match(h.notes.at(-1).m, /^config profile: base /m)
  assert.match(h.notes.at(-1).m, /^warning: profile "gone" does not exist/m)
})

test("setJsoncPath/removeJsoncPath edit in place: comments, siblings and style survive; missing objects are created", () => {
  let s = setJsoncPath(OMO_JSONC, ["[senpi]", "categories", "quick", "models"], ["x/y:z", "p/q"])
  assert.match(s, /\/\/ a comment/)
  assert.match(s, /\/\* block comment \*\//)
  assert.match(s, /"quick": \{ "models": \["x\/y:z", "p\/q"\] \}/, "inline array stays inline")
  s = setJsoncPath(s, ["[senpi]", "categories", "implementer", "models"], ["n/e:w"])
  assert.match(s, /\n      "implementer": \{\n        "models": \[\n          "n\/e:w"\n        \]\n      \}\n    \}/, "new entry uses the surrounding indentation")
  s = setJsoncPath(s, ["profiles", "swe2-balanced", "[senpi]", "agents", "explore", "models"], ["a/b"])
  s = removeJsoncPath(s, ["[senpi]", "task"])
  const cfg = parseJsonc(s)
  assert.deepEqual(cfg["[senpi]"].categories.quick.models, ["x/y:z", "p/q"])
  assert.deepEqual(cfg["[senpi]"].categories.implementer.models, ["n/e:w"])
  assert.deepEqual(cfg["[senpi]"].categories.architect.models[0], "claude-sdk-oauth/claude-fable-5-1:max")
  assert.deepEqual(cfg.profiles["swe2-balanced"]["[senpi]"].agents.explore.models, ["a/b"])
  assert.equal(cfg["[senpi]"].task, undefined)
  assert.equal(removeJsoncPath(s, ["nope", "x"]), s, "removing an absent path is a no-op")
})

test("parseEditArgs, resolveTarget, applyChainEdit", () => {
  assert.deepEqual(parseEditArgs("set --profile cap quick a/b:c d/e"), { verb: "set", target: "quick", models: ["a/b:c", "d/e"], profile: "cap", base: false })
  assert.deepEqual(parseEditArgs("add --base main x/y"), { verb: "add", target: "main", models: ["x/y"], profile: undefined, base: true })
  assert.match(parseEditArgs("set quick"), /no models/)
  assert.match(parseEditArgs("set"), /usage/)
  assert.match(parseEditArgs("set quick gpt-5"), /not provider\/model/)
  const config = applyProfile(parseJsonc(OMO_JSONC), undefined).config
  assert.deepEqual(resolveTarget("main", config), { path: ["model_profiles", "unified"], label: "main (unified)" })
  assert.deepEqual(resolveTarget("main:capacity-main", config).path, ["model_profiles", "capacity-main"])
  assert.deepEqual(resolveTarget("quick", config).path, ["categories", "quick"])
  assert.deepEqual(resolveTarget("plan-reviewer", config).path, ["agents", "plan-reviewer"])
  assert.deepEqual(resolveTarget("agent:new", config).path, ["agents", "new"])
  assert.match(resolveTarget("nope", config), /unknown target "nope".*category:<name>/)
  assert.match(resolveTarget("both", { categories: { both: {} }, agents: { both: {} } }), /both a category and an agent/)
  assert.match(resolveTarget("main", {}), /no model_profile/)
  assert.deepEqual(applyChainEdit("set", ["a/b"], ["c/d", "c/d", "e/f"]), ["c/d", "e/f"])
  assert.deepEqual(applyChainEdit("add", ["a/b"], ["a/b", "c/d"]), ["a/b", "c/d"])
  assert.deepEqual(applyChainEdit("remove", ["a/b", "c/d"], ["a/b", "zz/z"]), ["c/d"])
  // positional set and prepend: 1-based; a rung already in the chain moves, never duplicates
  assert.deepEqual(parseEditArgs("set quick 2 a/b"), { verb: "set", target: "quick", models: ["a/b"], profile: undefined, base: false, at: 2 })
  assert.match(parseEditArgs("set quick 0 a/b"), /1 or more/)
  assert.match(parseEditArgs("set quick 2"), /no models/)
  assert.match(parseEditArgs("prepend quick 2 a/b"), /only accepted by set/)
  assert.deepEqual(applyChainEdit("set", ["a/b", "c/d", "e/f"], ["x/y"], 2), ["a/b", "x/y", "e/f"])
  assert.deepEqual(applyChainEdit("set", ["a/b", "c/d", "e/f"], ["x/y", "z/z"], 3), ["a/b", "c/d", "x/y", "z/z"])
  assert.deepEqual(applyChainEdit("set", ["a/b", "c/d", "e/f"], ["a/b"], 3), ["c/d", "a/b"], "moved from rung 1 to the end")
  assert.match(applyChainEdit("set", ["a/b"], ["x/y"], 2), /rung 2 does not exist; the chain has 1 rung$/)
  assert.deepEqual(applyChainEdit("prepend", ["a/b", "c/d"], ["x/y"]), ["x/y", "a/b", "c/d"])
  assert.deepEqual(applyChainEdit("prepend", ["a/b", "c/d"], ["c/d"]), ["c/d", "a/b"], "existing rung moves to the front")
})

test("/routing prepend and set <n> edit one position of the effective chain and write it", async () => {
  const h = harness({ env: { OMO_PROFILE: "capacity" }, widget: false })
  await h.run("prepend quick devin/swe-2-low")
  assert.match(h.notes.at(-1).m, /^wrote category quick in profile capacity \[senpi\]: devin\/swe-2-low → codex\/gpt-5\.6-terra:M$/m)
  await h.run("set quick 2 a/b:c")
  assert.match(h.notes.at(-1).m, /^wrote category quick in profile capacity \[senpi\]: devin\/swe-2-low → a\/b:c$/m)
  assert.deepEqual(parseJsonc(h.readCfg()).profiles.capacity["[senpi]"].categories.quick.models, ["devin/swe-2-low", "a/b:c"])
  const before = h.readCfg()
  await h.run("set quick 5 x/y")
  assert.equal(h.notes.at(-1).k, "error")
  assert.match(h.notes.at(-1).m, /category quick: rung 5 does not exist; the chain has 2 rungs/)
  assert.equal(h.readCfg(), before, "nothing written on a bad position")
})

test("/routing set writes the base [senpi] chain when no profile is set, keeps a .bak, and re-shows the report", async () => {
  const h = harness()
  await h.run("set quick devin/swe-2-low openai-codex/gpt-5.6-terra:low")
  assert.equal(h.notes.length, 0)
  const out = h.widgets.routing.lines.join("\n")
  assert.match(out, /^wrote category quick in base \[senpi\]: devin\/swe-2-low → codex\/gpt-5\.6-terra:L$/m)
  assert.match(out, rowPattern("quick", "devin/swe-2-low → codex/gpt-5.6-terra:L [configured]"))
  const src = h.readCfg()
  assert.match(src, /\/\/ a comment/)
  assert.deepEqual(parseJsonc(src)["[senpi]"].categories.quick.models, ["devin/swe-2-low", "openai-codex/gpt-5.6-terra:low"])
  assert.equal(readFileSync(h.cfgPath + ".bak", "utf8"), OMO_JSONC)
})

test("/routing add|remove follow OMO_PROFILE and write only that profile's layer", async () => {
  const h = harness({ env: { OMO_PROFILE: "capacity" }, widget: false })
  await h.run("add quick devin/swe-2-low")
  assert.match(h.notes.at(-1).m, /^wrote category quick in profile capacity \[senpi\]: codex\/gpt-5\.6-terra:M → devin\/swe-2-low$/m)
  await h.run("remove quick openai-codex/gpt-5.6-terra:medium")
  const cfg = parseJsonc(h.readCfg())
  assert.deepEqual(cfg.profiles.capacity["[senpi]"].categories.quick.models, ["devin/swe-2-low"])
  assert.deepEqual(cfg["[senpi]"].categories.quick.models, ["devin/swe-2-low"], "base untouched")
  await h.run("add architect x/y", )
  assert.deepEqual(parseJsonc(h.readCfg()).profiles.capacity["[senpi]"].categories.architect.models, ["claude-sdk-oauth/claude-fable-5-1:max", "github-copilot/claude-fable-5.1:max", "x/y"], "an entry inherited from base is created in the profile with the effective chain")
})

test("[native] is the harness section; a layer's legacy [senpi] applies only when it has no [native]", async () => {
  const h = harness({ widget: false })
  writeFileSync(h.cfgPath, JSON.stringify({
    "[senpi]": { categories: { quick: { models: ["legacy/ignored"] } } },
    "[native]": { task: { default_concurrency: 2 } },
    categories: { quick: { models: ["root/model"] } },
    profiles: {
      migrated: { "[native]": { categories: { quick: { models: ["native/model"] } } } },
      legacy: { "[senpi]": { categories: { quick: { models: ["senpi/model"] } } } },
    },
  }))
  const raw = parseJsonc(h.readCfg())
  assert.deepEqual(applyProfile(raw, undefined).config.categories.quick.models, ["root/model"])
  assert.equal(applyProfile(raw, undefined).config["[native]"], undefined, "harness sections never leak into the effective config")
  assert.deepEqual(applyProfile(raw, "migrated").config.categories.quick.models, ["native/model"])
  assert.deepEqual(applyProfile(raw, "legacy").config.categories.quick.models, ["senpi/model"])
  await h.run("set --profile migrated quick a/b")
  assert.match(h.notes.at(-1).m, /^wrote category quick in profile migrated \[native\]: a\/b$/m)
  await h.run("set --base quick c/d")
  assert.match(h.notes.at(-1).m, /^wrote category quick in base \[native\]: c\/d$/m)
  const cfg = parseJsonc(h.readCfg())
  assert.deepEqual(cfg.profiles.migrated["[native]"].categories.quick.models, ["a/b"])
  assert.deepEqual(cfg["[native]"].categories.quick.models, ["c/d"])
  assert.deepEqual(cfg["[native]"].task, { default_concurrency: 2 }, "sibling keys survive")
  assert.deepEqual(cfg["[senpi]"].categories.quick.models, ["legacy/ignored"], "an overridden legacy section is never written")
})

test("/routing set main, --profile, --base and agent:/category: prefixes", async () => {
  const h = harness({ env: { OMO_PROFILE: "capacity" }, widget: false })
  await h.run("set main a/b:c")
  assert.match(h.notes.at(-1).m, /^wrote main \(capacity-main\) in profile capacity \[senpi\]: a\/b:c$/m)
  await h.run("set --base main d/e")
  await h.run("set --profile swe2-balanced agent:explore f/g")
  await h.run("set --base category:newcat h/i")
  const cfg = parseJsonc(h.readCfg())
  assert.deepEqual(cfg.profiles.capacity["[senpi]"].model_profiles["capacity-main"].models, ["a/b:c"])
  assert.deepEqual(cfg["[senpi]"].model_profiles.unified.models, ["d/e"])
  assert.deepEqual(cfg["[senpi]"].model_profiles["capacity-main"].models, ["openai-codex/gpt-5.6-sol:medium"], "base capacity-main untouched")
  assert.deepEqual(cfg.profiles["swe2-balanced"]["[senpi]"].agents.explore.models, ["f/g"])
  assert.deepEqual(cfg["[senpi]"].categories.newcat.models, ["h/i"])
})

test("/routing set replaces a singular `model` key so the chain is exactly what was set", async () => {
  const h = harness({ widget: false })
  writeFileSync(h.cfgPath, `{ "[senpi]": { "categories": { "quick": { "model": "old/one", "models": ["old/two"] } } } }`)
  await h.run("set quick new/one")
  const cfg = parseJsonc(h.readCfg())
  assert.deepEqual(cfg["[senpi]"].categories.quick, { models: ["new/one"] })
})

test("/routing edit errors: bad model, unknown target, unknown profile, missing config; nothing is written", async () => {
  const h = harness({ env: { OMO_PROFILE: "gone" }, widget: false })
  await h.run("set quick a/b")
  assert.equal(h.notes.at(-1).k, "error")
  assert.match(h.notes.at(-1).m, /no profile "gone".*--base/)
  await h.run("set --base quick gpt")
  assert.match(h.notes.at(-1).m, /not provider\/model/)
  await h.run("set --base nope a/b")
  assert.match(h.notes.at(-1).m, /unknown target "nope"/)
  assert.equal(h.readCfg(), OMO_JSONC)
  assert.equal(existsSync(h.cfgPath + ".bak"), false)
  const none = harness({ writeConfig: false, widget: false })
  await none.run("set quick a/b")
  assert.match(none.notes.at(-1).m, /no omo\.jsonc/)
})

test("/routing help shows the usage in the widget (or toast) without touching the config", async () => {
  const h = harness()
  await h.run("help")
  const out = h.widgets.routing.lines.join("\n")
  assert.match(out, /^\/routing set    <name> <model...>/m)
  assert.match(out, /^  <name>   main \| main:<model_profile> \| <category>/m)
  assert.equal(h.widgets.routing.lines.at(-1), "(/routing again or /routing off to hide)")
  assert.equal(h.notes.length, 0)
  await h.run()
  assert.equal(h.widgets.routing, undefined, "help counts as shown, so a bare /routing hides it")
  assert.equal(h.readCfg(), OMO_JSONC)
  const t = harness({ widget: false })
  await t.run("--help")
  assert.match(t.notes.at(-1).m, /^\/routing help/m)
  await t.run("set quick")
  assert.match(t.notes.at(-1).m, /see \/routing help/)
})

test("/routing survives a missing omo.jsonc", async () => {
  const h = harness({ writeConfig: false, widget: false })
  await h.run()
  const out = h.notes.at(-1).m
  assert.match(out, /^config profile: base /m)
  assert.equal(h.notes.at(-1).k, "info")
  assert.doesNotMatch(out, /categories:/)
})
