import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { RoutingPolicies } from "../extension/routing-runtime.ts"
import { applyDrafts, applyProfile, parseJsonc, saveConfig } from "../extension/routing.ts"
import { composePolicies } from "../extension/routing-policy.ts"
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
  const policies = new RoutingPolicies(home, { now: () => now, ...(fetcher ? { fetcher } : {}) })
  writeFileSync(policies.statePath, JSON.stringify({
    version: 1, promoEnabled: true, codexPreferred: false, codex: null, errors: [], checkedAt: 0,
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

test("Codex is manual, changes only existing task candidates, and can be removed without restoring an old file", t => {
  const h = fixture(t)
  h.policies.set("promo", false)

  // When: Codex preference is explicitly enabled and then disabled.
  h.policies.set("codex", true)
  h.apply()
  assert.deepEqual(config(h.path)["[native]"].categories.deep.models, ["chatgpt-subscription/gpt-big:high", "other/large"])
  h.policies.set("codex", false)
  h.apply()

  // Then: the authored order and whole base config are unchanged.
  assert.deepEqual(config(h.path), parseJsonc(SRC))
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
  const pending = composePolicies(edited, { promo: state.promo, codex: false }, BUILTIN, NOW)
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
  h.policies.set("codex", true)
  assert.equal(h.policies.state().codexPreferred, true)
  assert.equal(existsSync(h.policies.lockPath), false)
})

test("a fresh lock directory blocks another session", t => {
  const h = fixture(t)
  mkdirSync(h.policies.lockPath)
  assert.throws(() => h.policies.set("codex", true), /another session/)
  assert.equal(h.policies.state().codexPreferred, false)
})

test("refresh caches the two sources for a minute and never enables manual Codex on a public signal", async t => {
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

  // Then: each source was fetched only once; prediction never activates Codex.
  assert.equal(requests.length, 2)
  assert.equal(h.policies.state().codexPreferred, false)
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
