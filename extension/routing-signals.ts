// Read-only public signals and hidden prompt notices. The caller owns caching,
// refresh scheduling (at most once per minute), and the footer status key.
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

export type PromoSchedule = {
  readonly fetchedAt: number
  readonly discountNow: number
  readonly nextAt: number | null
  readonly discountNext: number | null
}

/** Only displayed fields from codex-reset.com's documented /api/forecast.
 * Probabilities are percentages, not fractions, confirmed resets or personal quota.
 * Dates are ISO timestamps or null; official_signal records presence only.
 * No classifier internals, raw probabilities, posts or account data are retained. */
export type CodexSignal = {
  readonly probabilities: { readonly rounded_24h: number | null; readonly rounded_48h: number | null }
  readonly confidence: string | null
  readonly last_reset_at: string | null
  readonly updated_at: string | null
  readonly official_signal: boolean
  /** Absent in caches written before alerts were read; treated as null. */
  readonly alert?: CodexAlert | null
}

/** The documented `latest_alert`: a ⚠️ Watch (Tibo hinted at a reset; `score` is
 * the site's 83/93 tier, `endsAt` its deadline) or a ✅ Reset. `at` is when the
 * reset was observed, else when the source was posted. */
export type CodexAlert = {
  readonly kind: "watch" | "reset"
  readonly state: "active" | "expired" | "confirmed"
  readonly at: string
  readonly score: number | null
  readonly endsAt: string | null
}

const USER_AGENT = "omo-routing/0.1 (+https://github.com/yjacket/omo-routing)"
const STALE_MS = 5 * 60_000
const DAY_MS = 24 * 3_600_000
export const POLICY_MESSAGE_TYPE = "routing-policy"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const record = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined

/** Validate persisted normalized display data, not a raw /api/forecast response. */
export function isCodexSignal(value: unknown): value is CodexSignal {
  const data = record(value)
  const probabilities = record(data?.probabilities)
  const odds = (value: unknown): boolean => value === null
    || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
  const date = (value: unknown): boolean => value === null
    || (typeof value === "string" && Number.isFinite(Date.parse(value)))
  const alert = record(data?.alert)
  const alertOk = data?.alert === undefined || data.alert === null || (!!alert
    && (alert.kind === "watch" || alert.kind === "reset")
    && (alert.state === "active" || alert.state === "expired" || alert.state === "confirmed")
    && typeof alert.at === "string" && date(alert.at) && odds(alert.score) && date(alert.endsAt))
  return !!data && !!probabilities
    && odds(probabilities.rounded_24h) && odds(probabilities.rounded_48h)
    && (data.confidence === null || typeof data.confidence === "string")
    && date(data.last_reset_at) && date(data.updated_at)
    && typeof data.official_signal === "boolean" && alertOk
}

async function fetchJson(url: string, fetcher: typeof fetch): Promise<{ body: unknown; response: Response }> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": USER_AGENT },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  const body: unknown = await response.json()
  return { body, response }
}

/** The smaller input/output discount against the list price. */
function discountOf(entry: Record<string, unknown>, price: unknown): number {
  const effective = record(price)
  const pairs = [
    [entry.inputCostPerToken, effective?.inputCostPerToken],
    [entry.outputCostPerToken, effective?.outputCostPerToken],
  ]
  let discount = Infinity
  for (const [list, value] of pairs) {
    if (typeof list !== "number" || !Number.isFinite(list) || list <= 0
      || typeof value !== "number" || !Number.isFinite(value)) return 0
    discount = Math.min(discount, 1 - value / list)
  }
  return discount
}

/** One bounded GET, no retries; failures leave retention of prior data to the caller.
 * `fetchedAt` is this machine's clock, the one the policy compares it with: a
 * server clock running ahead must not make a fresh schedule look future-dated. */
export async function fetchPromoSchedule(fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<PromoSchedule> {
  const { body } = await fetchJson("https://opengateway.ai/api/model-prices", fetcher)
  const envelope = record(body)
  const entries = envelope?.entries ?? body
  if (entries === null || typeof entries !== "object") throw new Error("Invalid OpenGateway price list")
  const entry = Object.values(entries).map(record)
    .find(value => value?.modelName === "deepseek-v4.1-flash-ultrafast")
  if (!entry) throw new Error("deepseek-v4.1-flash-ultrafast is not in the price list")
  const pricing = record(entry.pricing)
  const current = record(pricing?.current)
  const next = record(pricing?.next)
  const nextAt = typeof next?.at === "string" ? Date.parse(next.at) : NaN
  return {
    fetchedAt: now(),
    discountNow: discountOf(entry, current?.effectivePrice),
    nextAt: Number.isFinite(nextAt) ? nextAt : null,
    discountNext: next ? discountOf(entry, next.effectivePrice) : null,
  }
}

function probability(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("Invalid Codex forecast probability")
  }
  return value
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Invalid Codex forecast timestamp")
  }
  return value
}

function alertOf(value: unknown): CodexAlert | null {
  if (value === null || value === undefined) return null
  const alert = record(value)
  if (!alert || (alert.kind !== "watch" && alert.kind !== "reset")
    || (alert.state !== "active" && alert.state !== "expired" && alert.state !== "confirmed")
    || (alert.window != null && !record(alert.window))) throw new Error("Invalid Codex alert")
  const at = timestamp(alert.observed_at) ?? timestamp(alert.source_at)
  if (at === null) throw new Error("Invalid Codex alert")
  return { kind: alert.kind, state: alert.state, at, score: probability(alert.score), endsAt: timestamp(record(alert.window)?.end_at) }
}

/** Public reset forecasts only. Call no more than once per minute.
 * https://codex-reset.com/developers/ is the primary contract. */
export async function fetchCodexSignal(fetcher: typeof fetch = fetch): Promise<CodexSignal> {
  const { body } = await fetchJson("https://codex-reset.com/api/forecast", fetcher)
  const data = record(body)
  const probabilities = record(data?.probabilities)
  if (!data || !probabilities) throw new Error("Invalid Codex forecast")
  if (data.confidence != null && typeof data.confidence !== "string") throw new Error("Invalid Codex confidence")
  if (data.official_signal != null && !record(data.official_signal)) throw new Error("Invalid Codex official signal")
  return {
    probabilities: {
      rounded_24h: probability(probabilities.rounded_24h),
      rounded_48h: probability(probabilities.rounded_48h),
    },
    confidence: typeof data.confidence === "string" ? data.confidence : null,
    last_reset_at: timestamp(data.last_reset_at),
    updated_at: timestamp(data.updated_at),
    official_signal: data.official_signal != null,
    alert: alertOf(data.latest_alert),
  }
}

const span = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours >= 24 ? `${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** The Codex part of the footer: only Tibo-based alerts, an active watch with
 * its deadline or a reset confirmed within a day. The forecast stays in details. */
function codexStatus(codex: CodexSignal | null, now: number): string | undefined {
  const alert = codex?.alert ?? null
  let text: string | undefined
  if (alert?.kind === "watch" && alert.state === "active") {
    const ends = alert.endsAt === null ? NaN : Date.parse(alert.endsAt)
    text = `리셋 임박${alert.score === null ? "" : ` ${alert.score}%`}${ends > now ? ` ~${span(ends - now)}` : ""}`
  } else if (alert?.kind === "reset" && alert.state === "confirmed" && now - Date.parse(alert.at) < DAY_MS) {
    text = `리셋됨 ${span(Math.max(0, now - Date.parse(alert.at)))} 전`
  }
  if (text && (!codex?.updated_at || now - Date.parse(codex.updated_at) > STALE_MS)) text += " (오래됨)"
  return text
}

/** Footer only: stale data stays visibly stale, never an account quota or reset guarantee. */
export function signalStatus(
  promo: PromoSchedule | null,
  codex: CodexSignal | null,
  switching: string | null,
  now = Date.now(),
): string | undefined {
  const parts: string[] = []
  if (promo) {
    const changed = promo.nextAt !== null && promo.nextAt <= now
    const percent = Math.round(((changed ? promo.discountNext : promo.discountNow) ?? 0) * 100)
    if (percent > 0) {
      let text = `deepseek ${percent}%`
      if (promo.nextAt !== null && !changed) text += ` ~${span(promo.nextAt - now)}`
      if (changed || now - promo.fetchedAt > STALE_MS) text += " (오래됨)"
      parts.push(text)
    }
  }
  const codexText = codexStatus(codex, now)
  if (codexText || switching !== null)
    parts.push(`Codex ${codexText ?? "전환"}${switching === null ? "" : ` → ${switching}`}`)
  return parts.length ? parts.join(" | ") : undefined
}

/** Hidden typed-prompt hint naming the installed mass-ulw SKILL.md when it exists. */
export function nudge(env: Record<string, string | undefined> = process.env): string {
  const path = env.OMO_BIN ? join(dirname(env.OMO_BIN), "..", "plugin", "skills", "mass-ulw", "SKILL.md") : undefined
  const skill = path && existsSync(path) ? path : undefined
  const read = skill ? ` (read ${skill} with the read tool first and follow it)` : " (read the mass-ulw skill first and follow it)"
  return `<routing-promo-nudge>
Until a routing-promo-end note, category quick and the explore/librarian agents run on a 90%-off model; other categories and your own direct work cost as usual. For non-trivial code work: plan with many parallel explore/librarian searches; implement through mass-ulw workflows${read}, split into as many self-contained quick lanes (named files, steps, success check) as the work safely allows. Route a lane above quick only with a one-line reason.
</routing-promo-nudge>`
}

export const END = "<routing-promo-end>The discount is over: disregard the earlier routing-promo-nudge.</routing-promo-end>"

export type PolicyMessage = {
  customType: typeof POLICY_MESSAGE_TYPE
  content: string
  display: false
  details: { on: true; window: number | null } | { on: false }
}

/** Once per window, again after compaction, and one END after disabling. */
export function promoMessage(
  on: boolean,
  window: number | null,
  branch: readonly unknown[],
  content = nudge(),
): PolicyMessage | undefined {
  const at = branch.findLastIndex(value => {
    const entry = record(value)
    return entry?.type === "custom_message" && entry.customType === POLICY_MESSAGE_TYPE
  })
  const last = at >= 0 ? record(branch[at]) : undefined
  const details = record(last?.details)
  const lastOn = last !== undefined && details?.on !== false
  if (on) {
    const compacted = branch.findLastIndex(value => record(value)?.type === "compaction") > at
    if (lastOn && details?.window === window && !compacted) return undefined
    return { customType: POLICY_MESSAGE_TYPE, content, display: false, details: { on: true, window } }
  }
  return lastOn ? { customType: POLICY_MESSAGE_TYPE, content: END, display: false, details: { on: false } } : undefined
}
