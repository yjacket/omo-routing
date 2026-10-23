import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { RoutingPolicies } from "../extension/routing-runtime.ts"
import { applyDrafts, applyProfile, parseJsonc, saveConfig } from "../extension/routing.ts"
import { composePolicies, overlayKey } from "../extension/routing-policy.ts"
import { BUILTIN } from "./editor-fixture.mjs"

const MODEL = "opengateway/deepseek/deepseek-v4.1-flash-ultrafast"
const NOW = Date.parse("2026-10-23T16:00:00Z")
const SRC = `{
  // keep my edits
  "[native]": {
    "categories": { "quick": { "models": ["base/small"] }, "deep": { "models": ["other/large", "chatgpt-subscription/gpt-big:high"] } },
    "agents": { "explore": { "models": ["base/search"] }, "librarian": { "models": ["base/library"] } }
  },
  "profiles": { "work": { "[native]": { "categories": { "quick": { "models": ["base/profile"] } } } } }
}
`
function fixture(t, fetcher) {
  const home = mkdtempSync(join(tmpdir(), "routing-policy-runtime-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, ".omo"))
  const path = join(home, ".omo", "omo.jsonc")
  writeFileSync(path, SRC)
  let now = NOW
  const policies = new RoutingPolicies(home, { now: () => now, lockWaitMs: 50, ...(fetcher ? { fetcher } : {}) })
  writeFileSync(policies.statePath, JSON.stringify({
    version: 1, promoEnabled: true, switchProfile: null, codex: null, errors: [], checkedAt: 0,
    promo: { fetchedAt: NOW, discountNow: 0.9, discountNext: 0.5, nextAt: NOW + 3_600_000 },
  }))
  const apply = () => {
    const current = readFileSync(path, "utf8")
    const base = policies.base(current, path)
    return policies.write({ path, base, current, baseBefore: base, builtin: BUILTIN, backup: false })
  }
  return { home, path, policies, apply, time: value => { now = value } }
}
const config = path => parseJsonc(readFileSync(path, "utf8"))

test("saving and following a category keeps promotion separate from the editable base, then expiry keeps the edit", t => {
  // Given: a running promotion, including a saved profile overriding quick.
  const h = fixture(t)
  h.apply()
  const disk = readFileSync(h.path, "utf8")
  assert.equal(applyProfile(config(h.path), "work").config.categories.quick.models[0], `${MODEL}:low`)

  // When: the user edits another lane and resets quick to builtin.
  const saved = saveConfig({
    path: h.path, openedText: disk, policies: h.policies, builtin: BUILTIN,
    drafts: [
      { section: "categories", name: "quick", chain: null, disable: null },
      { section: "agents", name: "explore", chain: ["base/edited-search"], disable: null },
    ],
  })

  // Then: the policy still leads, but the editor's source remains a follow.
  assert.equal(saved.status, "saved")
  assert.equal(parseJsonc(saved.text)["[native]"].categories.quick, undefined)
  assert.equal(config(h.path)["[native]"].categories.quick.models[0], `${MODEL}:low`)
  assert.equal(readFileSync(`${h.path}.bak`, "utf8"), disk)
  h.time(NOW + 3_600_000)
  h.apply()
  assert.equal(config(h.path)["[native]"].categories.quick, undefined)
  assert.deepEqual(config(h.path)["[native]"].agents.explore.models, ["base/edited-search"])
  assert.deepEqual(config(h.path).profiles.work["[native]"].categories.quick.models, ["base/profile"])
  assert.match(readFileSync(h.path, "utf8"), /\/\/ keep my edits/)
})

test("saving a new profile during a promotion copies base routing, not the temporary model", t => {
  // Given: policy contributions in the effective file.
  const h = fixture(t)
  h.apply()
  const disk = readFileSync(h.path, "utf8")
  const routing = applyProfile(parseJsonc(h.policies.base(disk, h.path)), "work").config

  // When: the editor saves that base routing as a new profile.
  const result = saveConfig({ path: h.path, openedText: disk, drafts: [], policies: h.policies, builtin: BUILTIN, profile: { name: "new", routing } })

  // Then: the profile receives the live policy, which disappears on expiry.
  assert.equal(result.status, "saved")
  assert.equal(applyProfile(config(h.path), "new").config.categories.quick.models[0], `${MODEL}:low`)
  h.time(NOW + 3_600_000)
  h.apply()
  assert.deepEqual(config(h.path).profiles.new["[native]"].categories.quick.models, ["base/profile"])
})

test("an unrelated external edit survives policy removal, and a stale save still needs confirmation", t => {
  // Given: another writer changed unrelated data after policy application.
  const h = fixture(t)
  h.apply()
  const before = readFileSync(h.path, "utf8")
  writeFileSync(h.path, before.replace("keep my edits", "changed outside"))

  // When: saving from the old editor snapshot.
  const saved = saveConfig({ path: h.path, openedText: before, drafts: [], policies: h.policies, builtin: BUILTIN })

  // Then: no overwrite occurs, and ending the promotion keeps that edit.
  assert.deepEqual(saved, { status: "external-change" })
  h.time(NOW + 3_600_000)
  h.apply()
  assert.match(readFileSync(h.path, "utf8"), /changed outside/)
  assert.deepEqual(config(h.path), parseJsonc(SRC))
})

test("switch watches overlay target nodes and close by restoring the authored text byte for byte", t => {
  const h = fixture(t)
  h.policies.setPromo(false)
  h.policies.setSwitchProfile("work")
  const state = h.policies.state()
  const codex = {
    probabilities: { rounded_24h: 93, rounded_48h: 99 }, confidence: "high",
    last_reset_at: null, updated_at: new Date(NOW).toISOString(), official_signal: false,
    alert: { kind: "watch", state: "active", at: new Date(NOW).toISOString(), score: 93, endsAt: null },
  }
  const update = patch => writeFileSync(h.policies.statePath, JSON.stringify({ ...h.policies.state(), ...patch }))
  update({ codex })
  assert.equal(h.policies.switching(), "work")
  assert.equal(h.policies.switching(parseJsonc(SRC)), "work")
  assert.match(h.policies.status(), / → work$/)
  h.apply()
  assert.deepEqual(config(h.path)["[native]"].categories.quick.models, ["base/profile"])
  for (const alert of [
    { ...codex.alert, state: "expired" },
    { ...codex.alert, endsAt: new Date(NOW).toISOString() },
    { ...codex.alert, kind: "reset", state: "confirmed" },
  ]) {
    update({ codex: { ...codex, alert } })
    assert.equal(h.policies.switching(), null)
    h.apply()
    assert.equal(readFileSync(h.path, "utf8"), SRC)
  }
  update({ codex })
  h.policies.setSwitchProfile(null)
  assert.equal(h.policies.preview(SRC, BUILTIN).text, SRC)
  h.policies.setSwitchProfile("absent")
  assert.equal(h.policies.switching(), null)
  assert.equal(h.policies.preview(SRC, BUILTIN).text, SRC)
  assert.equal(state.switchProfile, "work")
})

test("switch exclusions preserve edited chains for their layer and lapse on the next watch", t => {
  const h = fixture(t)
  h.policies.setPromo(false)
  h.policies.setSwitchProfile("work")
  const codex = {
    probabilities: { rounded_24h: null, rounded_48h: null }, confidence: null,
    last_reset_at: null, updated_at: null, official_signal: false,
    alert: { kind: "watch", state: "active", at: new Date(NOW).toISOString(), score: null, endsAt: null },
  }
  writeFileSync(h.policies.statePath, JSON.stringify({ ...h.policies.state(), codex }))
  h.apply()
  const key = overlayKey(undefined, "categories", "quick")
  h.policies.exclude([key])
  h.policies.exclude([key])
  assert.deepEqual(h.policies.state().switchExclude, { alert: codex.alert.at, keys: [key] })
  const disk = readFileSync(h.path, "utf8")
  const base = h.policies.base(disk, h.path)
  const edited = applyDrafts(base, [{ section: "categories", name: "quick", chain: ["edited/quick"], disable: null }])
  h.policies.write({ path: h.path, base: edited, current: disk, baseBefore: base, builtin: BUILTIN, backup: false })
  assert.deepEqual(config(h.path)["[native]"].categories.quick.models, ["edited/quick"])
  assert.deepEqual(config(h.path).profiles.work["[native]"].categories.quick.models, ["base/profile"])
  const next = { ...codex, alert: { ...codex.alert, at: new Date(NOW + 1).toISOString() } }
  writeFileSync(h.policies.statePath, JSON.stringify({ ...h.policies.state(), codex: next }))
  h.apply()
  assert.deepEqual(config(h.path)["[native]"].categories.quick.models, ["base/profile"])
  const other = overlayKey("work", "agents", "explore")
  h.policies.exclude([other])
  assert.deepEqual(h.policies.state().switchExclude.keys, [other])
  h.policies.setSwitchProfile(null)
  const before = readFileSync(h.policies.statePath, "utf8")
  h.policies.exclude([key])
  assert.equal(readFileSync(h.policies.statePath, "utf8"), before)
})

test("legacy settings without a switch are accepted and obsolete fields disappear on persist", t => {
  const h = fixture(t)
  const { switchProfile: _switch, ...legacy } = h.policies.state()
  const obsolete = ["codex", "Preferred"].join("")
  writeFileSync(h.policies.statePath, JSON.stringify({ ...legacy, [obsolete]: true }))
  assert.equal(h.policies.state().switchProfile, null)
  h.policies.setPromo(false)
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(h.policies.statePath, "utf8")), obsolete), false)
})

test("the cross-session lock and changed receipt refuse a write rather than replacing newer edits", t => {
  const h = fixture(t)
  const current = readFileSync(h.path, "utf8")
  mkdirSync(`${h.policies.statePath}.lock`)
  assert.throws(() => h.apply())
  assert.equal(readFileSync(h.path, "utf8"), current)
})

test("a pending journal unwraps the correct receipt before and after the config rename", t => {
  const h = fixture(t)
  h.apply()
  const oldDisk = readFileSync(h.path, "utf8")
  const oldBase = h.policies.base(oldDisk, h.path)
  const state = h.policies.state()
  const edited = applyDrafts(oldBase, [{ section: "categories", name: "quick", chain: ["base/new"], disable: null }])
  const pending = composePolicies(edited, { promo: state.promo, overlay: null }, BUILTIN, NOW)
  writeFileSync(h.policies.statePath, JSON.stringify({
    ...state, pending: {
      configPath: h.path, digest: createHash("sha256").update(pending.text).digest("hex"), receipt: pending.receipt,
    },
  }))
  assert.equal(h.policies.base(oldDisk, h.path), oldBase)
  writeFileSync(h.path, pending.text)
  assert.equal(h.policies.base(pending.text, h.path), edited)
})

test("a lock directory left by a crashed process is recovered", t => {
  const h = fixture(t)
  mkdirSync(h.policies.lockPath)
  const old = new Date(Date.now() - 60_000)
  utimesSync(h.policies.lockPath, old, old)
  h.policies.setSwitchProfile("work")
  assert.equal(h.policies.state().switchProfile, "work")
  assert.equal(existsSync(h.policies.lockPath), false)
})

test("a fresh lock directory blocks another session", t => {
  const h = fixture(t)
  mkdirSync(h.policies.lockPath)
  assert.throws(() => h.policies.setSwitchProfile("work"), /another session/)
  assert.equal(h.policies.state().switchProfile, null)
})

test("refresh caches the two sources for a minute and leaves the switch setting off", async t => {
  const requests = []
  const fetcher = async url => {
    requests.push(String(url))
    if (String(url).includes("opengateway")) return new Response(JSON.stringify({
      entries: { deepseek: {
        modelName: "deepseek-v4.1-flash-ultrafast", inputCostPerToken: 10, outputCostPerToken: 10,
        pricing: { current: { effectivePrice: { inputCostPerToken: 1, outputCostPerToken: 1 } } },
      } },
    }), { headers: { "X-Model-Price-Server-Time": new Date(NOW).toISOString() } })
    return new Response(JSON.stringify({
      probabilities: { rounded_24h: 70, rounded_48h: 80 }, confidence: "medium",
      last_reset_at: "2026-10-22T00:00:00Z", updated_at: new Date(NOW).toISOString(), official_signal: null,
    }))
  }
  const h = fixture(t, fetcher)

  // When: two refreshes happen inside one source-cache window.
  await Promise.all([h.policies.refresh(), h.policies.refresh()])

  // Then: each source was fetched only once; prediction never enables switching.
  assert.equal(requests.length, 2)
  assert.equal(h.policies.state().switchProfile, null)
  assert.ok(h.policies.state().codex)
  assert.ok(existsSync(h.policies.statePath))
})

test("source failures retain the cache but cannot enable an expired promotion", async t => {
  const h = fixture(t, async () => { throw new Error("HTTP 503 fixture") })
  const previous = h.policies.state().promo
  await h.policies.refresh()
  assert.deepEqual(h.policies.state().promo, previous)
  assert.equal(h.policies.state().errors.length, 2)
  h.time(NOW + 3_600_000)
  h.apply()
  assert.deepEqual(config(h.path), parseJsonc(SRC))
})

test("an unchanged recomposition rewrites neither the config nor the state file", t => {
  // Given: an applied promotion whose state file was left in another formatting.
  const h = fixture(t)
  h.apply()
  const disk = readFileSync(h.path, "utf8")
  const compact = JSON.stringify(JSON.parse(readFileSync(h.policies.statePath, "utf8")))
  writeFileSync(h.policies.statePath, compact)

  // When: a reloaded session recomposes the same result.
  h.apply()

  // Then: both files are untouched.
  assert.equal(readFileSync(h.path, "utf8"), disk)
  assert.equal(readFileSync(h.policies.statePath, "utf8"), compact)
})

test("a server clock running ahead does not switch the promotion off right after a refresh", async t => {
  // Given: OpenGateway reports 90% off with its clock five seconds ahead of ours.
  const fetcher = async url => String(url).includes("opengateway")
    ? new Response(JSON.stringify({ entries: { deepseek: {
      modelName: "deepseek-v4.1-flash-ultrafast", inputCostPerToken: 10, outputCostPerToken: 10,
      pricing: {
        current: { effectivePrice: { inputCostPerToken: 1, outputCostPerToken: 1 } },
        next: { at: new Date(NOW + 3_600_000).toISOString(), effectivePrice: { inputCostPerToken: 5, outputCostPerToken: 5 } },
      },
    } } }), { headers: { "X-Model-Price-Server-Time": new Date(NOW + 5_000).toISOString() } })
    : new Response(JSON.stringify({ probabilities: { rounded_24h: 10, rounded_48h: 20 } }))
  const h = fixture(t, fetcher)

  // When: the session that refreshed recomposes at once.
  await h.policies.refresh()
  h.apply()

  // Then: the schedule is dated by our clock and the promotion still leads quick.
  assert.equal(h.policies.state().promo.fetchedAt, NOW)
  assert.equal(config(h.path)["[native]"].categories.quick.models[0], `${MODEL}:low`)
})
