import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { composePolicies, isPolicyReceipt, unwrapPolicies } from "./routing-policy.ts"
import type { PolicyReceipt, PromoSchedule } from "./routing-policy.ts"
import { fetchCodexSignal, fetchPromoSchedule, isCodexSignal, signalStatus } from "./routing-signals.ts"
import type { CodexSignal } from "./routing-signals.ts"
import type { BuiltinRouting } from "./routing.ts"

type PolicyState = {
  readonly version: 1
  readonly promoEnabled: boolean
  readonly codexPreferred: boolean
  readonly promo: PromoSchedule | null
  readonly codex: CodexSignal | null
  readonly checkedAt: number
  readonly errors: readonly string[]
  readonly configPath?: string
  readonly receipt?: PolicyReceipt
  readonly pending?: { readonly configPath: string; readonly digest: string; readonly receipt: PolicyReceipt }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const nullableNumber = (value: unknown): value is number | null => value === null || finite(value)
const schedule = (value: unknown): value is PromoSchedule => record(value)
  && finite(value.fetchedAt) && finite(value.discountNow) && nullableNumber(value.nextAt) && nullableNumber(value.discountNext)
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"
const initial = (): PolicyState => ({
  version: 1, promoEnabled: true, codexPreferred: false, promo: null, codex: null, checkedAt: 0, errors: [],
})
const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

function atomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, "utf8")
  renameSync(temp, path)
}

/** The JSONC file holds effective chains; the receipt remembers only policy
 * contributions, never a complete old configuration to restore over edits. */
export class RoutingPolicies {
  readonly statePath: string
  private readonly lockPath: string
  private readonly home: string
  private readonly now: () => number
  private readonly fetcher: typeof fetch

  constructor(home: string, options: { readonly now?: () => number; readonly fetcher?: typeof fetch } = {}) {
    this.home = home
    this.statePath = join(home, ".omo", "routing-policies.json")
    this.lockPath = `${this.statePath}.lock`
    this.now = options.now ?? Date.now
    this.fetcher = options.fetcher ?? fetch
  }

  state(): PolicyState {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.statePath, "utf8"))
    } catch (error) {
      if (!missing(error)) throw error
      return initial()
    }
    if (!record(value) || value.version !== 1 || typeof value.promoEnabled !== "boolean"
      || typeof value.codexPreferred !== "boolean" || !(value.promo === null || schedule(value.promo))
      || !finite(value.checkedAt) || !Array.isArray(value.errors) || !value.errors.every(e => typeof e === "string")
      || !(value.configPath === undefined || typeof value.configPath === "string")
      || !(value.receipt === undefined || isPolicyReceipt(value.receipt))
      || !(value.pending === undefined || (record(value.pending) && typeof value.pending.configPath === "string"
        && typeof value.pending.digest === "string" && isPolicyReceipt(value.pending.receipt)))) {
      throw new Error(`cannot read policy state: ${this.statePath}`)
    }
    if (!(value.codex === null || isCodexSignal(value.codex)))
      throw new Error(`cannot read Codex signal: ${this.statePath}`)
    const codex = value.codex
    return {
      version: 1, promoEnabled: value.promoEnabled, codexPreferred: value.codexPreferred,
      promo: value.promo, codex, checkedAt: value.checkedAt, errors: value.errors,
      ...(value.configPath === undefined ? {} : { configPath: value.configPath }),
      ...(value.receipt === undefined ? {} : { receipt: value.receipt }),
      ...(record(value.pending) && typeof value.pending.configPath === "string" && typeof value.pending.digest === "string"
        && isPolicyReceipt(value.pending.receipt)
        ? { pending: { configPath: value.pending.configPath, digest: value.pending.digest, receipt: value.pending.receipt } } : {}),
    }
  }

  private locked<T>(action: () => T): T {
    mkdirSync(dirname(this.statePath), { recursive: true })
    try {
      mkdirSync(this.lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // A crashed process leaves its lock directory behind; mtimes are wall clock.
      if (Date.now() - statSync(this.lockPath).mtimeMs <= 30_000)
        throw new Error("routing policies are being saved by another session; try again")
      rmdirSync(this.lockPath)
      mkdirSync(this.lockPath)
    }
    try { return action() } finally { rmdirSync(this.lockPath) }
  }

  private persist(state: PolicyState): void {
    atomic(this.statePath, JSON.stringify(state, null, 2) + "\n")
  }

  base(text: string, path: string): string {
    const state = this.state()
    if (state.pending?.configPath === path && state.pending.digest === digest(text))
      return unwrapPolicies(text, state.pending.receipt)
    return unwrapPolicies(text, state.configPath === path ? state.receipt : undefined)
  }

  preview(base: string, builtin: BuiltinRouting) {
    const state = this.state()
    return composePolicies(base, { promo: state.promoEnabled ? state.promo : null, codex: state.codexPreferred }, builtin, this.now())
  }

  /** Compare the file and receipt again under a cross-session lock. Publish the
   * receipt first: an interrupted config write remains safely reversible. */
  write(options: {
    readonly path: string
    readonly base: string
    readonly current?: string
    readonly baseBefore: string
    readonly builtin: BuiltinRouting
    readonly backup: boolean
  }): string {
    return this.locked(() => {
      const disk = existsSync(options.path) ? readFileSync(options.path, "utf8") : undefined
      if (disk !== options.current || (disk !== undefined && this.base(disk, options.path) !== options.baseBefore))
        throw new Error("omo.jsonc or routing policies changed during the save; try again")
      const state = this.state()
      const result = composePolicies(options.base, { promo: state.promoEnabled ? state.promo : null, codex: state.codexPreferred }, options.builtin, this.now())
      if (options.backup && disk !== undefined) copyFileSync(options.path, `${options.path}.bak`)
      this.persist({ ...state, pending: { configPath: options.path, digest: digest(result.text), receipt: result.receipt } })
      if (disk !== result.text) {
        mkdirSync(dirname(options.path), { recursive: true })
        atomic(options.path, result.text)
      }
      const { pending: _pending, ...committed } = state
      this.persist({ ...committed, configPath: options.path, receipt: result.receipt })
      return result.text
    })
  }

  set(name: "promo" | "codex", on: boolean): void {
    this.locked(() => {
      const state = this.state()
      this.persist({ ...state, ...(name === "promo" ? { promoEnabled: on } : { codexPreferred: on }) })
    })
  }

  /** A manual refresh still honours the source's one-minute cache contract.
   * Failures keep the old schedule, whose own expiry remains authoritative. */
  async refresh(): Promise<void> {
    const claimed = this.locked(() => {
      const state = this.state()
      if (this.now() - state.checkedAt < 60_000) return false
      this.persist({ ...state, checkedAt: this.now() })
      return true
    })
    if (!claimed) return
    const results = await Promise.allSettled([fetchPromoSchedule(this.fetcher), fetchCodexSignal(this.fetcher)])
    this.locked(() => {
      const state = this.state()
      const promo = results[0]
      const codex = results[1]
      const errors = results.flatMap((result, index) => result.status === "rejected"
        ? [`${index === 0 ? "OpenGateway" : "Codex Reset"}: ${errorText(result.reason)}`] : [])
      this.persist({
        ...state, checkedAt: this.now(), errors,
        promo: promo.status === "fulfilled" ? promo.value : state.promo,
        codex: codex.status === "fulfilled" ? codex.value : state.codex,
      })
    })
  }

  status(): string | undefined {
    const state = this.state()
    return signalStatus(state.promo, state.codex, state.codexPreferred, this.now())
  }

  details(): string {
    const state = this.state()
    const codex = state.codex
    const lines = [this.summary(), this.status() ?? "신호 없음"]
    if (codex) {
      const confidence: Record<string, string> = { low: "낮음", medium: "중간", high: "높음" }
      lines.push(`Codex 리셋 예측: 24h ${codex.probabilities.rounded_24h ?? "?"}% · 48h ${codex.probabilities.rounded_48h ?? "?"}%`)
      lines.push(`신뢰 ${confidence[codex.confidence ?? ""] ?? "미상"} · 최근 리셋 ${codex.last_reset_at?.slice(0, 10) ?? "미상"}${codex.official_signal ? " · 공식 신호 있음" : ""}`)
      lines.push("출처: codex-reset.com · 개인 잔여량이 아닙니다")
    }
    lines.push("/routing refresh · /routing promo on|off · /routing codex on|off", ...state.errors)
    return lines.join("\n")
  }

  summary(): string {
    const state = this.state()
    return `임시 정책: 할인 ${state.promoEnabled ? "자동" : "끔"} · Codex 선호 ${state.codexPreferred ? "켬" : "끔"}`
  }
}
