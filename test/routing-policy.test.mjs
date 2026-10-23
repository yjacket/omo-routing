import { test } from "node:test"
import assert from "node:assert/strict"
import * as r from "../extension/routing.ts"
import { composePolicies, unwrapPolicies, isPolicyReceipt, emptyPolicyReceipt, overlayKey } from "../extension/routing-policy.ts"
import { BUILTIN } from "./editor-fixture.mjs"

const NOW = Date.UTC(2026, 9, 23, 12)
const PROMO = "opengateway/deepseek/deepseek-v4.1-flash-ultrafast:low"
const SCHEDULE = { fetchedAt: NOW - 60_000, discountNow: 0.9, nextAt: NOW + 3_600_000, discountNext: 0 }
const settings = { promo: SCHEDULE, overlay: null }
const off = { promo: null, overlay: null }
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
    const result = compose("{ /* keep */ }", { promo, overlay: null })
    assert.equal(result.promoActive, false)
    assert.equal(result.text, "{ /* keep */ }")
  }
  assert.equal(compose("{}", { promo: { ...SCHEDULE, nextAt: NOW + 900_001 }, overlay: null }).promoActive, true)
  assert.equal(compose("{}", { promo: { ...SCHEDULE, nextAt: NOW + 1, discountNext: 0.9 }, overlay: null }).promoActive, true)
})

test("promotion prefixes only the three lanes and preserves builtin fallback candidates", () => {
  const result = compose("{}")
  assert.deepEqual(chain(result.text, "categories", "quick"), [PROMO, ...new Set(chain("{}", "categories", "quick"))])
  assert.deepEqual(chain(result.text, "agents", "explore"), [PROMO, ...new Set(chain("{}", "agents", "explore"))])
  assert.deepEqual(chain(result.text, "agents", "librarian"), [PROMO])
  assert.deepEqual(chain(result.text, "categories", "deep"), chain("{}", "categories", "deep"))
  assert.deepEqual(config(result.text).agents.explore.models[0], { model: PROMO.slice(0, -4), variant: "low" })
})

test("promotion pins distinct builtin candidates but leaves unchanged resolution intact", () => {
  const builtin = structuredClone(BUILTIN)
  const fallback = chain("{}", "categories", "quick", undefined, builtin)
  builtin.defaults.categoryModels.quick = fallback[0]
  const resolvedQuick = chain("{}", "categories", "quick", undefined, builtin)
  assert.equal(resolvedQuick[0], resolvedQuick[1])
  const resolvedDeep = chain("{}", "categories", "deep", undefined, builtin)
  const result = compose("{}", settings, builtin)
  const promoted = chain(result.text, "categories", "quick", undefined, builtin)
  assert.deepEqual(promoted, [PROMO, ...new Set(resolvedQuick)])
  assert.ok(promoted.every((spec, i) => i === 0 || spec !== promoted[i - 1]))
  assert.deepEqual(chain(result.text, "categories", "deep", undefined, builtin), resolvedDeep)
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

test("overlay replaces only target-owned nodes across layers and preserves object rungs and main routing", () => {
  const base = json({
    model: "main/current", model_profile: "capable",
    model_profiles: { capable: { models: ["anthropic-subscription/main", "openai-codex/main"] } },
    categories: { work: { models: ["base/work"] }, solo: { models: ["other/solo"] } },
    agents: { worker: { model: "base/worker" } },
    profiles: {
      switch: { "[native]": { categories: { work: { models: ["target/work", "target/work"] } }, agents: { worker: { model: null, models: [{ model: "target/agent", variant: "max", note: 2 }] } } } },
      other: { categories: { work: { models: ["other/work"] } }, agents: { worker: { model: "other/worker" } } },
    },
  })
  const result = compose(base, { promo: null, overlay: { profile: "switch", exclude: [] } })
  assert.equal(result.overlayActive, true)
  for (const profile of [undefined, "other"]) {
    assert.deepEqual(chain(result.text, "categories", "work", profile), ["target/work"])
    assert.deepEqual(config(result.text, profile).agents.worker.models, [{ model: "target/agent", variant: "max", note: 2 }])
    assert.equal(config(result.text, profile).agents.worker.model, null)
  }
  assert.deepEqual(r.parseJsonc(result.text).profiles.switch, r.parseJsonc(base).profiles.switch)
  assert.deepEqual(config(result.text).categories.solo, config(base).categories.solo)
  for (const key of ["model", "model_profile", "model_profiles"]) assert.deepEqual(config(result.text)[key], config(base)[key])
  assert.equal(unwrapPolicies(result.text, result.receipt), base)
})

test("promo leads overlay lanes, disabled nodes stay untouched and exclusions are per layer", () => {
  const base = json({
    categories: { quick: { models: ["base/quick"] }, stopped: { models: ["base/stopped"], disable: true } },
    profiles: {
      switch: { "[senpi]": { categories: { quick: { models: ["target/quick"] }, stopped: { models: ["target/stopped"] }, blocked: { disable: true } }, agents: { explore: { models: ["target/explore"] }, librarian: { models: ["target/library"] } } } },
      excluded: { categories: { quick: { models: ["edited/quick"] } } },
    },
  })
  const result = compose(base, { promo: SCHEDULE, overlay: { profile: "switch", exclude: [overlayKey("excluded", "categories", "quick")] } })
  assert.deepEqual(chain(result.text, "categories", "quick"), [PROMO, "target/quick"])
  assert.deepEqual(chain(result.text, "categories", "quick", "excluded"), [PROMO, "edited/quick"])
  assert.deepEqual(chain(result.text, "agents", "explore"), [PROMO, "target/explore"])
  assert.deepEqual(chain(result.text, "agents", "librarian"), [PROMO, "target/library"])
  assert.deepEqual(config(result.text).categories.stopped, config(base).categories.stopped)
  assert.deepEqual(chain(result.text, "categories", "blocked"), chain(base, "categories", "blocked"))
  assert.equal(unwrapPolicies(result.text, result.receipt), base)
})

test("a promo category does not downgrade unrelated agents that inherit that category", () => {
  const builtin = structuredClone(BUILTIN)
  builtin.defaults.agentCategories.auditor = ["quick"]
  const result = compose("{}", settings, builtin)
  assert.deepEqual(chain(result.text, "agents", "auditor", undefined, builtin), chain("{}", "agents", "auditor", undefined, builtin))
  assert.equal(chain(result.text, "agents", "explore", undefined, builtin)[0], PROMO)
})

test("an absent overlay target leaves the authored text unchanged", () => {
  for (const profiles of [{}, { missing: null }, { missing: [] }]) {
    const base = json({ profiles })
    const result = compose(base, { promo: null, overlay: { profile: "missing", exclude: [] } })
    assert.equal(result.overlayActive, false)
    assert.equal(result.text, base)
  }
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
  const base = '{ "categories": { "quick": { "models": [/* fallback */ "other/first", "openai-codex/second"] } }, "profiles": { "switch": { "categories": { "quick": { "models": ["target/quick"] } } } } }'
  const result = compose(base, { promo: null, overlay: { profile: "switch", exclude: [] } })
  assert.ok(result.text.includes("/* fallback */"))
  assert.deepEqual(chain(result.text, "categories", "quick"), ["target/quick"])
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

test("on-off-on is reversible and turning off overlay keeps active promotion", () => {
  const base = json({ categories: { deep: { models: ["other/deep"] } }, profiles: { switch: { categories: { deep: { models: ["target/deep"] } } } } })
  const both = compose(base, { promo: SCHEDULE, overlay: { profile: "switch", exclude: [] } })
  const promo = compose(unwrapPolicies(both.text, both.receipt), settings)
  assert.deepEqual(chain(promo.text, "categories", "deep"), ["other/deep"])
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
