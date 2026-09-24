import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as routing from "../extension/routing.ts"
import { fixtureDir } from "./fixture-dir.mjs"

// Data-only extracts with the same layout as the installed minified OMO bundles.
// Different identifiers/models ensure discovery cannot depend on minifier names or copied models.
const TASK_SOURCE = `var renamed={quick:[{providers:["one","two"],model:"fast",variant:"low"}],deep:[{providers:["three"],model:"smart",variant:"high"}]};var other={explore:[{providers:["four"],model:"search"}],librarian:[{providers:["five"],model:"docs"}]};var reviewer={name:"reviewer",description:"Review",mode:"subagent",executionMode:"in-process",categories:["deep","quick"],prompt:"not executed"};throw new Error("must never execute installed source");`
const MAIN_SOURCE = `var changed=Object.freeze({capable:{displayName:"Capable",description:"General",models:[{providers:["six","seven"],model:"main",variant:"max"}]},"deep-work":{displayName:"Deep",description:"Hard",models:[{providers:["eight"],model:"reason"}]}});throw new Error("must never execute installed source");`

function fixture(t, config) {
  const home = fixtureDir("routing-defaults-")
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, "installed omo")
  const extensions = join(root, "plugin", "extensions")
  mkdirSync(extensions, { recursive: true })
  mkdirSync(join(root, "bin"))
  writeFileSync(join(root, "bin", "omo.js"), "// launcher")
  writeFileSync(join(extensions, "omo-task.js"), TASK_SOURCE)
  writeFileSync(join(extensions, "omo.js"), MAIN_SOURCE)
  mkdirSync(join(home, ".omo"))
  const configPath = join(home, ".omo", "omo.jsonc")
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config))
  const env = { OMO_BIN: join(root, "bin", "omo.js") }
  let command
  const reports = []
  const ctx = { ui: { notify: (message, kind) => reports.push({ message, kind }) }, modelRegistry: { getAvailable() { throw new Error("provider checks are out of scope") } } }
  routing.createRouting({ registerCommand: (_name, value) => { command = value } }, { home, env })
  return { home, env, extensions, configPath, reports, run: (args = "") => command.handler(args, ctx) }
}

// Parse the 라우팅 column of a table row, not prose: assertions below concern
// candidate models and precedence, never the surrounding layout.
function row(report, name) {
  const line = report.split("\n").find(line => line.startsWith(name + "  "))
  return line?.trim().split(/\s{2,}/)[2]?.replace(/\s+\[[^\]]*\]$/, "")
}

test("installed defaults are read without executing the host when user config is absent", async t => {
  const h = fixture(t)
  await h.run()
  assert.equal(row(h.reports.at(-1).message, "quick"), "{one|two}/fast:L")
  assert.equal(row(h.reports.at(-1).message, "explore"), "four/search")
})

test("an unrecognizable bundle leaves only its own sections unavailable, and never claims defaults it could not read", t => {
  const h = fixture(t)
  writeFileSync(join(h.extensions, "omo-task.js"), "export const unrelated = {}")
  const partial = routing.loadBuiltinRouting(h.env)
  assert.equal(partial.status, "loaded", partial.reason)
  assert.deepEqual(Object.keys(partial.defaults.unavailable).sort(), ["agents", "categories"])
  assert.deepEqual(partial.defaults.categories, {})
  assert.deepEqual(partial.defaults.agents, {})
  assert.deepEqual(Object.keys(partial.defaults.model_profiles).sort(), ["capable", "deep-work"])
  writeFileSync(join(h.extensions, "omo.js"), "export const unrelated = {}")
  const none = routing.loadBuiltinRouting(h.env)
  assert.equal(none.status, "unavailable")
  assert.equal(none.defaults, undefined)
})

test("a table that cannot be read marks only its own rows 확인 불가 and names the section", async t => {
  const h = fixture(t, { model_profile: "capable", categories: { quick: { models: ["custom/model"] } } })
  writeFileSync(join(h.extensions, "omo-task.js"), TASK_SOURCE.replace('model:"fast"', "model:fast()"))
  await h.run()
  const report = h.reports.at(-1).message
  assert.match(report, /^warning: builtin category chains unavailable; those rows show configured chains only \(.*non-constant/m)
  assert.match(report, /^quick\s.*확인 불가$/m)
  assert.equal(row(report, "explore"), "four/search")
  assert.match(report, /^main \(capable\)\s.*기본$/m)
})

test("tables are recognised by shape, so a renamed category (deep -> deep-low/deep-high) keeps builtin defaults loading", async t => {
  const h = fixture(t)
  // The 2026-09 OMO bundle: no `deep` category at all, agents listed before categories, definitions after both.
  writeFileSync(join(h.extensions, "omo-task.js"), `var a={explore:[{providers:["four"],model:"search"}],librarian:[{providers:["five"],model:"docs"}]};var c={"deep-low":[{providers:["three"],model:"smart",variant:"medium"}],"deep-high":[{providers:["three","nine"],model:"smart",variant:"high"}],quick:[{providers:["one"],model:"fast"}]};var d=[{name:"deep-high",config:{model:"three/smart",variant:"high"},description:"Escalation lane."}];throw new Error("must never execute installed source");`)
  const result = routing.loadBuiltinRouting(h.env)
  assert.equal(result.status, "loaded", result.reason)
  assert.deepEqual(Object.keys(result.defaults.categories).sort(), ["deep-high", "deep-low", "quick"])
  assert.deepEqual(Object.keys(result.defaults.agents).sort(), ["explore", "librarian"])
  await h.run()
  const report = h.reports.at(-1).message
  assert.equal(row(report, "deep-high"), "three/smart:H → {three|nine}/smart:H")
  assert.match(report, /^deep-high\s.*기본$/m)
})

test("main profiles are read by shape: extra leading fields and spread provider lists (2026-09-24 bundle)", t => {
  const h = fixture(t)
  writeFileSync(join(h.extensions, "omo.js"), `var p1=["six","seven"],p2=["eight"];var q=Object.freeze({capable:{family:"daily",tier:"normal",displayName:"Capable",description:"General",models:[{providers:[...p1],model:"main",variant:"max"},{providers:[...p2,"nine"],model:"alt"}]},"deep-work":{family:"geeky",tier:"heavy",displayName:"Deep",models:[{providers:["eight"],model:"reason"}]}});throw new Error("must never execute installed source");`)
  const result = routing.loadBuiltinRouting(h.env)
  assert.equal(result.status, "loaded", result.reason)
  assert.deepEqual(result.defaults.model_profiles.capable, [
    { providers: ["six", "seven"], model: "main", variant: "max" },
    { providers: ["eight", "nine"], model: "alt" },
  ])
  assert.equal(result.defaults.descriptions.model_profiles.capable, "General")
})

test("main profiles are read with JS semantics: minified booleans, void 0 and a leading entry (2026-09-24 beta.89 bundle)", t => {
  const h = fixture(t)
  writeFileSync(join(h.extensions, "omo.js"), `var c8=["six","seven"],u8=["eight"],p8=Object.freeze({recommended:{displayName:"Recommended",description:"Best connected.",rankedProvidersOnly:!0,models:[{providers:[...c8],model:"main",variant:"medium"},{providers:[...u8],model:"alt",variant:void 0}]},capable:{family:"daily",tier:"normal",displayName:"Capable",models:[{providers:[...c8],model:"main",variant:"max"}]}});throw new Error("must never execute installed source");`)
  const result = routing.loadBuiltinRouting(h.env)
  assert.equal(result.status, "loaded", result.reason)
  assert.deepEqual(result.defaults.unavailable, {})
  assert.deepEqual(result.defaults.model_profiles.recommended, [
    { providers: ["six", "seven"], model: "main", variant: "medium" },
    { providers: ["eight"], model: "alt" },
  ])
  assert.deepEqual(Object.keys(result.defaults.model_profiles), ["recommended", "capable"])
})

test("a spread without exactly one literal array definition is unsupported, not guessed", t => {
  const h = fixture(t)
  const table = `var q={capable:{displayName:"Capable",models:[{providers:[...p1],model:"main"}]}};`
  for (const definitions of ["", `var p1=["six"];function f(){var p1=["other"]}`, "var p1=g();"]) {
    writeFileSync(join(h.extensions, "omo.js"), definitions + table)
    const result = routing.loadBuiltinRouting(h.env)
    assert.match(result.defaults.unavailable.model_profiles ?? "", /\.\.\.p1/, definitions || "no definition")
    assert.deepEqual(result.defaults.model_profiles, {})
  }
})

test("source discovery requires a known installed launcher and never guesses another installation", () => {
  assert.equal(routing.loadBuiltinRouting({}).status, "unavailable")
})

test("without the @babel/parser installed with OMO nothing is claimed", t => {
  const home = mkdtempSync(join(tmpdir(), "routing-no-parser-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, "plugin", "extensions"), { recursive: true })
  writeFileSync(join(home, "plugin", "extensions", "omo-task.js"), TASK_SOURCE)
  writeFileSync(join(home, "plugin", "extensions", "omo.js"), MAIN_SOURCE)
  const result = routing.loadBuiltinRouting({ OMO_BIN: join(home, "bin", "omo.js") })
  assert.equal(result.status, "unavailable")
  assert.match(result.reason, /@babel\/parser/)
})

// Upgrade detector: the bundles of the omo-ai install running these tests.
test("the installed OMO bundles yield every builtin section", () => {
  assert.ok(process.env.OMO_BIN, "run the tests inside omo (OMO_BIN) to check the installed bundles")
  const result = routing.loadBuiltinRouting(process.env)
  assert.equal(result.status, "loaded", result.reason)
  assert.deepEqual(result.defaults.unavailable, {})
  for (const section of ["categories", "agents", "model_profiles"])
    assert.ok(Object.keys(result.defaults[section]).length > 0, `no builtin ${section}`)
})

test("partial config uses builtin chains for metadata-only and empty categories and agents", t => {
  const h = fixture(t)
  const defaults = routing.loadBuiltinRouting(h.env)
  const effective = routing.resolveRouting({ categories: { quick: { description: "custom", models: [] } }, agents: { explore: { models: [] } } }, defaults)
  assert.deepEqual(effective.config.categories.quick.models, ["one/fast:low", "two/fast:low"])
  assert.deepEqual(effective.config.agents.explore.models, ["four/search"])
  assert.equal(effective.sources.categories.quick, "builtin")
  assert.equal(effective.sources.agents.explore, "builtin")
})

test("category models replace model while agent model precedes models, with builtin fallback separate", t => {
  const h = fixture(t)
  const effective = routing.resolveRouting({ categories: { quick: { model: "ignored/primary", models: ["custom/category"] } }, agents: { explore: { model: "custom/primary", models: ["custom/secondary"] } } }, routing.loadBuiltinRouting(h.env))
  assert.deepEqual(effective.config.categories.quick.models, ["custom/category"])
  assert.deepEqual(effective.config.agents.explore.models, ["custom/primary", "custom/secondary"])
  assert.equal(effective.sources.categories.quick, "configured")
  assert.equal(effective.fallbacks.categories.quick, undefined)
  assert.deepEqual(effective.fallbacks.agents.explore, ["four/search"])
})

test("main builtin selection, user replacement including empty, and direct pin follow host semantics", t => {
  const h = fixture(t)
  const defaults = routing.loadBuiltinRouting(h.env)
  assert.deepEqual(routing.resolveRouting({ model_profile: "capable" }, defaults).config.model_profiles.capable.models, ["six/main:max", "seven/main:max"])
  const empty = routing.resolveRouting({ model_profile: "capable", model_profiles: { capable: {} } }, defaults)
  assert.deepEqual(empty.config.model_profiles.capable.models, [])
  assert.equal(empty.sources.model_profiles.capable, "configured")
  assert.deepEqual(routing.resolveRouting({ model_profile: "pin/model:high" }, defaults).mainChain, ["pin/model:high"])
  assert.equal(routing.resolveRouting({}, defaults).mainSelection, undefined)
})

test("agents inheriting builtin categories reflect effective category overrides", t => {
  const h = fixture(t)
  const effective = routing.resolveRouting({ categories: { deep: { models: ["custom/reason"] } } }, routing.loadBuiltinRouting(h.env))
  assert.deepEqual(effective.config.agents.reviewer.models, ["custom/reason", "one/fast:low", "two/fast:low"])
})

test("profile overlays replace builtin chains without changing untouched defaults", async t => {
  const h = fixture(t, {
    categories: { quick: { models: ["base/model"] } },
    profiles: { work: { "[senpi]": { categories: { quick: { models: ["profile/model"] } } } } },
  })
  await h.run("work")
  assert.equal(row(h.reports.at(-1).message, "quick"), "profile/model")
  assert.equal(row(h.reports.at(-1).message, "deep"), "three/smart:H")
})

test("add materializes an inherited default chain in the written profile only", async t => {
  const h = fixture(t, { profiles: { work: { "[senpi]": {} } } })
  await h.run("add --profile work quick custom/extra")
  const written = JSON.parse(readFileSync(h.configPath, "utf8"))
  assert.deepEqual(written.profiles.work["[senpi]"].categories.quick.models, ["one/fast:low", "two/fast:low", "custom/extra"])
  assert.equal(written.categories, undefined)
})

test("builtin category primary precedes the fallback table, including fallback_models-only overrides", t => {
  const h = fixture(t)
  writeFileSync(join(h.extensions, "omo-task.js"), TASK_SOURCE + `var definitions=[{name:"quick",config:{model:"primary/fast",variant:"max"},description:"default"}];`)
  const defaults = routing.loadBuiltinRouting(h.env)
  const effective = routing.resolveRouting({}, defaults)
  assert.deepEqual(effective.config.categories.quick.models, ["primary/fast:max", "one/fast:low", "two/fast:low"])
  const partial = routing.resolveRouting({ categories: { quick: { fallback_models: ["custom/fallback"] } } }, defaults)
  assert.deepEqual(partial.config.categories.quick.models, ["primary/fast:max", "custom/fallback", "one/fast:low", "two/fast:low"])
})

test("unsupported expressions in default tables are never executed", t => {
  const h = fixture(t)
  writeFileSync(join(h.extensions, "omo-task.js"), TASK_SOURCE.replace('model:"fast"', 'model:(()=>{throw new Error("executed")})()'))
  const result = routing.loadBuiltinRouting(h.env)
  // Rejected before evaluation: running it would report "executed" instead.
  assert.match(result.defaults.unavailable.categories ?? "", /non-constant/)
  assert.deepEqual(result.defaults.categories, {})
  assert.deepEqual(Object.keys(result.defaults.agents).sort(), ["explore", "librarian"])
})

test("duplicate recognizable tables are ambiguous rather than chosen by file order", t => {
  const h = fixture(t)
  writeFileSync(join(h.extensions, "omo-task.js"), TASK_SOURCE + TASK_SOURCE)
  const result = routing.loadBuiltinRouting(h.env)
  assert.match(result.defaults.unavailable.categories ?? "", /found 2/)
  assert.match(result.defaults.unavailable.agents ?? "", /found 2/)
  assert.deepEqual(Object.keys(result.defaults.model_profiles).sort(), ["capable", "deep-work"])
})

test("disabled entries never present their chain as active", t => {
  const h = fixture(t)
  const effective = routing.resolveRouting({ categories: { quick: { disable: true } }, agents: { explore: { disable: true } } }, routing.loadBuiltinRouting(h.env))
  assert.equal(effective.sources.categories.quick, "disabled")
  assert.equal(effective.sources.agents.explore, "disabled")
})
