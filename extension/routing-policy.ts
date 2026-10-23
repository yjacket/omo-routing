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
export type PolicySettings = { readonly promo: PromoSchedule | null; readonly codex: boolean }
type PolicyChange = {
  readonly path: readonly string[]
  /** Exact JSONC values; null means the member did not exist. */
  readonly before: string | null
  readonly after: string
}
export type PolicyReceipt = { readonly version: 1; readonly changes: readonly PolicyChange[] }

const PROMO = "opengateway/deepseek/deepseek-v4.1-flash-ultrafast:low"
const CODEX = new Set(["chatgpt-subscription", "openai-codex"])
const RESERVED = new Set(["__proto__", "constructor", "prototype"])
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const at = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => object(current) && Object.hasOwn(current, key) ? current[key] : undefined, value)
const nodeAt = (node: JsoncNode | undefined, path: readonly string[]): JsoncNode | undefined =>
  path.reduce<JsoncNode | undefined>((current, key) => current?.members?.find(member => member.key === key)?.value, node)

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

/** Policy is deliberately applied AFTER inheritance for each saved profile.
 * No profile is resolved against another profile's or base's runtime policy.
 * The four arguments are the integration API, with an injectable clock.
 */
export function composePolicies(baseText: string, settings: PolicySettings, builtin: BuiltinRouting, now = Date.now()): {
  text: string; receipt: PolicyReceipt; promoActive: boolean; codexActive: boolean
} {
  const promo = settings.promo
  const promoActive = promo !== null && Number.isFinite(now) && Number.isFinite(promo.fetchedAt)
    && promo.fetchedAt <= now && promo.discountNow >= 0.9 && promo.discountNow <= 1
    && promo.nextAt !== null && Number.isFinite(promo.nextAt) && now < promo.nextAt
    && ((promo.discountNext ?? 0) >= 0.9 || now < promo.nextAt - 15 * 60_000)
  if (!promoActive && !settings.codex)
    return { text: baseText, receipt: emptyPolicyReceipt(), promoActive, codexActive: false }
  const raw: unknown = parseJsonc(baseText)
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
    const harness = object(layer) && Object.hasOwn(layer, "[native]") ? "[native]"
      : object(at(layer, ["[senpi]"])) ? "[senpi]"
        : ["categories", "agents", "model_profiles"].some(key => object(at(layer, [key]))) ? undefined : "[native]"
    const target = [...prefix, ...(harness ? [harness] : [])]
    for (const section of ["categories", "agents"] as const) {
      const names = new Set(Object.keys(resolved.config[section]))
      if (promoActive) for (const name of section === "categories" ? ["quick"] : ["explore", "librarian"]) names.add(name)
      for (const name of names) {
        if (RESERVED.has(name) || resolved.sources[section][name] === "disabled") continue
        const chain: string[] = resolved.config[section][name]?.models ?? []
        const promotional = promoActive && (section === "categories" ? name === "quick" : name === "explore" || name === "librarian")
        const codex = (spec: string): boolean => splitSpec(spec)?.providers.some(provider => CODEX.has(provider)) ?? false
        const preferCodex = (spec: string): string => {
          const parsed = splitSpec(spec)
          if (!parsed || parsed.providers.length < 2) return spec
          const providers = [...parsed.providers.filter(provider => CODEX.has(provider)), ...parsed.providers.filter(provider => !CODEX.has(provider))]
          return `{${providers.join("|")}}${spec.slice(spec.indexOf("/"))}`
        }
        const wanted = promotional ? [PROMO, ...chain.filter(spec => spec !== PROMO)]
          : settings.codex ? [...chain.filter(codex), ...chain.filter(spec => !codex(spec))].map(preferCodex) : chain
        const current = resolveRouting(applyProfile(parseJsonc(text), profile).config, builtin)
        const actual: string[] = current.config[section][name]?.models ?? []
        if (isDeepStrictEqual(actual, wanted)) continue
        // Reuse configured object rungs (including their metadata). Only builtin
        // or string agent rungs need encoding into OMO's model/variant format.
        const entry = at(config, [section, name])
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
  return { text, receipt: { version: 1, changes }, promoActive, codexActive: settings.codex }
}
