/**
 * Offline tests for `lib/modelsdev.js`: catalog indexing, deterministic
 * models.dev matching and the fill-only-missing completion rules.
 *
 * The fixture (`test/fixtures/models-dev.json`) is hand-written and mirrors the
 * shape and the relevant records of the live catalog — including the expected
 * live results for `codex/gpt-6.1-sol`, `claude/claude-haiku-5-5`,
 * `cn:deepseek-flash`, `openai/gpt-6.1-sol`, `auto` and the `group/smart-split`
 * non-match. It also mirrors the WorkBuddy id-alias decisions: `cn:kimi-k3-1`
 * resolves to `moonshotai/kimi-k3` (the authoritative vendor, although its
 * fixture record is less complete than the reseller copy), and `cn:hy3-b` /
 * `cn:hy4-preview-ctrl` resolve to `aihubmix`. No network is used and the 6 MB
 * live catalog is never committed.
 *
 * Run: node test/modelsdev.mjs
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  MODELS_DEV_URL,
  THINKING_LEVELS,
  buildModelsDevIndex,
  enrichModelEntry,
  enrichModels,
  matchModelsDevModel,
  normalizeModelKey,
} from "../lib/modelsdev.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/models-dev.json", import.meta.url), "utf8"))
const index = buildModelsDevIndex(fixture)

const results = []
function check(testName, fn) {
  results.push({ name: testName, fn })
}

/** One fixture catalog model by provider/model keys (asserts it exists). */
function fixtureModel(providerId, modelId) {
  const provider = fixture[providerId]
  assert.ok(provider !== undefined, `fixture is missing provider ${providerId}`)
  const model = provider.models[modelId]
  assert.ok(model !== undefined, `fixture is missing model ${providerId}/${modelId}`)
  return model
}

/** A throwaway catalog model with a complete, overridable record. */
function catalogModel(overrides = {}) {
  return {
    id: "catalog-model",
    name: "Catalog Model",
    limit: { context: 1000, output: 100 },
    modalities: { input: ["text"] },
    ...overrides,
  }
}

/** Match one id and return the record, asserting a match happened. */
function matched(id, query = {}) {
  const record = matchModelsDevModel(index, { id, ...query })
  assert.ok(record !== undefined, `expected ${id} to match a catalog model`)
  return record
}

const SOL_ENRICHED = {
  id: "codex/gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  contextWindow: 1050000,
  maxTokens: 128000,
  input: ["text", "image"],
  reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
}

const DEEPSEEK_ENRICHED = {
  id: "cn:deepseek-flash",
  name: "DeepSeek V4.1 Flash 1017",
  contextWindow: 1048576,
  maxTokens: 393216,
  input: ["text", "image"],
  reasoningEfforts: { off: null, low: "low", high: "high", max: "max" },
}

/* --------------------------------------------------------------- constants -- */

check("MODELS_DEV_URL is the public catalog endpoint", () => {
  assert.equal(MODELS_DEV_URL, "https://models.dev/api.json")
})

check("THINKING_LEVELS is the shared schema's ordered set", () => {
  assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
})

/* -------------------------------------------------------------- normalizing -- */

check("normalizeModelKey folds case, separators, and dotted versions", () => {
  assert.equal(normalizeModelKey("GPT-6.1-Sol"), "gpt-6-1-sol")
  assert.equal(normalizeModelKey("gpt-6.1-sol"), "gpt-6-1-sol")
  assert.equal(normalizeModelKey("gpt_6_1_sol"), "gpt-6-1-sol")
  assert.equal(normalizeModelKey("  cn:deepseek-flash  "), "cn-deepseek-flash")
  assert.equal(normalizeModelKey("@cf/openai/gpt-oss-20b"), "cf-openai-gpt-oss-20b")
  assert.equal(normalizeModelKey("a---b"), "a-b")
  assert.equal(normalizeModelKey(""), "")
  assert.equal(normalizeModelKey("   "), "")
  assert.equal(normalizeModelKey(undefined), "")
  assert.equal(normalizeModelKey(7), "")
  // Dot and dash spellings are the same key.
  assert.equal(normalizeModelKey("claude-haiku-5.5"), normalizeModelKey("claude-haiku-5-5"))
})

/* ------------------------------------------------------------------- index -- */

check("buildModelsDevIndex counts every usable provider and model", () => {
  assert.equal(index.providerCount, 21)
  assert.equal(index.modelCount, 29)
  assert.equal(index.entries.length, 29)
  const row = index.entries.find((entry) => entry.providerId === "openai" && entry.modelId === "gpt-6.1-sol")
  assert.ok(row !== undefined)
  assert.equal(row.model, fixture.openai.models["gpt-6.1-sol"])
})

check("buildModelsDevIndex ignores non-provider metadata", () => {
  const withMetadata = { _meta: { version: 1 }, ...fixture }
  const built = buildModelsDevIndex(withMetadata)
  assert.equal(built.providerCount, 21)
  assert.equal(built.modelCount, 29)
})

check("malformed catalog bodies are rejected with a Chinese message", () => {
  const bodies = [
    undefined,
    null,
    "text",
    7,
    [],
    {},
    { openai: null },
    { openai: {} },
    { openai: { models: [] } },
    { openai: { models: { broken: "not a model" } } },
  ]
  for (const body of bodies) {
    assert.throws(() => buildModelsDevIndex(body), /models.dev 目录格式无法识别/, `expected a throw for ${JSON.stringify(body)}`)
  }
})

/* ----------------------------------------------------------------- matching -- */

check("exact raw ids match case-insensitively", () => {
  const record = matched("GPT-6.1-SOL")
  assert.equal(record.providerId, "openai")
  assert.equal(record.modelId, "gpt-6.1-sol")
  assert.equal(record.score, 1200, "exact id (1000) plus the authoritative-vendor bonus (200)")
})

check("normalized ids match across dot and dash spellings", () => {
  const record = matched("dash.model")
  assert.equal(record.providerId, "dash-vendor")
  assert.equal(record.modelId, "dash-model")
  assert.equal(record.score, 900)
  // Dashes work too: the catalog id spells the version with dots.
  assert.equal(matched("gpt-6-1-sol").providerId, "openai")
})

check("exact canonical ids match", () => {
  const record = matched("upstream-vendor/actual-model")
  assert.equal(record.providerId, "alias-reseller")
  assert.equal(record.modelId, "resold-model")
  assert.equal(record.score, 950)
})

check("normalized canonical ids match", () => {
  const record = matched("upstream-vendor/actual.model")
  assert.equal(record.providerId, "alias-reseller")
  assert.equal(record.modelId, "resold-model")
  assert.equal(record.score, 850)
})

check("display names match when the ids do not", () => {
  const record = matched("unrelated-id", { name: "  Fancy Display Name " })
  assert.equal(record.providerId, "name-vendor")
  assert.equal(record.modelId, "opaque-id")
  assert.equal(record.score, 800)
})

check("catalog ids match on progressive tails", () => {
  const record = matched("some-router/twin-model")
  assert.equal(record.providerId, "alpha-labs", "the tie-break is lexicographic and deterministic")
  assert.equal(record.modelId, "twin-model")
  assert.equal(record.score, 760)
})

check("canonical tails are a weaker match than catalog ids", () => {
  const record = matched("deep-model")
  assert.equal(record.providerId, "reseller-two")
  assert.equal(record.modelId, "whatever-id")
  assert.equal(record.score, 720)
})

check("family is the weakest match floor", () => {
  const record = matched("legacy-family")
  assert.equal(record.providerId, "family-vendor")
  assert.equal(record.modelId, "opaque-model")
  assert.equal(record.score, 500)
})

check("decorated ids resolve to the canonical catalog model", () => {
  const codex = matched("codex/gpt-6.1-sol")
  assert.equal(codex.providerId, "openai")
  assert.equal(codex.modelId, "gpt-6.1-sol")
  assert.equal(codex.score, 960)

  const generic = matched("xxx/gpt-6.1-sol")
  assert.equal(generic.providerId, "openai")

  const deepseek = matched("cn:deepseek-flash")
  assert.equal(deepseek.providerId, "deepseek")
  assert.equal(deepseek.modelId, "deepseek-flash")

  const cloudflare = matched("@cf/openai/gpt-oss-20b")
  assert.equal(cloudflare.providerId, "cloudflare-ai-gateway")
  assert.equal(cloudflare.modelId, "@cf/openai/gpt-oss-20b")

  const tailed = matched("some-router/gpt-oss-20b")
  assert.equal(tailed.providerId, "cloudflare-ai-gateway")
  assert.equal(tailed.score, 760)

  // A query that embeds the canonical id as a tail hits the canonical tier.
  const canonicalTail = matched("some-router/openai/gpt-oss-20b")
  assert.equal(canonicalTail.providerId, "cloudflare-ai-gateway")
  assert.equal(canonicalTail.score, 850)
})

check("an unrelated routing group has no false match", () => {
  assert.equal(matchModelsDevModel(index, { id: "group/smart-split" }), undefined)
  assert.equal(matchModelsDevModel(index, { id: "smart-split" }), undefined)
  assert.equal(matchModelsDevModel(index, { id: "group/never-stuck" }), undefined)
})

check("local-suffix aliases resolve decorated gateway ids to their catalog model", () => {
  const kimi = matched("cn:kimi-k3-1")
  assert.equal(kimi.providerId, "moonshotai")
  assert.equal(kimi.modelId, "kimi-k3")
  assert.equal(kimi.score, 400, "the alias tier is the lowest and earns no bonus")

  const hy3 = matched("cn:hy3-b")
  assert.equal(hy3.providerId, "aihubmix")
  assert.equal(hy3.modelId, "hy3")
  assert.equal(hy3.canonicalModelId, "tencent/hy3")
  assert.equal(hy3.score, 400)

  const hy4 = matched("cn:hy4-preview-ctrl")
  assert.equal(hy4.providerId, "aihubmix")
  assert.equal(hy4.modelId, "hy4-preview")
  assert.equal(hy4.score, 400)

  // `exp` is the other accepted word marker.
  const exp = matched("cn:hy4-preview-exp")
  assert.equal(exp.providerId, "aihubmix")
  assert.equal(exp.modelId, "hy4-preview")
})

check("alias matches earn no provider-hint or authoritative bonus", () => {
  // `openrouter/moonshotai/kimi-k3-1` hints `openrouter`, whose reseller copy
  // also carries an alias key. A hint bonus would make the reseller win; the
  // alias tier must stay bonus-free and let the authoritative vendor win.
  const record = matched("openrouter/moonshotai/kimi-k3-1")
  assert.equal(record.providerId, "moonshotai")
  assert.equal(record.modelId, "kimi-k3")
  assert.equal(record.score, 400)
})

check("alias candidates prefer the authoritative vendor before metadata completeness", () => {
  // The fixture mirrors the live catalog decision: many providers resell
  // kimi-k3, and the moonshotai record is deliberately less complete than
  // openrouter's copy, so only the authoritative preference can decide.
  const moonshot = index.entries.find((entry) => entry.providerId === "moonshotai" && entry.modelId === "kimi-k3")
  const reseller = index.entries.find(
    (entry) => entry.providerId === "openrouter" && entry.modelId === "moonshotai/kimi-k3",
  )
  assert.ok(moonshot !== undefined && reseller !== undefined)
  assert.equal(moonshot.authoritative, true)
  assert.equal(reseller.authoritative, false)
  assert.ok(moonshot.completeness < reseller.completeness)

  const records = []
  for (let attempt = 0; attempt < 5; attempt += 1) records.push(matched("cn:kimi-k3-1"))
  assert.deepEqual(
    records.map((record) => [record.providerId, record.modelId]),
    [
      ["moonshotai", "kimi-k3"],
      ["moonshotai", "kimi-k3"],
      ["moonshotai", "kimi-k3"],
      ["moonshotai", "kimi-k3"],
      ["moonshotai", "kimi-k3"],
    ],
  )
})

check("a direct catalog match always wins over an alias form", () => {
  const direct = matched("glm-5.1")
  assert.equal(direct.providerId, "zhipuai")
  assert.equal(direct.modelId, "glm-5.1")
  assert.equal(direct.score, 1200, "exact id plus authoritative bonus; the glm-5 alias copy cannot win")

  // The alias form itself resolves when no direct catalog id exists.
  const aliased = matched("glm-5.1-exp")
  assert.equal(aliased.providerId, "zhipuai")
  assert.equal(aliased.modelId, "glm-5.1")
  assert.equal(aliased.score, 400)
})

check("the alias tier cannot outrank a weaker normal match", () => {
  const mini = buildModelsDevIndex({
    "alias-vendor": {
      id: "alias-vendor",
      models: { "mystery-model": catalogModel({ id: "mystery-model" }) },
    },
    "family-vendor": {
      id: "family-vendor",
      models: { opaque: catalogModel({ id: "opaque", family: "mystery-model-1" }) },
    },
  })
  const record = matchModelsDevModel(mini, { id: "mystery-model-1" })
  assert.ok(record !== undefined)
  assert.equal(record.providerId, "family-vendor", "the 500-scored family match beats the 400-scored alias")
  assert.equal(record.score, 500)
})

check("the alias tier never strips a longer disambiguating word", () => {
  assert.equal(matchModelsDevModel(index, { id: "gpt-6.1-turbo" }), undefined)
  assert.equal(matchModelsDevModel(index, { id: "group/smart-split" }), undefined)
  assert.equal(matchModelsDevModel(index, { id: "cn:deepseek-flash-lkeap" }), undefined)
  assert.equal(matchModelsDevModel(index, { id: "cn:deepseek-flash-volc" }), undefined)

  // A catalog `gpt-6.1` must not be reached by stripping `turbo`.
  const mini = buildModelsDevIndex({
    vendor: { id: "vendor", models: { "gpt-6.1": catalogModel({ id: "gpt-6.1" }) } },
  })
  assert.equal(matchModelsDevModel(mini, { id: "gpt-6.1-turbo" }), undefined)
  assert.equal(matchModelsDevModel(mini, { id: "gpt-6.1" })?.modelId, "gpt-6.1")
})

check("the authoritative vendor wins over aggregator copies", () => {
  const plain = matched("gpt-6.1-sol")
  assert.equal(plain.providerId, "openai", "the aggregator copies of the same id must not win")
  assert.equal(plain.score, 1200)

  const qualified = matched("openai/gpt-6.1-sol")
  assert.equal(qualified.providerId, "openai", "openrouter's exact id must not beat the vendor")
  assert.equal(qualified.score, 1450)
  assert.equal(qualified.canonicalModelId, "openai/gpt-6.1-sol")
  assert.equal(qualified.providerName, "OpenAI")
})

check("a matching provider hint is preferred", () => {
  const azure = matched("azure/gpt-6.1-sol")
  assert.equal(azure.providerId, "azure", "the hint outranks the bare canonical bonus")
  assert.equal(azure.score, 1060)

  const hinted = matched("hidden.model", { providerHint: "canonical-vendor" })
  assert.equal(hinted.providerId, "canonical-vendor")
})

check("ambiguous matches are deterministic", () => {
  const records = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    records.push(matched("auto"))
    records.push(matched("twin-model"))
  }
  assert.deepEqual(
    records.map((record) => [record.providerId, record.modelId]),
    [
      ["model-oracle-ai", "auto"],
      ["alpha-labs", "twin-model"],
      ["model-oracle-ai", "auto"],
      ["alpha-labs", "twin-model"],
      ["model-oracle-ai", "auto"],
      ["alpha-labs", "twin-model"],
      ["model-oracle-ai", "auto"],
      ["alpha-labs", "twin-model"],
      ["model-oracle-ai", "auto"],
      ["alpha-labs", "twin-model"],
    ],
  )
  // The two "auto" records differ only in metadata completeness: the complete
  // one wins, not listing order.
  assert.equal(records[0].model.reasoning_options.length, 1)
})

check("a missing or blank query id matches nothing", () => {
  assert.equal(matchModelsDevModel(index, {}), undefined)
  assert.equal(matchModelsDevModel(index, { id: "   " }), undefined)
  assert.equal(matchModelsDevModel(index, { id: 7 }), undefined)
  assert.equal(matchModelsDevModel({}, { id: "gpt-6.1-sol" }), undefined)
  assert.equal(matchModelsDevModel(undefined, { id: "gpt-6.1-sol" }), undefined)
})

/* ----------------------------------------------- expected live-catalog parity -- */

check("live-catalog parity: codex/gpt-6.1-sol resolves to openai/gpt-6.1-sol", () => {
  const record = matched("codex/gpt-6.1-sol")
  assert.equal(record.providerId, "openai")
  assert.equal(record.modelId, "gpt-6.1-sol")
  const { entry, fields } = enrichModelEntry({ id: "codex/gpt-6.1-sol" }, record.model)
  assert.deepEqual(fields, ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"])
  assert.deepEqual(entry, SOL_ENRICHED)
  assert.equal(entry.contextWindow, 1050000)
  assert.equal(entry.maxTokens, 128000)
  assert.deepEqual(entry.input, ["text", "image"], "pdf is dropped silently")
  assert.deepEqual(entry.reasoningEfforts, {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  })
})

check("live-catalog parity: claude/claude-haiku-5-5 resolves to anthropic", () => {
  const record = matched("claude/claude-haiku-5-5")
  assert.equal(record.providerId, "anthropic")
  assert.equal(record.modelId, "claude-haiku-5-5")
  const { entry } = enrichModelEntry({ id: "claude/claude-haiku-5-5" }, record.model)
  assert.equal(entry.name, "Claude Haiku 5.5")
  assert.equal(entry.contextWindow, 1000000)
  assert.equal(entry.maxTokens, 128000)
  assert.deepEqual(entry.input, ["text", "image"])
  assert.deepEqual(entry.reasoningEfforts, {
    off: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  })
})

check("live-catalog parity: cn:deepseek-flash resolves to deepseek/deepseek-flash", () => {
  const record = matched("cn:deepseek-flash")
  assert.equal(record.providerId, "deepseek")
  assert.equal(record.modelId, "deepseek-flash")
  const { entry, fields } = enrichModelEntry({ id: "cn:deepseek-flash" }, record.model)
  assert.deepEqual(fields, ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"])
  assert.deepEqual(entry, DEEPSEEK_ENRICHED)
  assert.equal(entry.contextWindow, 1048576)
  assert.equal(entry.maxTokens, 393216)
  assert.deepEqual(entry.reasoningEfforts, { off: null, low: "low", high: "high", max: "max" })
})

check("live-catalog parity: decorated WorkBuddy ids resolve through local aliases", () => {
  const kimi = matched("cn:kimi-k3-1")
  assert.equal(`${kimi.providerId}/${kimi.modelId}`, "moonshotai/kimi-k3")
  const hy3 = matched("cn:hy3-b")
  assert.equal(`${hy3.providerId}/${hy3.modelId}`, "aihubmix/hy3")
  const hy4 = matched("cn:hy4-preview-ctrl")
  assert.equal(`${hy4.providerId}/${hy4.modelId}`, "aihubmix/hy4-preview")

  // The alias tier only locates the catalog record; completion still fills the
  // reasoning levels the decorated gateway id itself cannot disclose.
  const { entry } = enrichModelEntry({ id: "cn:hy3-b" }, hy3.model)
  assert.deepEqual(entry.reasoningEfforts, { low: "low", high: "high" })
})

check("live-catalog parity: openai/gpt-6.1-sol stays with the authoritative openai", () => {
  const record = matched("openai/gpt-6.1-sol")
  assert.equal(record.providerId, "openai")
  assert.notEqual(record.providerId, "openrouter")
})

check("live-catalog parity: group/smart-split and auto behave as specified", () => {
  assert.equal(matchModelsDevModel(index, { id: "group/smart-split" }), undefined)
  // The live catalog has an `auto` model; matching one is acceptable, and the
  // fixture pins the deterministic choice so a regression is visible.
  const auto = matched("auto")
  assert.equal(auto.modelId, "auto")
  assert.equal(auto.providerId, "model-oracle-ai")
})

/* -------------------------------------------------------------- enriching -- */

check("enrichModelEntry fills all five managed fields in report order", () => {
  const { entry, fields } = enrichModelEntry({ id: "gpt-6.1-sol" }, fixtureModel("openai", "gpt-6.1-sol"))
  assert.deepEqual(fields, ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"])
  assert.deepEqual(entry, {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    contextWindow: 1050000,
    maxTokens: 128000,
    input: ["text", "image"],
    reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  })
})

check("enrichModelEntry never overwrites a gateway-disclosed field", () => {
  const entry = {
    id: "gpt-6.1-sol",
    name: "Gateway Name",
    contextWindow: 111,
    maxTokens: 222,
    input: ["text"],
    reasoningEfforts: false,
  }
  const { entry: enriched, fields } = enrichModelEntry(entry, fixtureModel("openai", "gpt-6.1-sol"))
  assert.deepEqual(fields, [])
  assert.deepEqual(enriched, entry)
  assert.notEqual(enriched, entry, "even a no-op returns a copy")
})

check("enrichModelEntry treats a blank name as absent", () => {
  const { entry, fields } = enrichModelEntry({ id: "gpt-6.1-sol", name: "   " }, fixtureModel("openai", "gpt-6.1-sol"))
  assert.deepEqual(fields, ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"])
  assert.equal(entry.name, "GPT-6.1 Sol")
})

check("enrichModelEntry does not fill a catalog name that merely echoes the id", () => {
  // Some live catalog records use the raw id as their name (`gpt-5.1`, `o3`).
  // Filling that would let an overwrite import replace a stored display name
  // with the raw id, so the echo is treated as absent (matching lib/magpie.js).
  const echoed = enrichModelEntry({ id: "gpt-5.1" }, catalogModel({ id: "gpt-5.1", name: "gpt-5.1" }))
  assert.equal(Object.hasOwn(echoed.entry, "name"), false)
  assert.equal(echoed.fields.includes("name"), false)
  // A catalog name that really differs from the id is still filled.
  const named = enrichModelEntry({ id: "gpt-5.1" }, catalogModel({ id: "gpt-5.1", name: "GPT-5.1" }))
  assert.equal(named.entry.name, "GPT-5.1")
  assert.deepEqual(named.fields.slice(0, 1), ["name"])
})

check("input filtering keeps text and image only, text first", () => {
  assert.deepEqual(enrichModelEntry({ id: "m" }, catalogModel()).entry.input, ["text"])
  assert.deepEqual(
    enrichModelEntry({ id: "m" }, catalogModel({ modalities: { input: ["image"] } })).entry.input,
    ["text", "image"],
  )
  assert.deepEqual(
    enrichModelEntry({ id: "m" }, catalogModel({ modalities: { input: ["IMAGE", "TEXT"] } })).entry.input,
    ["text", "image"],
  )
  assert.deepEqual(
    enrichModelEntry({ id: "m" }, catalogModel({ modalities: { input: ["text", "image", "pdf", "audio"] } })).entry.input,
    ["text", "image"],
  )
  assert.deepEqual(
    enrichModelEntry({ id: "m" }, catalogModel({ modalities: { input: ["text", "pdf"] } })).entry.input,
    ["text"],
  )
})

check("an empty or unsupported-only modality list omits input", () => {
  for (const catalog of [
    catalogModel({ modalities: { input: [] } }),
    catalogModel({ modalities: { input: ["pdf", "audio", "video"] } }),
    catalogModel({ modalities: {} }),
    catalogModel({ modalities: undefined }),
  ]) {
    assert.equal(Object.hasOwn(enrichModelEntry({ id: "m" }, catalog).entry, "input"), false)
  }
})

check("capacities must be positive integers", () => {
  const { entry, fields } = enrichModelEntry(
    { id: "m" },
    catalogModel({ limit: { context: 0, output: -5 } }),
  )
  assert.equal(Object.hasOwn(entry, "contextWindow"), false)
  assert.equal(Object.hasOwn(entry, "maxTokens"), false)
  assert.ok(!fields.includes("contextWindow"))
  assert.ok(!fields.includes("maxTokens"))
  assert.equal(
    enrichModelEntry({ id: "m" }, catalogModel({ limit: { context: 1.5, output: "128000" } })).entry.contextWindow,
    undefined,
  )
})

check("effort options map onto the seven levels with none -> off:null", () => {
  const { entry } = enrichModelEntry(
    { id: "m" },
    catalogModel({ reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "low", "MAX"] }] }),
  )
  assert.deepEqual(entry.reasoningEfforts, { off: null, low: "low", max: "max" })

  const plain = enrichModelEntry(
    { id: "m" },
    catalogModel({ reasoning: true, reasoning_options: [{ type: "effort", values: ["off", "high"] }] }),
  ).entry
  assert.deepEqual(plain.reasoningEfforts, { off: null, high: "high" })
})

check("a toggle option means off is supported beside the effort levels", () => {
  const { entry } = enrichModelEntry(
    { id: "m" },
    catalogModel({
      reasoning: true,
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
    }),
  )
  assert.deepEqual(entry.reasoningEfforts, { off: null, low: "low", high: "high" })
})

check("toggle-only, budget-only, and unsupported values omit reasoningEfforts", () => {
  const catalogs = [
    catalogModel({ reasoning: true, reasoning_options: [{ type: "toggle" }] }),
    catalogModel({ reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1, max: 2 }] }),
    catalogModel({ reasoning: true, reasoning_options: [{ type: "budget_tokens" }] }),
    catalogModel({ reasoning: true, reasoning_options: [{ type: "effort", values: ["default", "ultra"] }] }),
    catalogModel({ reasoning: true, reasoning_options: [{ type: "effort", values: ["none"] }] }),
    catalogModel({ reasoning: true, reasoning_options: [] }),
    catalogModel({ reasoning: true }),
    catalogModel({}),
  ]
  for (const catalog of catalogs) {
    const { entry, fields } = enrichModelEntry({ id: "m" }, catalog)
    assert.equal(Object.hasOwn(entry, "reasoningEfforts"), false)
    assert.ok(!fields.includes("reasoningEfforts"))
  }
})

check("reasoning:false is filled as false and never replaced", () => {
  const filled = enrichModelEntry({ id: "m" }, catalogModel({ reasoning: false })).entry
  assert.deepEqual(filled.reasoningEfforts, false)

  const disclosed = enrichModelEntry(
    { id: "m", reasoningEfforts: false },
    catalogModel({ reasoning: true, reasoning_options: [{ type: "effort", values: ["low"] }] }),
  )
  assert.equal(disclosed.entry.reasoningEfforts, false)
  assert.equal(disclosed.fields.includes("reasoningEfforts"), false)
})

check("a disclosed reasoningEfforts object is preserved", () => {
  const { entry, fields } = enrichModelEntry(
    { id: "m", reasoningEfforts: { low: "low" } },
    catalogModel({ reasoning: true, reasoning_options: [{ type: "effort", values: ["high"] }] }),
  )
  assert.deepEqual(entry.reasoningEfforts, { low: "low" })
  assert.equal(fields.includes("reasoningEfforts"), false)
})

check("enrichModelEntry never mutates the entry or the catalog model", () => {
  const entry = Object.freeze({ id: "frozen", input: Object.freeze(["text"]) })
  const catalog = Object.freeze({
    name: "Frozen Model",
    limit: Object.freeze({ context: 1000, output: 100 }),
    modalities: Object.freeze({ input: Object.freeze(["text", "image"]) }),
  })
  const { entry: enriched, fields } = enrichModelEntry(entry, catalog)
  assert.notEqual(enriched, entry)
  assert.deepEqual(entry, { id: "frozen", input: ["text"] })
  assert.deepEqual(fields, ["name", "contextWindow", "maxTokens"])
  assert.deepEqual(enriched, {
    id: "frozen",
    name: "Frozen Model",
    contextWindow: 1000,
    maxTokens: 100,
    input: ["text"],
  })
})

check("enrichModelEntry tolerates unusable arguments", () => {
  assert.deepEqual(enrichModelEntry(null, catalogModel()), { entry: null, fields: [] })
  assert.deepEqual(enrichModelEntry({ id: "m" }, null), { entry: { id: "m" }, fields: [] })
})

/* ---------------------------------------------------------------- summary -- */

check("enrichModels completes a sparse list and reports the summary", () => {
  const input = [
    { id: "codex/gpt-6.1-sol" },
    { id: "group/smart-split" },
    { id: "claude/claude-haiku-5-5", name: "Stored Name" },
    { id: "auto" },
  ]
  const snapshot = JSON.parse(JSON.stringify(input))
  const { models, modelsDev } = enrichModels(input, fixture)

  assert.deepEqual(input, snapshot, "the input list and its entries must not be mutated")
  assert.equal(models.length, 4)
  assert.deepEqual(models[0], SOL_ENRICHED)
  assert.deepEqual(models[1], { id: "group/smart-split" })
  assert.equal(models[2].name, "Stored Name", "a disclosed name is kept")
  assert.deepEqual(Object.keys(models[3].reasoningEfforts), ["off", "minimal", "low", "medium", "high", "xhigh", "max"])

  assert.deepEqual(modelsDev, {
    source: "models.dev",
    available: true,
    matched: 3,
    enriched: [
      { id: "codex/gpt-6.1-sol", fields: ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] },
      { id: "claude/claude-haiku-5-5", fields: ["contextWindow", "maxTokens", "input", "reasoningEfforts"] },
      { id: "auto", fields: ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] },
    ],
    unmatched: ["group/smart-split"],
  })
})

check("enrichModels can reuse a prebuilt index and rejects a bad catalog", () => {
  const { modelsDev } = enrichModels([{ id: "cn:deepseek-flash" }], fixture, index)
  assert.equal(modelsDev.matched, 1)
  assert.deepEqual(enrichModels([], fixture).modelsDev, {
    source: "models.dev",
    available: true,
    matched: 0,
    enriched: [],
    unmatched: [],
  })
  assert.throws(() => enrichModels([], { nope: true }), /models.dev 目录格式无法识别/)
})

check("enrichModels copies entries even when nothing is filled", () => {
  const disclosed = {
    id: "gpt-6.1-sol",
    name: "Mine",
    contextWindow: 1,
    maxTokens: 2,
    input: ["text"],
    reasoningEfforts: { low: "low" },
  }
  const { models, modelsDev } = enrichModels([disclosed], fixture)
  assert.deepEqual(models[0], disclosed)
  assert.notEqual(models[0], disclosed)
  assert.equal(modelsDev.matched, 1)
  assert.deepEqual(modelsDev.enriched, [])
  assert.deepEqual(modelsDev.unmatched, [])
})

/* ---------------------------------------------------------------- runner --- */

let failed = 0
for (const { name: testName, fn } of results) {
  try {
    await fn()
    console.log(`PASS  ${testName}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${testName}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n${String(results.length - failed)}/${String(results.length)} passed`)
if (failed > 0) process.exitCode = 1
