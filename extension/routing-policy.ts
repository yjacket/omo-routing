// Temporary routing contributions. Callers edit/snapshot the unwrapped base,
// then compose once; this module never reads or writes the live configuration.
import { isDeepStrictEqual } from "node:util"
import type { PromoSchedule } from "./routing-signals.ts"
import type { BuiltinRouting, JsoncNode } from "./routing.ts"
import {
  applyProfile, chainOf, parseJsonc, parseJsoncTree, profileNames,
  removeJsoncPath, resolveRouting, setJsoncPath, splitSpec,
} from "./routing.ts"

export type { PromoSchedule }
/** The lanes DeepSeek can lead, each with the minimum discount that enables it. */
export const PROMO_LANES = [
  { key: "quick", section: "categories" },
  { key: "explore", section: "agents" },
  { key: "librarian", section: "agents" },
] as const
export type PromoLane = typeof PROMO_LANES[number]["key"]
export type PromoThresholds = Readonly<Record<PromoLane, number | null>>
export const PROMO_THRESHOLDS: PromoThresholds = { quick: 0.9, explore: 0.9, librarian: 0.9 }
/** A known next price keeps a lane past its boundary until the next refresh lands. */
const BOUNDARY_GRACE_MS = 2 * 60_000
const END_GUARD_MS = 15 * 60_000
const EPSILON = 1e-9

export type PolicySettings = {
  readonly promo: PromoSchedule | null
  /** Defaults to PROMO_THRESHOLDS; null turns a lane off. */
  readonly promoLanes?: PromoThresholds
  readonly overlay: { readonly profile: string; readonly exclude: readonly string[] } | null
}
export const overlayKey = (profile: string | undefined, section: string, name: string): string =>
  `${profile ?? ""}\u0000${section}\u0000${name}`
type PolicyChange = {
  readonly path: readonly string[]
  /** Exact JSONC values; null means the member did not exist. */
  readonly before: string | null
  readonly after: string
}
export type PolicyReceipt = { readonly version: 1; readonly changes: readonly PolicyChange[] }

const PROMO = "opengateway/deepseek/deepseek-v4.1-flash-ultrafast:low"
const RESERVED = new Set(["__proto__", "constructor", "prototype"])
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const at = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => object(current) && Object.hasOwn(current, key) ? current[key] : undefined, value)
const nodeAt = (node: JsoncNode | undefined, path: readonly string[]): JsoncNode | undefined =>
  path.reduce<JsoncNode | undefined>((current, key) => current?.members?.find(member => member.key === key)?.value, node)
const harnessOf = (layer: unknown): string | undefined =>
  object(layer) && Object.hasOwn(layer, "[native]") ? "[native]"
    : object(at(layer, ["[senpi]"])) ? "[senpi]"
      : ["categories", "agents", "model_profiles"].some(key => object(at(layer, [key]))) ? undefined : "[native]"

export function emptyPolicyReceipt(): PolicyReceipt { return { version: 1, changes: [] } }

/** Validate the persisted journal at the IO boundary, without trusting casts. */
export function isPolicyReceipt(value: unknown): value is PolicyReceipt {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.changes)) return false
  return value.changes.every((change: unknown) => {
    if (!object(change) || !Array.isArray(change.path) || !change.path.length
      || !change.path.every((key: unknown) => typeof key === "string" && !RESERVED.has(key))
      || !(change.before === null || typeof change.before === "string") || typeof change.after !== "string") return false
    try {
      parseJsonc(change.after)
      if (change.before !== null) parseJsonc(change.before)
      return true
    } catch (error) {
      if (error instanceof SyntaxError) return false
      throw error
    }
  })
}

/** Compare-and-restore, descending through inserted containers when unrelated
 * members changed. A deleted or edited leaf is user-owned and is never restored.
 * In particular, a journal persisted before its writes is harmless to the base.
 */
export function unwrapPolicies(text: string, receipt: PolicyReceipt | undefined): string {
  let out = text
  const restore = (path: readonly string[], before: string | null, after: string): void => {
    const current = nodeAt(parseJsoncTree(out), path)
    if (!current) return
    const fragment = out.slice(current.start, current.end)
    if (fragment === after) {
      out = before === null ? removeJsoncPath(out, [...path])
        : out.slice(0, current.start) + before + out.slice(current.end)
      return
    }
    // Only containers created by us may be partially unwrapped. Existing array
    // edits, including intentional user reorders, win over the old journal.
    const applied = parseJsoncTree(after)
    if (before !== null || current.kind !== "object" || applied.kind !== "object") return
    for (const member of [...(applied.members ?? [])].reverse())
      restore([...path, member.key], null, after.slice(member.value.start, member.value.end))
    const remaining = nodeAt(parseJsoncTree(out), path)
    if (remaining?.members?.length === 0 && /^\{\s*\}$/.test(out.slice(remaining.start, remaining.end)))
      out = removeJsoncPath(out, [...path])
  }
  for (const change of [...(receipt?.changes ?? [])].reverse()) restore(change.path, change.before, change.after)
  return out
}

/** Lanes whose threshold the schedule meets now and, unless the next price
 * keeps it, for more than fifteen minutes. Expired schedules enable nothing,
 * except that a known next price carries a lane briefly past its boundary. */
export function activePromoLanes(promo: PromoSchedule | null, lanes: PromoThresholds = PROMO_THRESHOLDS, now = Date.now()): PromoLane[] {
  if (promo === null || !Number.isFinite(now) || !Number.isFinite(promo.fetchedAt) || promo.fetchedAt > now
    || !(promo.discountNow <= 1) || promo.nextAt === null || !Number.isFinite(promo.nextAt)) return []
  const nextAt = promo.nextAt
  const next = promo.discountNext ?? 0
  return PROMO_LANES.map(lane => lane.key).filter(key => {
    const threshold = lanes[key]
    if (threshold === null || !(threshold > 0)) return false
    const meets = (discount: number): boolean => discount <= 1 && discount + EPSILON >= threshold
    if (now >= nextAt) return now < nextAt + BOUNDARY_GRACE_MS && meets(next)
    return meets(promo.discountNow) && (meets(next) || now < nextAt - END_GUARD_MS)
  })
}

/** Policy is deliberately applied AFTER inheritance for each saved profile.
 * No profile is resolved against another profile's or base's runtime policy.
 * The four arguments are the integration API, with an injectable clock.
 */
export function composePolicies(baseText: string, settings: PolicySettings, builtin: BuiltinRouting, now = Date.now()): {
  text: string; receipt: PolicyReceipt; promoActive: boolean; promoLanes: PromoLane[]; overlayActive: boolean
} {
  const promoLanes = activePromoLanes(settings.promo, settings.promoLanes, now)
  const promoActive = promoLanes.length > 0
  const promotes = (section: string, name: string): boolean =>
    PROMO_LANES.some(lane => lane.section === section && lane.key === name && promoLanes.includes(lane.key))
  if (!promoActive && settings.overlay === null)
    return { text: baseText, receipt: emptyPolicyReceipt(), promoActive, promoLanes, overlayActive: false }
  const raw: unknown = parseJsonc(baseText)
  const overlay = settings.overlay && !RESERVED.has(settings.overlay.profile)
    && object(at(raw, ["profiles", settings.overlay.profile])) ? settings.overlay : null
  const overlayActive = overlay !== null
  if (!promoActive && !overlayActive)
    return { text: baseText, receipt: emptyPolicyReceipt(), promoActive, promoLanes, overlayActive }
  const overlayConfig = overlay ? applyProfile(raw, overlay.profile).config : undefined
  const overlayResolved = overlayConfig ? resolveRouting(overlayConfig, builtin) : undefined
  const overlayLayer = overlay ? at(raw, ["profiles", overlay.profile]) : undefined
  const overlayHarness = harnessOf(overlayLayer)
  const overlayOwn = overlayHarness ? at(overlayLayer, [overlayHarness]) : overlayLayer
  const profiles = [undefined, ...profileNames(raw).filter(name => !RESERVED.has(name) && object(at(raw, ["profiles", name])))]
  const layers = profiles.map(profile => {
    const config: Record<string, unknown> = applyProfile(raw, profile).config
    return { profile, config, resolved: resolveRouting(config, builtin) }
  })
  let text = baseText
  // Each mutation records the smallest existing value or missing ancestor it
  // replaces. Newly created containers can then be unwrapped without backups.
  const changes: PolicyChange[] = []
  const write = (path: string[], value: unknown): void => {
    if (isDeepStrictEqual(at(parseJsonc(text), path), value)) return
    const tree = parseJsoncTree(text)
    let owned = path
    for (let depth = 1; depth < path.length; depth++) {
      const ancestor = nodeAt(tree, path.slice(0, depth))
      if (!ancestor || ancestor.kind !== "object") { owned = path.slice(0, depth); break }
    }
    const previous = nodeAt(tree, owned)
    const before = previous ? text.slice(previous.start, previous.end) : null
    if (previous && owned.length < path.length) text = setJsoncPath(text, owned, {})
    text = setJsoncPath(text, path, value)
    // setJsoncPath preserves surrounding text but serializes the touched value.
    // Keep comments inside a replaced models array as well as its outer style.
    if (previous?.kind === "array" && before !== null) {
      const comments = before.match(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)?.filter(token => token.startsWith("/")) ?? []
      const array = nodeAt(parseJsoncTree(text), path)
      if (comments.length && array?.kind === "array")
        text = `${text.slice(0, array.start + 1)}\n${comments.join("\n")}\n${text.slice(array.start + 1)}`
    }
    const next = nodeAt(parseJsoncTree(text), owned)
    if (next) changes.push({ path: owned, before, after: text.slice(next.start, next.end) })
  }
  for (const { profile, config, resolved } of layers) {
    const prefix = profile === undefined ? [] : ["profiles", profile]
    const layer = at(raw, prefix)
    const harness = harnessOf(layer)
    const target = [...prefix, ...(harness ? [harness] : [])]
    for (const section of ["categories", "agents"] as const) {
      const names = new Set(Object.keys(resolved.config[section]))
      if (overlayActive) for (const name of Object.keys(object(at(overlayOwn, [section])) ? at(overlayOwn, [section]) as Record<string, unknown> : {})) names.add(name)
      for (const lane of PROMO_LANES) if (lane.section === section && promoLanes.includes(lane.key)) names.add(lane.key)
      for (const name of names) {
        if (RESERVED.has(name) || resolved.sources[section][name] === "disabled") continue
        const ownChain: string[] = resolved.config[section][name]?.models ?? []
        const overlaid = overlay !== null && overlayResolved !== undefined && profile !== overlay.profile
          && !overlay.exclude.includes(overlayKey(profile, section, name))
          && object(at(overlayOwn, [section])) && Object.hasOwn(at(overlayOwn, [section]) as object, name)
          && overlayResolved.sources[section][name] !== "disabled"
        const chain: string[] = overlaid ? overlayResolved.config[section][name]?.models ?? [] : ownChain
        const reordered = promotes(section, name) ? [PROMO, ...chain] : chain
        // A chain the policy rewrites is pinned into the config: drop the exact
        // repeats OMO's builtin resolution yields (primary, then fallbacks led by it).
        const wanted = isDeepStrictEqual(reordered, ownChain) ? ownChain : [...new Set(reordered)]
        const current = resolveRouting(applyProfile(parseJsonc(text), profile).config, builtin)
        const actual: string[] = current.config[section][name]?.models ?? []
        if (isDeepStrictEqual(actual, wanted)) continue
        // Reuse configured object rungs (including their metadata). Only builtin
        // or string agent rungs need encoding into OMO's model/variant format.
        const entry = at(overlaid ? overlayConfig : config, [section, name])
        const models = at(entry, ["models"])
        const fallbacks = at(entry, ["fallback_models"])
        const existing = [at(entry, ["model"]), ...(Array.isArray(models) ? models : []),
          ...(Array.isArray(fallbacks) ? fallbacks : typeof fallbacks === "string" ? [fallbacks] : [])]
        const encoded = wanted.map(spec => {
          const saved = existing.find(rung => chainOf({ models: [rung] })[0] === spec)
          if (object(saved) || (typeof saved === "string" && section !== "agents")) return saved
          const parsed = splitSpec(spec)
          return section === "agents" && parsed?.effort
            ? { model: `${spec.slice(0, spec.indexOf("/"))}/${parsed.model}`, variant: parsed.effort } : spec
        })
        // Agent model has precedence over models, including an inherited model.
        // Null shadows that primary without deleting any author's other fields.
        if (section === "agents" && at(applyProfile(parseJsonc(text), profile).config, [section, name, "model"]) != null)
          write([...target, section, name, "model"], null)
        write([...target, section, name, "models"], encoded)
      }
    }
  }
  return { text, receipt: { version: 1, changes }, promoActive, promoLanes, overlayActive }
}
