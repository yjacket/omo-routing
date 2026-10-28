import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
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
  return { home, env, extensions, configPath }
}

test("installed defaults are read without executing the host when user config is absent", t => {
  const h = fixture(t)
  const { display } = routing.resolveRouting({}, routing.loadBuiltinRouting(h.env))
  assert.deepEqual(display.categories.quick, ["{one|two}/fast:low"])
  assert.deepEqual(display.agents.explore, ["four/search"])
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

test("tables are recognised by shape, so a renamed category (deep -> deep-low/deep-high) keeps builtin defaults loading", t => {
  const h = fixture(t)
  // The 2026-09 OMO bundle: no `deep` category at all, agents listed before categories, definitions after both.
  writeFileSync(join(h.extensions, "omo-task.js"), `var a={explore:[{providers:["four"],model:"search"}],librarian:[{providers:["five"],model:"docs"}]};var c={"deep-low":[{providers:["three"],model:"smart",variant:"medium"}],"deep-high":[{providers:["three","nine"],model:"smart",variant:"high"}],quick:[{providers:["one"],model:"fast"}]};var d=[{name:"deep-high",config:{model:"three/smart",variant:"high"},description:"Escalation lane."}];throw new Error("must never execute installed source");`)
  const result = routing.loadBuiltinRouting(h.env)
  assert.equal(result.status, "loaded", result.reason)
  assert.deepEqual(Object.keys(result.defaults.categories).sort(), ["deep-high", "deep-low", "quick"])
  assert.deepEqual(Object.keys(result.defaults.agents).sort(), ["explore", "librarian"])
  assert.deepEqual(routing.resolveRouting({}, result).display.categories["deep-high"], ["three/smart:high", "{three|nine}/smart:high"])
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

test("tables reach their data through names bound to constants (2026-10-27 OMO 5.1.48 bundle)", t => {
  const h = fixture(t)
  // Model names through a constant object assigned in a lazy initializer, a
  // string-bound name, and comma-joined minified declarations.
  writeFileSync(join(h.extensions, "omo-task.js"), `var m,ba=r(()=>{m={fast:"fast",smart:"smart"}});let s="search",p=["four"];var a={explore:[{providers:[...p],model:s,variant:"low"}],librarian:[{providers:["five"],model:m.smart}]};var c={quick:[{providers:["one","two"],model:m.fast,variant:"low"}],deep:[{providers:["three"],model:m["smart"],variant:"high"}]};var d=[{name:"quick",config:{model:"one/"+m.fast,variant:"low"}}];throw new Error("must never execute installed source");`)
  writeFileSync(join(h.extensions, "omo.js"), `const tae=["six","seven"],Rb="main",Bb="alt";var q=Object.freeze({capable:{displayName:"Capable",models:[{providers:[...tae],model:Rb,variant:"medium"},{providers:[...tae,"eight"],model:Bb}]}});throw new Error("must never execute installed source");`)
  const result = routing.loadBuiltinRouting(h.env)
  assert.equal(result.status, "loaded", result.reason)
  assert.deepEqual(result.defaults.unavailable, {})
  assert.deepEqual(result.defaults.categories.quick, [{ providers: ["one", "two"], model: "fast", variant: "low" }])
  assert.deepEqual(result.defaults.categories.deep, [{ providers: ["three"], model: "smart", variant: "high" }])
  assert.equal(result.defaults.categoryModels.quick, "one/fast:low")
  assert.deepEqual(result.defaults.agents.explore, [{ providers: ["four"], model: "search", variant: "low" }])
  assert.deepEqual(result.defaults.agents.librarian, [{ providers: ["five"], model: "smart" }])
  assert.deepEqual(result.defaults.model_profiles.capable, [
    { providers: ["six", "seven"], model: "main", variant: "medium" },
    { providers: ["six", "seven", "eight"], model: "alt" },
  ])
})

// A launch gate shaped like OMO 5.1.51's Fable 5.5 pre-wiring, under other names:
// chains pass through a bundle function that drops the rungs of a model not
// released yet, and logs a released rung whose effort it does not accept.
const gated = released => `var nx,on,rel=${released ? "!0" : "!1"},dropped=[],ini=r(()=>{nx={id:"next"},on={measured:!1,accepted:["max"]}});function isNext(e){return(e.split("/").pop()??e)===nx.id}function note(e){dropped.push(e),console.warn("dropped "+e.model)}function gate(e){return function(e,t,n){return e.filter(e=>!(isNext(e.model)&&(!t.released||(void 0===e.variant||!t.accepted.includes(e.variant))&&(n({model:e.model,variant:e.variant}),1))))}(e,{released:rel,accepted:on.accepted},note)}function primary(){return rel?nx.id:"smart"}`
const GATED_TASK = `var a={explore:gate([{providers:["four"],model:nx.id,variant:"max"},{providers:["four"],model:"search"}]),librarian:[{providers:["five"],model:"docs"}]};var c={quick:[{providers:["one"],model:"fast"}],deep:gate([{providers:["three"],model:nx.id,variant:"max"},{providers:["three"],model:"smart",variant:"high"}])};var d=[{name:"deep",config:{model:primary(),variant:"high"}}];throw new Error("must never execute installed source");`
const GATED_MAIN = `var q=Object.freeze({capable:{displayName:"Capable",models:gate([{providers:["six"],model:nx.id,variant:"max"},{providers:["six"],model:"main",variant:"max"}])}});throw new Error("must never execute installed source");`

test("chains passed through a bundle function are what that function returns, as the host runs it (2026-10-28 OMO 5.1.51 bundle)", t => {
  const h = fixture(t)
  writeFileSync(join(h.extensions, "omo-task.js"), gated(false) + GATED_TASK)
  writeFileSync(join(h.extensions, "omo.js"), gated(false) + GATED_MAIN)
  const unreleased = routing.loadBuiltinRouting(h.env)
  assert.equal(unreleased.status, "loaded", unreleased.reason)
  assert.deepEqual(unreleased.defaults.unavailable, {})
  assert.deepEqual(unreleased.defaults.categories.deep, [{ providers: ["three"], model: "smart", variant: "high" }])
  assert.deepEqual(unreleased.defaults.categories.quick, [{ providers: ["one"], model: "fast" }])
  assert.equal(unreleased.defaults.categoryModels.deep, "smart:high")
  assert.deepEqual(unreleased.defaults.agents.explore, [{ providers: ["four"], model: "search" }])
  assert.deepEqual(unreleased.defaults.model_profiles.capable, [{ providers: ["six"], model: "main", variant: "max" }])
  // The gate's own flag decides, so the result follows it rather than a stripped wrapper.
  writeFileSync(join(h.extensions, "omo-task.js"), gated(true) + GATED_TASK)
  writeFileSync(join(h.extensions, "omo.js"), gated(true) + GATED_MAIN)
  const released = routing.loadBuiltinRouting(h.env)
  assert.deepEqual(released.defaults.unavailable, {})
  assert.deepEqual(released.defaults.categories.deep.map(rung => rung.model), ["next", "smart"])
  assert.equal(released.defaults.categoryModels.deep, "next:high")
  assert.deepEqual(released.defaults.model_profiles.capable.map(rung => rung.model), ["next", "main"])
  // A released rung the gate would log (an effort it does not accept) needs the
  // logger and its mutated list, which are not constant data.
  writeFileSync(join(h.extensions, "omo.js"), gated(true) + GATED_MAIN.replace('model:nx.id,variant:"max"', 'model:nx.id,variant:"low"'))
  const logged = routing.loadBuiltinRouting(h.env)
  assert.match(logged.defaults.unavailable.model_profiles ?? "", /(dropped|console) is not constant data/)
  assert.deepEqual(logged.defaults.model_profiles, {})
})

test("a bundle function is run only over the bundle's constant data; anything else it reaches is unsupported, not guessed", t => {
  const h = fixture(t)
  const table = `var c={quick:f([{providers:["one"],model:"fast"}])};`
  for (const [definitions, reason] of [
    ["", /no constant data defines f\(\.\.\.\)/],
    ["function f(e){return Date.now()?e:[]}", /Date is not constant data/],
    ["function f(e){return e.filter(()=>Math.random()<2)}", /Math is not constant data/],
    ["var k=[];k.push(1);function f(e){return k.length?e:[]}", /k is not constant data/],
    ["function f(e){return e}function h(){function f(e){return[]}}", /conflicting definitions of f/],
    ["function f(e){return e}f=g();", /f\(\.\.\.\) is bound to non-constant data/],
    ["function f(e){return e}[f]=g();", /f\(\.\.\.\) is changed after it is defined/],
    ["async function f(e){return e}", /not a plain function/],
  ]) {
    writeFileSync(join(h.extensions, "omo-task.js"), definitions + table)
    const result = routing.loadBuiltinRouting(h.env)
    assert.match(result.defaults.unavailable.categories ?? "", reason, definitions || "no definition")
    assert.deepEqual(result.defaults.categories, {})
  }
  // Only `name(...)` over constant data: method calls and spread arguments stay rejected.
  for (const call of ['m.f([{providers:["one"],model:"fast"}])', 'f(...x)']) {
    writeFileSync(join(h.extensions, "omo-task.js"), `var m={},x=[];function f(e){return e}var c={quick:[{providers:["one"],model:"fast"}],deep:[{providers:["two"],model:"x"}]};var d=[{name:"quick",config:{model:${call}}}];`)
    assert.match(routing.loadBuiltinRouting(h.env).defaults.unavailable.categories ?? "", /unsupported default model/, call)
  }
})

test("a name whose binding is not constant data is unsupported, not guessed", t => {
  const h = fixture(t)
  const table = `var c={quick:[{providers:["one"],model:m.fast}]};`
  for (const [definitions, reason] of [
    ["", /no constant data defines m/],
    ["var m=g();", /m is bound to non-constant data/],
    [`var m={fast:"fast"};function f(){var m={fast:"other"}}`, /conflicting definitions of m/],
    [`var m={fast:"fast"};m.fast=g();`, /m is changed after it is defined/],
    [`var m={fast:"fast"};Object.assign(m,g());`, /m is changed after it is defined/],
    [`var m={fast:"fast"};[m]=g();`, /m is changed after it is defined/],
  ]) {
    writeFileSync(join(h.extensions, "omo-task.js"), definitions + table)
    const result = routing.loadBuiltinRouting(h.env)
    assert.match(result.defaults.unavailable.categories ?? "", reason, definitions || "no definition")
    assert.deepEqual(result.defaults.categories, {})
  }
  // Computed or prototype member reads are not constant references.
  for (const model of ["m[k]", "m.constructor", "m.fast()", "this.fast"]) {
    writeFileSync(join(h.extensions, "omo-task.js"), `var m={fast:"fast"},k="fast";var c={quick:[{providers:["one"],model:${model}}]};`)
    assert.match(routing.loadBuiltinRouting(h.env).defaults.unavailable.categories ?? "", /non-constant expression/, model)
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

test("profile overlays replace builtin chains without changing untouched defaults", t => {
  const h = fixture(t)
  const raw = {
    categories: { quick: { models: ["base/model"] } },
    profiles: { work: { "[senpi]": { categories: { quick: { models: ["profile/model"] } } } } },
  }
  const { display } = routing.resolveRouting(routing.applyProfile(raw, "work").config, routing.loadBuiltinRouting(h.env))
  assert.deepEqual(display.categories.quick, ["profile/model"])
  assert.deepEqual(display.categories.deep, ["three/smart:high"])
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
