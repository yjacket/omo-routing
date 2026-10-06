// Config resolution and in-place JSONC editing helpers. No senpi, no LLM. Run: node --test
import { test } from "node:test"
import assert from "node:assert/strict"
import { stripJsonc, parseJsonc, mergeConfig, applyProfile, resolveProfileName, chainOf, profileNames, setJsoncPath, removeJsoncPath } from "../extension/routing.ts"

const OMO_JSONC = `{
  // a comment
  "[senpi]": {
    "model_profile": "unified",
    "model_profiles": { "unified": { "models": ["openai-codex/gpt-5.6-sol:high", "github-copilot/gpt-5.6-sol:high"] }, "capacity-main": { "models": ["openai-codex/gpt-5.6-sol:medium"] } },
    "agents": { "plan-reviewer": { "models": ["devin/swe-2-max", "github-copilot/gpt-6-astra:high"] } },
    "categories": {
      "architect": { "models": ["claude-sdk-oauth/claude-fable-5-1:max", "github-copilot/claude-fable-5.1:max"] },
      "quick": { "models": ["devin/swe-2-low"] }
    },
    "task": { "provider_concurrency": { "openai-codex": 2 } }
  },
  /* block comment */
  "profiles": {
    "capacity": {
      "[senpi]": {
        "model_profile": "capacity-main",
        "categories": { "quick": { "models": ["openai-codex/gpt-5.6-terra:medium"] } }
      }
    },
    "swe2-balanced": { "[senpi]": {} }
  }
}`

test("stripJsonc removes line and block comments, keeps strings", () => {
  const src = `{"a": "x//y", /* c */ "b": 1} // tail`
  assert.equal(parseJsonc(src).a, "x//y")
  assert.equal(parseJsonc(src).b, 1)
  assert.match(stripJsonc(`// gone\n{"a":1}`), /{"a":1}/)
})

test("mergeConfig: objects deep-merge, arrays replace, proto keys skipped", () => {
  assert.deepEqual(mergeConfig({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3, z: 4 }, list: [9] }), { a: { x: 1, y: 3, z: 4 }, list: [9] })
  const polluted = mergeConfig({}, JSON.parse(`{"__proto__": {"pwned": true}}`))
  assert.equal({}.pwned, undefined)
  assert.equal(polluted.__proto__.pwned, undefined)
})

test("resolveProfileName precedence: OMO_PROFILE > OCX_PROFILE > OPENCODE_CONFIG_DIR", () => {
  assert.equal(resolveProfileName({ OMO_PROFILE: "a", OCX_PROFILE: "b" }), "a")
  assert.equal(resolveProfileName({ OCX_PROFILE: "b" }), "b")
  assert.equal(resolveProfileName({ OPENCODE_CONFIG_DIR: "C:\\x\\profiles\\cap" }), "cap")
  assert.equal(resolveProfileName({ OMO_PROFILE: "" }), undefined)
})

test("applyProfile: profile [senpi] overrides base [senpi]; missing profile warns", () => {
  const raw = parseJsonc(OMO_JSONC)
  assert.deepEqual(profileNames(raw), ["capacity", "swe2-balanced"])
  const base = applyProfile(raw, undefined)
  assert.equal(base.config.model_profile, "unified")
  assert.equal(base.config.categories.quick.models[0], "devin/swe-2-low")
  const cap = applyProfile(raw, "capacity")
  assert.equal(cap.profile, "capacity")
  assert.equal(cap.config.model_profile, "capacity-main")
  assert.equal(cap.config.categories.quick.models[0], "openai-codex/gpt-5.6-terra:medium")
  assert.equal(cap.config.categories.architect.models[0], "claude-sdk-oauth/claude-fable-5-1:max", "untouched keys survive")
  const missing = applyProfile(raw, "nope")
  assert.equal(missing.profile, undefined)
  assert.match(missing.warning, /does not exist/)
})

test("chainOf: model + models, object specs, empty", () => {
  assert.deepEqual(chainOf({ model: "a/b", models: ["c/d:e", { model: "f/g", variant: "high" }] }), ["a/b", "c/d:e", "f/g:high"])
  assert.deepEqual(chainOf({}), [])
  assert.deepEqual(chainOf("x"), [])
})

test("setJsoncPath/removeJsoncPath edit in place: comments, siblings and style survive; missing objects are created", () => {
  let s = setJsoncPath(OMO_JSONC, ["[senpi]", "categories", "quick", "models"], ["x/y:z", "p/q"])
  assert.match(s, /\/\/ a comment/)
  assert.match(s, /\/\* block comment \*\//)
  assert.match(s, /"quick": \{ "models": \["x\/y:z", "p\/q"\] \}/, "inline array stays inline")
  s = setJsoncPath(s, ["[senpi]", "categories", "implementer", "models"], ["n/e:w"])
  assert.match(s, /\n      "implementer": \{\n        "models": \[\n          "n\/e:w"\n        \]\n      \}\n    \}/, "new entry uses the surrounding indentation")
  s = setJsoncPath(s, ["profiles", "swe2-balanced", "[senpi]", "agents", "explore", "models"], ["a/b"])
  s = removeJsoncPath(s, ["[senpi]", "task"])
  const cfg = parseJsonc(s)
  assert.deepEqual(cfg["[senpi]"].categories.quick.models, ["x/y:z", "p/q"])
  assert.deepEqual(cfg["[senpi]"].categories.implementer.models, ["n/e:w"])
  assert.deepEqual(cfg["[senpi]"].categories.architect.models[0], "claude-sdk-oauth/claude-fable-5-1:max")
  assert.deepEqual(cfg.profiles["swe2-balanced"]["[senpi]"].agents.explore.models, ["a/b"])
  assert.equal(cfg["[senpi]"].task, undefined)
  assert.equal(removeJsoncPath(s, ["nope", "x"]), s, "removing an absent path is a no-op")
})

test("[native] is the harness section; a layer's legacy [senpi] applies only when it has no [native]", () => {
  const raw = {
    "[senpi]": { categories: { quick: { models: ["legacy/ignored"] } } },
    "[native]": { task: { default_concurrency: 2 } },
    categories: { quick: { models: ["root/model"] } },
    profiles: {
      migrated: { "[native]": { categories: { quick: { models: ["native/model"] } } } },
      legacy: { "[senpi]": { categories: { quick: { models: ["senpi/model"] } } } },
    },
  }
  assert.deepEqual(applyProfile(raw, undefined).config.categories.quick.models, ["root/model"])
  assert.equal(applyProfile(raw, undefined).config["[native]"], undefined, "harness sections never leak into the effective config")
  assert.deepEqual(applyProfile(raw, "migrated").config.categories.quick.models, ["native/model"])
  assert.deepEqual(applyProfile(raw, "legacy").config.categories.quick.models, ["senpi/model"])
})
