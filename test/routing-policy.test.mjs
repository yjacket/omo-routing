import { test } from "node:test"
import assert from "node:assert/strict"
import * as r from "../extension/routing.ts"
import { composePolicies, unwrapPolicies, isPolicyReceipt, emptyPolicyReceipt } from "../extension/routing-policy.ts"
import { BUILTIN } from "./editor-fixture.mjs"

const NOW = Date.UTC(2026, 9, 23, 12)
const PROMO = "opengateway/deepseek/deepseek-v4.1-flash-ultrafast:low"
const SCHEDULE = { fetchedAt: NOW - 60_000, discountNow: 0.9, nextAt: NOW + 3_600_000, discountNext: 0 }
const settings = { promo: SCHEDULE, codex: false }
const off = { promo: null, codex: false }
const json = value => JSON.stringify(value, null, 2)
const config = (text, profile) => r.applyProfile(r.parseJsonc(text), profile).config
const resolved = (text, profile, builtin = BUILTIN) => r.resolveRouting(config(text, profile), builtin)
const chain = (text, section, name, profile, builtin = BUILTIN) => resolved(text, profile, builtin).config[section][name]?.models
const compose = (text, options = settings, builtin = BUILTIN) => composePolicies(text, options, builtin, NOW)

test("promotion requires a known current window and stops exactly fifteen minutes early", () => {
  const schedules = [
    null, { ...SCHEDULE, discountNow: 0.899 }, { ...SCHEDULE, nextAt: null },
    { ...SCHEDULE, nextAt: NOW + 900_000 }, { ...SCHEDULE, nextAt: NOW - 1, discountNext: 1 },
    { ...SCHEDULE, fetchedAt: NOW + 1 }, { ...SCHEDULE, fetchedAt: NaN },
    { ...SCHEDULE, nextAt: Infinity }, { ...SCHEDULE, discountNow: Infinity },
  ]
  for (const promo of schedules) {
    const result = compose("{ /* keep */ }", { promo, codex: false })
    assert.equal(result.promoActive, false)
    assert.equal(result.text, "{ /* keep */ }")
  }
  assert.equal(compose("{}", { promo: { ...SCHEDULE, nextAt: NOW + 900_001 }, codex: false }).promoActive, true)
  assert.equal(compose("{}", { promo: { ...SCHEDULE, nextAt: NOW + 1, discountNext: 0.9 }, codex: false }).promoActive, true)
})

test("promotion prefixes only the three lanes and preserves builtin fallback candidates", () => {
  const result = compose("{}")
  assert.deepEqual(chain(result.text, "categories", "quick"), [PROMO, ...chain("{}", "categories", "quick")])
  assert.deepEqual(chain(result.text, "agents", "explore"), [PROMO, ...chain("{}", "agents", "explore")])
  assert.deepEqual(chain(result.text, "agents", "librarian"), [PROMO])
  assert.deepEqual(chain(result.text, "categories", "deep"), chain("{}", "categories", "deep"))
  assert.deepEqual(config(result.text).agents.explore.models[0], { model: PROMO.slice(0, -4), variant: "low" })
})

test("every profile receives promotion after its own root and harness inheritance", () => {
  const base = json({
    categories: { quick: { model: "base/quick" } },
    agents: { explore: { model: { model: "base/explore", variant: "high" } } },
    profiles: {
      own: { categories: { quick: { model: "own/quick" } }, agents: { explore: { model: "own/explore" } } },
      legacy: { "[senpi]": { categories: { quick: { models: ["legacy/quick"] } } } },
      both: { "[senpi]": { categories: { quick: { models: ["ignored/quick"] } } }, "[native]": { categories: { quick: { models: ["native/quick"] } } } },
      follows: {},
    },
  })
  const result = compose(base)
  for (const profile of [undefined, "own", "legacy", "both", "follows"]) {
    for (const [section, name] of [["categories", "quick"], ["agents", "explore"]])
      assert.deepEqual(chain(result.text, section, name, profile), [PROMO, ...chain(base, section, name, profile)])
  }
  assert.deepEqual(r.parseJsonc(unwrapPolicies(result.text, result.receipt)), r.parseJsonc(base))
})

test("disabled nodes remain disabled while profiles can explicitly enable them", () => {
  const base = json({
    "[native]": { categories: { quick: { disable: true } }, agents: { explore: { disable: true } } },
    profiles: { enabled: { "[native]": { categories: { quick: { disable: false } } } } },
  })
  const result = compose(base)
  assert.equal(resolved(result.text).sources.categories.quick, "disabled")
  assert.equal(config(result.text).categories.quick.models, undefined)
  assert.equal(resolved(result.text, "enabled").sources.agents.explore, "disabled")
  assert.equal(chain(result.text, "categories", "quick", "enabled")[0], PROMO)
})

test("Codex preference stably reorders only existing candidates and preserves main routing", () => {
  const base = json({
    model: "main/current", model_profile: "capable",
    model_profiles: { capable: { models: ["anthropic-subscription/main", "openai-codex/main"] } },
    categories: { work: { models: ["other/one", "openai-codex/two:high", "other/three", "chatgpt-subscription/four:low"] }, solo: { models: ["other/solo"] } },
    agents: { worker: { model: { model: "other/primary", variant: "high", note: 1 }, models: [{ model: "openai-codex/agent", variant: "max", note: 2 }, "other/fallback"] } },
  })
  const result = compose(base, { promo: null, codex: true })
  assert.deepEqual(chain(result.text, "categories", "work"), ["openai-codex/two:high", "chatgpt-subscription/four:low", "other/one", "other/three"])
  assert.deepEqual(config(result.text).agents.worker.models, [
    { model: "openai-codex/agent", variant: "max", note: 2 }, { model: "other/primary", variant: "high", note: 1 }, "other/fallback",
  ])
  assert.deepEqual(config(result.text).categories.solo, config(base).categories.solo)
  for (const key of ["model", "model_profile", "model_profiles"]) assert.deepEqual(config(result.text)[key], config(base)[key])
  assert.deepEqual(r.parseJsonc(unwrapPolicies(result.text, result.receipt)), r.parseJsonc(base))
})

test("Codex preference also reorders providers inside an existing builtin group", () => {
  const builtin = structuredClone(BUILTIN)
  builtin.defaults.categories.deep = [{ providers: ["other", "openai-codex", "last"], model: "gpt-big", variant: "high" }]
  const result = compose("{}", { promo: null, codex: true }, builtin)
  // resolveRouting expands builtin provider groups into concrete candidates.
  assert.deepEqual(chain(result.text, "categories", "deep", undefined, builtin), [
    "openai-codex/gpt-big:high", "other/gpt-big:high", "last/gpt-big:high",
  ])
  assert.deepEqual(r.parseJsonc(unwrapPolicies(result.text, result.receipt)), {})
})
test("promo wins its lanes while Codex reorders other lanes without injecting candidates", () => {
  const base = json({ categories: {
    quick: { models: ["other/first", "openai-codex/quick"] },
    deep: { models: ["other/deep", "chatgpt-subscription/deep:high"] },
  } })
  const result = compose(base, { promo: SCHEDULE, codex: true })
  assert.deepEqual(chain(result.text, "categories", "quick"), [PROMO, "other/first", "openai-codex/quick"])
  assert.deepEqual(chain(result.text, "categories", "deep"), ["chatgpt-subscription/deep:high", "other/deep"])
})

test("a promo category does not downgrade unrelated agents that inherit that category", () => {
  const builtin = structuredClone(BUILTIN)
  builtin.defaults.agentCategories.auditor = ["quick"]
  const result = compose("{}", settings, builtin)
  assert.deepEqual(chain(result.text, "agents", "auditor", undefined, builtin), chain("{}", "agents", "auditor", undefined, builtin))
  assert.equal(chain(result.text, "agents", "explore", undefined, builtin)[0], PROMO)
})

test("profile Codex order is derived from fresh base rather than composed base", () => {
  const base = json({ categories: { quick: { model: "other/base" } }, profiles: {
    personal: { categories: { quick: { model: "other/profile", fallback_models: ["openai-codex/personal"] } } },
    plain: { categories: { quick: { model: "other/plain" } } },
  } })
  const result = compose(base, { promo: null, codex: true })
  assert.deepEqual(chain(result.text, "categories", "quick", "personal"), ["openai-codex/personal", "other/profile"])
  assert.deepEqual(chain(result.text, "categories", "quick", "plain"), ["other/plain"])
})

test("unwrapping retains unrelated edits inside inserted containers and comments", () => {
  const base = '{\n  // retain this comment\n  "other": { "value": 1 }\n}\n'
  const result = compose(base)
  const edited = r.setJsoncPath(r.setJsoncPath(result.text, ["[native]", "categories", "quick", "description"], "external"), ["other", "value"], 2)
  const restored = unwrapPolicies(edited, JSON.parse(JSON.stringify(result.receipt)))
  assert.deepEqual(r.parseJsonc(restored), { other: { value: 2 }, "[native]": { categories: { quick: { description: "external" } } } })
  assert.ok(restored.includes("// retain this comment"))
})

test("an unwritten receipt is harmless and deleted or edited chain leaves stay user-owned", () => {
  const base = json({ categories: { quick: { models: ["base/quick"], description: "keep" } } })
  const result = compose(base)
  assert.equal(unwrapPolicies(base, result.receipt), base)
  const edited = r.setJsoncPath(result.text, ["categories", "quick", "models"], ["user/new"])
  assert.deepEqual(config(unwrapPolicies(edited, result.receipt)).categories.quick.models, ["user/new"])
  const removed = r.removeJsoncPath(result.text, ["categories", "quick", "models"])
  assert.equal(config(unwrapPolicies(removed, result.receipt)).categories.quick.models, undefined)
})

test("comments inside a rewritten models array survive composition and exact value restoration", () => {
  const base = '{ "categories": { "quick": { "models": [/* fallback */ "other/first", "openai-codex/second"] } } }'
  const result = compose(base, { promo: null, codex: true })
  assert.ok(result.text.includes("/* fallback */"))
  assert.deepEqual(chain(result.text, "categories", "quick"), ["openai-codex/second", "other/first"])
  assert.equal(unwrapPolicies(result.text, result.receipt), base)
})

test("save during promotion changes only the base and recomposes with the new fallback", () => {
  const active = compose(json({ categories: { quick: { models: ["base/old"] } } }))
  const base = r.applyDrafts(unwrapPolicies(active.text, active.receipt), [
    { section: "categories", name: "quick", chain: ["base/new"], disable: null },
  ])
  const saved = compose(base)
  assert.deepEqual(chain(saved.text, "categories", "quick"), [PROMO, "base/new"])
  assert.deepEqual(config(unwrapPolicies(saved.text, saved.receipt)).categories.quick.models, ["base/new"])
})

test("follow reset during promotion reuses current builtins without copying them into base", () => {
  const active = compose(json({ categories: { quick: { models: ["old/custom"] } } }))
  const base = r.applyDrafts(unwrapPolicies(active.text, active.receipt), [
    { section: "categories", name: "quick", chain: null, disable: null },
  ])
  const builtin = structuredClone(BUILTIN)
  builtin.defaults.categories.quick = [{ providers: ["new"], model: "builtin" }]
  const saved = compose(base, settings, builtin)
  assert.deepEqual(chain(saved.text, "categories", "quick", undefined, builtin), [PROMO, "new/builtin"])
  assert.equal(config(unwrapPolicies(saved.text, saved.receipt)).categories?.quick, undefined)
})

test("save as profile snapshots only basic routing and all profiles recompose from fresh inheritance", () => {
  const active = compose(json({ profiles: { work: {} } }))
  const base = unwrapPolicies(active.text, active.receipt)
  const snapshot = r.snapshotRouting(r.parseJsonc(base), [], "work")
  assert.ok("routing" in snapshot)
  const savedBase = r.applySnapshot(base, "new", snapshot.routing)
  const saved = compose(savedBase)
  for (const profile of ["work", "new"]) assert.equal(chain(saved.text, "categories", "quick", profile)[0], PROMO)
  const plain = r.parseJsonc(unwrapPolicies(saved.text, saved.receipt))
  assert.deepEqual(plain.profiles.new["[native]"], {})
  assert.deepEqual(config(json(plain), "new"), {})
})

test("on-off-on is reversible and turning off Codex keeps active promotion", () => {
  const base = json({ categories: { deep: { models: ["other/deep", "openai-codex/deep"] } } })
  const both = compose(base, { promo: SCHEDULE, codex: true })
  const promo = compose(unwrapPolicies(both.text, both.receipt), settings)
  assert.deepEqual(chain(promo.text, "categories", "deep"), ["other/deep", "openai-codex/deep"])
  assert.equal(chain(promo.text, "categories", "quick")[0], PROMO)
  const stopped = compose(unwrapPolicies(promo.text, promo.receipt), off)
  assert.deepEqual(r.parseJsonc(stopped.text), r.parseJsonc(base))
  assert.deepEqual(r.parseJsonc(compose(stopped.text).text), r.parseJsonc(compose(base).text))
})

test("receipts survive serialization and reject malformed journal fields", () => {
  const result = compose("{}")
  assert.equal(isPolicyReceipt(JSON.parse(JSON.stringify(result.receipt))), true)
  assert.equal(isPolicyReceipt(emptyPolicyReceipt()), true)
  for (const receipt of [null, {}, { version: 2, changes: [] }, { version: 1, changes: [{}] },
    { version: 1, changes: [{ path: ["__proto__"], before: null, after: "{}" }] },
    { version: 1, changes: [{ path: ["categories"], before: null, after: "bad" }] }])
    assert.equal(isPolicyReceipt(receipt), false)
  assert.equal(unwrapPolicies("{}", undefined), "{}")
})

test("a scalar harness is restored instead of being duplicated or losing sibling metadata", () => {
  const base = '{ "[native]": null, "keep": 3, "profiles": { "scalar": { "[native]": false } } }'
  const result = compose(base)
  assert.equal(chain(result.text, "categories", "quick", "scalar")[0], PROMO)
  assert.deepEqual(r.parseJsonc(unwrapPolicies(result.text, result.receipt)), r.parseJsonc(base))
})
