// Public HTTP response fixtures and branch state only. No network or live OMO.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fetchPromoSchedule, fetchCodexSignal, isCodexSignal, signalStatus, promoMessage,
  nudge, END, POLICY_MESSAGE_TYPE,
} from "../extension/routing-signals.ts"

const NOW = Date.parse("2026-10-23T12:00:00Z")
const ISO = new Date(NOW).toISOString()
const MODEL = "deepseek-v4.1-flash-ultrafast"
const AGENT = "omo-routing/0.1 (+https://github.com/yjacket/omo-routing)"
const price = (inputCostPerToken, outputCostPerToken) => ({ inputCostPerToken, outputCostPerToken })
const entry = () => ({
  modelName: MODEL,
  ...price(10, 20),
  pricing: {
    current: { effectivePrice: price(1, 4) },
    next: { at: new Date(NOW + 90 * 60_000).toISOString(), effectivePrice: price(5, 5) },
  },
})
const forecast = () => ({
  probabilities: { rounded_24h: 32, rounded_48h: 53, raw_24h: 0.32 },
  confidence: "low",
  last_reset_at: "2026-10-22T17:10:01.000Z",
  updated_at: ISO,
  official_signal: { summary: "fixture", private_classifier: 93 },
  ignored: { account_quota: 100 },
})
const response = (body, headers = {}) => Response.json(body, { headers })
const branchEntry = message => ({ type: "custom_message", ...message })
const tokens = text => text?.match(/\d+%|~\d+h(?: \d+m)?|~\d+m|24h|48h/g)

test("promo fetch accepts wrapped and legacy entries, minimum input/output discount and the local clock", async () => {
  for (const wrapped of [false, true]) {
    let calls = 0
    const entries = { unrelated: { modelName: "other" }, target: entry() }
    const result = await fetchPromoSchedule(async (url, init) => {
      calls++
      assert.equal(url, "https://opengateway.ai/api/model-prices")
      assert.equal(init.headers["User-Agent"], AGENT)
      assert.ok(init.signal instanceof AbortSignal)
      // A server clock running ahead must not date the schedule into the future.
      return response(wrapped ? { entries, priceVersion: 1 } : entries, { "X-Model-Price-Server-Time": new Date(NOW + 5_000).toISOString() })
    }, () => NOW)
    assert.equal(calls, 1)
    assert.deepEqual(result, {
      fetchedAt: NOW, discountNow: 0.8, nextAt: NOW + 90 * 60_000, discountNext: 0.5,
    })
  }
})

test("promo fetch handles absent schedules, invalid timestamps and incomplete effective prices", async () => {
  const item = entry()
  item.pricing = { current: { effectivePrice: price(0, undefined) }, next: { at: "invalid" } }
  const started = Date.now()
  const result = await fetchPromoSchedule(async () => response([item]))
  assert.ok(result.fetchedAt >= started && result.fetchedAt <= Date.now())
  assert.deepEqual({ ...result, fetchedAt: 0 }, {
    fetchedAt: 0, discountNow: 0, nextAt: null, discountNext: 0,
  })
  delete item.pricing
  assert.deepEqual({ ...await fetchPromoSchedule(async () => response({ entries: [item] })), fetchedAt: 0 }, {
    fetchedAt: 0, discountNow: 0, nextAt: null, discountNext: null,
  })
})

test("Codex keeps only displayed documented fields and percentages, not raw model/account data", async () => {
  let calls = 0
  const signal = await fetchCodexSignal(async (url, init) => {
    calls++
    assert.equal(url, "https://codex-reset.com/api/forecast")
    assert.equal(init.headers["User-Agent"], AGENT)
    assert.ok(init.signal instanceof AbortSignal)
    return response(forecast())
  })
  assert.equal(calls, 1)
  assert.deepEqual(signal, {
    probabilities: { rounded_24h: 32, rounded_48h: 53 },
    confidence: "low", last_reset_at: "2026-10-22T17:10:01.000Z",
    updated_at: ISO, official_signal: true,
  })
  assert.deepEqual(await fetchCodexSignal(async () => response({ probabilities: {} })), {
    probabilities: { rounded_24h: null, rounded_48h: null },
    confidence: null, last_reset_at: null, updated_at: null, official_signal: false,
  })
  const zero = forecast()
  zero.probabilities = { rounded_24h: 0, rounded_48h: 100 }
  zero.official_signal = null
  assert.deepEqual((await fetchCodexSignal(async () => response(zero))).probabilities, zero.probabilities)
})

test("fetch failures reject without retries or replacing cached data", async () => {
  for (const fetcher of [fetchPromoSchedule, fetchCodexSignal]) {
    for (const makeResponse of [
      () => new Response("unavailable", { status: 503 }),
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "60" } }),
      () => new Response("not json", { status: 200 }),
    ]) {
      let calls = 0
      await assert.rejects(fetcher(async () => { calls++; return makeResponse() }))
      assert.equal(calls, 1)
    }
    const error = new Error("offline")
    await assert.rejects(fetcher(async () => { throw error }), value => value === error)
  }
  await assert.rejects(fetchPromoSchedule(async () => response({ entries: [] })))
  await assert.rejects(fetchCodexSignal(async () => response({})))
  for (const value of [-1, 101, "32"]) {
    const body = forecast()
    body.probabilities.rounded_24h = value
    await assert.rejects(fetchCodexSignal(async () => response(body)))
  }
  for (const [key, value] of [["updated_at", "invalid"], ["last_reset_at", 123], ["confidence", {}], ["official_signal", true]]) {
    await assert.rejects(fetchCodexSignal(async () => response({ ...forecast(), [key]: value })))
  }
})

test("persisted decoder validates all normalized fields without throwing on unknown state", async () => {
  const valid = await fetchCodexSignal(async () => response(forecast()))
  assert.equal(isCodexSignal(valid), true)
  assert.equal(isCodexSignal(JSON.parse(JSON.stringify(valid))), true)
  assert.equal(isCodexSignal({
    probabilities: { rounded_24h: null, rounded_48h: null },
    confidence: null, last_reset_at: null, updated_at: null, official_signal: false,
  }), true)
  for (const value of [null, undefined, 0, "", [], {}, forecast()]) {
    assert.equal(isCodexSignal(value), false)
  }
  for (const key of Object.keys(valid)) {
    const incomplete = { ...valid }
    delete incomplete[key]
    assert.equal(isCodexSignal(incomplete), false)
  }
  for (const value of [NaN, Infinity, -1, 101, "32", undefined]) {
    assert.equal(isCodexSignal({ ...valid, probabilities: { ...valid.probabilities, rounded_24h: value } }), false)
    assert.equal(isCodexSignal({ ...valid, probabilities: { ...valid.probabilities, rounded_48h: value } }), false)
  }
  for (const [key, value] of [
    ["probabilities", []], ["confidence", 1], ["updated_at", "invalid"],
    ["last_reset_at", 1], ["official_signal", {}],
  ]) assert.equal(isCodexSignal({ ...valid, [key]: value }), false)
})

test("both HTTP fetches use a bounded abort signal through response-body consumption", async t => {
  const controllers = []
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    assert.equal(milliseconds, 15_000)
    const controller = new AbortController()
    controllers.push(controller)
    return controller.signal
  })
  for (const fetcher of [fetchPromoSchedule, fetchCodexSignal]) {
    await assert.rejects(fetcher(async (_url, init) => {
      const body = new ReadableStream({
        start(stream) {
          init.signal.addEventListener("abort", () => stream.error(init.signal.reason), { once: true })
        },
      })
      const res = new Response(body)
      controllers.at(-1).abort(new DOMException("fixture abort", "AbortError"))
      return res
    }), { name: "AbortError" })
  }
  assert.equal(controllers.length, 2)
})

test("promo footer keeps discount switch and minute/hour countdown boundaries", () => {
  const promo = { fetchedAt: NOW, discountNow: 0.9, nextAt: NOW + 90 * 60_000, discountNext: 0.5 }
  assert.deepEqual(tokens(signalStatus(promo, null, false, NOW)), ["90%", "~1h 30m"])
  assert.deepEqual(tokens(signalStatus({ ...promo, nextAt: NOW + 59 * 60_000 }, null, false, NOW)), ["90%", "~59m"])
  assert.deepEqual(tokens(signalStatus({ ...promo, nextAt: NOW + 25 * 3_600_000 }, null, false, NOW)), ["90%", "~25h"])
  assert.deepEqual(tokens(signalStatus({ ...promo, nextAt: NOW + 1 }, null, false, NOW)), ["90%", "~0m"])
  assert.deepEqual(tokens(signalStatus(promo, null, false, promo.nextAt)), ["50%"])
  assert.deepEqual(tokens(signalStatus({ ...promo, nextAt: null }, null, false, NOW)), ["90%"])
  assert.equal(signalStatus({ ...promo, discountNow: 0 }, null, false, NOW), undefined)
  assert.equal(signalStatus({ ...promo, discountNext: null }, null, false, promo.nextAt), undefined)
  assert.equal(signalStatus(null, null, false, NOW), undefined)
})

test("compact Codex footer exposes forecast tokens and differentiates stale, unknown and preference", async () => {
  const signal = await fetchCodexSignal(async () => response(forecast()))
  const current = signalStatus(null, signal, false, NOW)
  assert.deepEqual(tokens(current), ["24h", "32%"])
  assert.notEqual(current, signalStatus(null, signal, true, NOW))
  assert.notEqual(current, signalStatus(null, { ...signal, updated_at: new Date(NOW - 300_001).toISOString() }, false, NOW))
  assert.notEqual(current, signalStatus(null, { ...signal, updated_at: null }, false, NOW))
  assert.ok(signalStatus(null, null, true, NOW))
  const unknown = { ...signal, probabilities: { rounded_24h: null, rounded_48h: null } }
  assert.deepEqual(tokens(signalStatus(null, unknown, false, NOW)), ["24h"])
  const promo = { fetchedAt: NOW, discountNow: 0.9, nextAt: null, discountNext: null }
  assert.notEqual(signalStatus(promo, null, false, NOW), signalStatus({ ...promo, fetchedAt: NOW - 300_001 }, null, false, NOW))
  assert.deepEqual(tokens(signalStatus(promo, signal, true, NOW)), ["90%", "24h", "32%"])
})

test("hidden messages emit once per window, reemit after compaction and retract once", () => {
  const first = promoMessage(true, 10, [], "fixture")
  assert.deepEqual(first, { customType: "routing-policy", content: "fixture", display: false, details: { on: true, window: 10 } })
  assert.equal(POLICY_MESSAGE_TYPE, first.customType)
  const branch = [branchEntry(first)]
  assert.equal(promoMessage(true, 10, branch), undefined)
  assert.equal(promoMessage(true, 11, branch, "next").details.window, 11)
  assert.equal(promoMessage(true, 10, [...branch, { type: "compaction" }], "again").content, "again")
  assert.equal(promoMessage(true, 10, [{ type: "compaction" }, ...branch]), undefined)
  const end = promoMessage(false, null, branch)
  assert.deepEqual(end, { customType: "routing-policy", content: END, display: false, details: { on: false } })
  assert.equal(promoMessage(false, null, [...branch, branchEntry(end)]), undefined)
  assert.equal(promoMessage(false, null, []), undefined)
  const indefinite = promoMessage(true, null, [], "fixture")
  assert.equal(promoMessage(true, null, [branchEntry(indefinite)]), undefined)
  assert.deepEqual(promoMessage(true, 10, Object.freeze([null, 1, {}, branchEntry(first)])), undefined)
})

test("policy messages stay chronological within and across promo windows", () => {
  const first = branchEntry(promoMessage(true, 10, [], "fixture"))
  assert.equal(promoMessage(true, 10, [first]), undefined)
  const end = branchEntry(promoMessage(false, null, [first]))
  assert.equal(end.content, END)
  assert.equal(promoMessage(true, 11, [first, end], "next").details.window, 11)
})

test("nudge keeps machine tokens and points to the installed skill only when it exists", t => {
  assert.ok(nudge({}).startsWith("<routing-promo-nudge>"))
  assert.ok(nudge({}).endsWith("</routing-promo-nudge>"))
  assert.ok(END.startsWith("<routing-promo-end>"))
  const dir = mkdtempSync(join(tmpdir(), "routing-signals-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const skill = join(dir, "plugin", "skills", "mass-ulw", "SKILL.md")
  const env = { OMO_BIN: join(dir, "bin", "omo.js") }
  assert.equal(nudge(env).includes(skill), false)
  mkdirSync(join(dir, "plugin", "skills", "mass-ulw"), { recursive: true })
  writeFileSync(skill, "# fixture")
  assert.equal(nudge(env).includes(skill), true)
})
