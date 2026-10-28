/**
 * Mapping tests for `lib/magpie.js`, driven by the saved live Magpie gateway
 * response (`test/fixtures/magpie-models.json`, 28 models) and a representative
 * WorkBuddy-style listing (`test/fixtures/workbuddy-models.json`, 6 models).
 *
 * These are the contract-level assertions for the Magpie extension mapping:
 * capacities, modality floor, reasoning-level spelling, the WorkBuddy field
 * spellings (`attachments`, `supports_images`, `reasoning_supported_efforts`,
 * `only_reasoning`, `supports_reasoning`), the `models` map envelope, malformed
 * listings, and the warnings that tell a user what was dropped. No network, no
 * Harness, no dependencies.
 *
 * Run: node test/magpie.mjs
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mapModelEntry, mapModelListing, parseModelListing, THINKING_LEVELS } from "../lib/magpie.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/magpie-models.json", import.meta.url), "utf8"))
const workbuddyFixture = JSON.parse(readFileSync(new URL("./fixtures/workbuddy-models.json", import.meta.url), "utf8"))

const results = []
function check(name, fn) {
  results.push({ name, fn })
}

/** One raw fixture entry by id (asserts it exists). */
function fixtureEntry(id) {
  const entry = fixture.data.find((raw) => raw.id === id)
  assert.ok(entry !== undefined, `fixture is missing ${id}`)
  return entry
}

/* ------------------------------------------------------------ thinking levels */

check("THINKING_LEVELS is the schema's ordered set", () => {
  assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
})

/* ---------------------------------------------------------------- live fixture */

check("the live envelope parses to 28 raw entries", () => {
  const parsed = parseModelListing(fixture)
  assert.equal(parsed.entries.length, 28)
  assert.deepEqual(parsed.warnings, [])
})

check("the live listing maps 28 models in gateway order", () => {
  const { models } = mapModelListing(fixture)
  assert.equal(models.length, 28)
  assert.deepEqual(
    models.map((model) => model.id),
    fixture.data.map((raw) => raw.id),
  )
  assert.equal(new Set(models.map((model) => model.id)).size, 28)
})

check("every mapped fixture entry is storable and non-empty", () => {
  const { models } = mapModelListing(fixture)
  const allowed = new Set(["id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts"])
  for (const entry of models) {
    assert.equal(typeof entry.id, "string")
    assert.ok(entry.id.length > 0)
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `${entry.id} emitted unknown key ${key}`)
    for (const value of Object.values(entry)) {
      assert.ok(!Array.isArray(value) || value.length > 0, `${entry.id} emitted an empty array`)
      assert.ok(
        value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 0,
        `${entry.id} emitted an empty object`,
      )
    }
    assert.ok(entry.contextWindow > 0)
    assert.ok(entry.maxTokens > 0)
    assert.ok(entry.input.includes("text"))
    if (Object.hasOwn(entry, "reasoningEfforts") && entry.reasoningEfforts !== false) {
      for (const [level, wire] of Object.entries(entry.reasoningEfforts)) {
        assert.ok(THINKING_LEVELS.includes(level), `${entry.id} emitted unknown level ${level}`)
        assert.equal(wire, level === "off" ? null : level, `${entry.id} wire spelling for ${level}`)
      }
    }
    // Round-trips through JSON: this object is returned over HTTP.
    assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry)
  }
})

check("claude/claude-haiku-5-5 maps fully", () => {
  const { models } = mapModelListing(fixture)
  const mapped = models.find((model) => model.id === "claude/claude-haiku-5-5")
  assert.deepEqual(mapped, {
    id: "claude/claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ["text", "image"],
    reasoningEfforts: {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  })
})

check("group/never-stuck skips the unsupported ultra level with a warning", () => {
  const { models, warnings } = mapModelListing(fixture)
  const mapped = models.find((model) => model.id === "group/never-stuck")
  assert.deepEqual(mapped.reasoningEfforts, {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  })
  assert.ok(warnings.includes("group/never-stuck：跳过 DSH 不支持的推理档位 ultra"))
})

check("pdf is dropped from input with a warning naming the model", () => {
  const { models, warnings } = mapModelListing(fixture)
  assert.ok(warnings.includes("claude/claude-haiku-5-5：跳过不支持的输入模态 pdf"))
  const mapped = models.find((model) => model.id === "claude/claude-haiku-5-5")
  assert.deepEqual(mapped.input, ["text", "image"])
  assert.ok(!mapped.input.includes("pdf"))
})

check("fixture warning channels are exactly pdf, ultra, and undisclosed levels", () => {
  const { warnings } = mapModelListing(fixture)
  const pdf = warnings.filter((warning) => warning.endsWith("跳过不支持的输入模态 pdf"))
  const ultra = warnings.filter((warning) => warning.endsWith("跳过 DSH 不支持的推理档位 ultra"))
  const undisclosed = warnings.filter((warning) => warning.endsWith("网关声明支持推理，但未提供推理档位"))
  assert.equal(pdf.length, 17)
  assert.equal(ultra.length, 7)
  assert.equal(undisclosed.length, 4)
  assert.equal(warnings.length, 28)
  const ids = new Set(fixture.data.map((raw) => raw.id))
  for (const warning of warnings) {
    assert.ok([...ids].some((id) => warning.startsWith(`${id}：`)), `warning does not name a model: ${warning}`)
  }
})

check("reasoning:true with an empty level list omits reasoningEfforts and warns", () => {
  const { models, warnings } = mapModelListing(fixture)
  for (const id of [
    "claude/claude-haiku-4-5",
    "claude/claude-haiku-4-5-20251001",
    "claude/claude-sonnet-4-5",
    "claude/claude-sonnet-4-5-20250929",
  ]) {
    const mapped = models.find((model) => model.id === id)
    assert.equal(Object.hasOwn(mapped, "reasoningEfforts"), false, `${id} must omit reasoningEfforts`)
    assert.ok(warnings.includes(`${id}：网关声明支持推理，但未提供推理档位`))
  }
})

check("codex routes map text+image and drop ultra where disclosed", () => {
  const { models } = mapModelListing(fixture)
  const codex = models.filter((model) => model.id.startsWith("codex/"))
  assert.equal(codex.length, 8)
  for (const entry of codex) {
    assert.deepEqual(entry.input, ["text", "image"])
    assert.equal(Object.hasOwn(entry.reasoningEfforts, "ultra"), false)
    assert.equal(entry.reasoningEfforts.max, "max")
  }
})

/* ------------------------------------------------------------ entry mapping -- */

check("name is omitted when the listing discloses no genuine name", () => {
  const { entry, warnings } = mapModelEntry({ id: "gateway/unnamed", context_window: 64000 })
  assert.deepEqual(entry, { id: "gateway/unnamed", contextWindow: 64000 })
  assert.equal(Object.hasOwn(entry, "name"), false)
  assert.deepEqual(warnings, [])
})

check("name prefers display_name, then name, then displayName", () => {
  assert.equal(mapModelEntry({ id: "m", display_name: "D", name: "N", displayName: "DN" }).entry.name, "D")
  assert.equal(mapModelEntry({ id: "m", name: "N", displayName: "DN" }).entry.name, "N")
  assert.equal(mapModelEntry({ id: "m", displayName: "DN" }).entry.name, "DN")
  assert.equal(mapModelEntry({ id: "m", display_name: "  Spaced  " }).entry.name, "Spaced")
  assert.equal(Object.hasOwn(mapModelEntry({ id: "m", display_name: "   " }).entry, "name"), false)
})

check("reasoning:false is storable as false, even beside levels", () => {
  assert.deepEqual(
    mapModelEntry({
      id: "m",
      name: "M",
      reasoning: false,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    }).entry,
    { id: "m", name: "M", reasoningEfforts: false },
  )
})

check("contextWindow falls back through the extension fields", () => {
  assert.equal(mapModelEntry({ id: "m", max_input_tokens: 200000 }).entry.contextWindow, 200000)
  assert.equal(mapModelEntry({ id: "m", context_length: 128000 }).entry.contextWindow, 128000)
  assert.equal(mapModelEntry({ id: "m", contextWindow: 64000 }).entry.contextWindow, 64000)
  assert.equal(mapModelEntry({ id: "m", max_output_tokens: 64000 }).entry.maxTokens, 64000)
  assert.equal(mapModelEntry({ id: "m", maxTokens: 8192 }).entry.maxTokens, 8192)
  assert.equal(mapModelEntry({ id: "m", max_tokens: 4096 }).entry.maxTokens, 4096)
})

check("capacity precedence follows the contract order", () => {
  const { entry } = mapModelEntry({
    id: "m",
    context_window: 1000000,
    context_length: 200000,
    max_input_tokens: 100000,
    contextWindow: 64000,
    max_output_tokens: 128000,
    maxTokens: 64000,
    max_tokens: 32000,
  })
  assert.equal(entry.contextWindow, 1000000)
  assert.equal(entry.maxTokens, 128000)
})

check("capacities must be positive integers", () => {
  const { entry } = mapModelEntry({
    id: "m",
    context_window: 0,
    context_length: -5,
    max_input_tokens: 1.5,
    contextWindow: 2048,
    max_output_tokens: "128000",
    maxTokens: 0,
    max_tokens: 512,
  })
  assert.equal(entry.contextWindow, 2048)
  assert.equal(entry.maxTokens, 512)
})

check("unknown raw fields are ignored", () => {
  const { entry } = mapModelEntry({
    id: "m",
    name: "M",
    object: "model",
    created: 0,
    owned_by: "claude",
    type: "model",
    magpie_label: "label",
    service_tiers: [{ id: "priority" }],
    pricing: { prompt: "0.000001" },
    native_endpoints: ["/v1/responses"],
  })
  assert.deepEqual(entry, { id: "m", name: "M" })
})

/* --------------------------------------------------------------- modalities -- */

check("modalities.input wins, text is the floor, images are kept", () => {
  assert.deepEqual(
    mapModelEntry({ id: "m", modalities: { input: ["text", "image", "pdf", "audio"] } }).entry.input,
    ["text", "image"],
  )
  assert.deepEqual(mapModelEntry({ id: "m", input_modalities: ["image"] }).entry.input, ["text", "image"])
  assert.deepEqual(mapModelEntry({ id: "m", input: ["TEXT", "IMAGE"] }).entry.input, ["text", "image"])
  assert.deepEqual(
    mapModelEntry({ id: "m", modalities: { input: ["pdf"] }, input_modalities: ["image"] }).entry.input,
    ["text"],
  )
})

check("unsupported modalities warn once each and never enter input", () => {
  const { entry, warnings } = mapModelEntry({
    id: "gateway/vision",
    modalities: { input: ["text", "image", "audio", "pdf", "video", "audio"] },
  })
  assert.deepEqual(entry.input, ["text", "image"])
  assert.deepEqual(warnings, [
    "gateway/vision：跳过不支持的输入模态 audio",
    "gateway/vision：跳过不支持的输入模态 pdf",
    "gateway/vision：跳过不支持的输入模态 video",
  ])
})

check("no disclosed modalities (or an empty list) omits input", () => {
  assert.equal(Object.hasOwn(mapModelEntry({ id: "m" }).entry, "input"), false)
  assert.equal(Object.hasOwn(mapModelEntry({ id: "m", modalities: {} }).entry, "input"), false)
  assert.equal(Object.hasOwn(mapModelEntry({ id: "m", modalities: { input: [] } }).entry, "input"), false)
})

check("WorkBuddy attachments and the supports_images hint disclose modalities", () => {
  assert.deepEqual(mapModelEntry({ id: "m", attachments: ["image"] }).entry.input, ["text", "image"])
  assert.deepEqual(mapModelEntry({ id: "m", attachments: ["text"] }).entry.input, ["text"])
  assert.deepEqual(
    mapModelEntry({ id: "m", attachments: ["IMAGE", "pdf", "Image"] }).entry,
    { id: "m", input: ["text", "image"] },
    "the array is filtered like every other modality list",
  )
  assert.deepEqual(mapModelEntry({ id: "m", supports_images: true }).entry.input, ["text", "image"])
  assert.equal(Object.hasOwn(mapModelEntry({ id: "m", supports_images: false }).entry, "input"), false)
  // `supports_attachments` is too generic to mean "takes images".
  assert.equal(Object.hasOwn(mapModelEntry({ id: "m", supports_attachments: true }).entry, "input"), false)
})

check("Magpie modality sources win over the WorkBuddy spellings", () => {
  assert.deepEqual(
    mapModelEntry({ id: "m", modalities: { input: ["text"] }, attachments: ["image"], supports_images: true }).entry
      .input,
    ["text"],
  )
  assert.deepEqual(mapModelEntry({ id: "m", input_modalities: ["text"], attachments: ["image"] }).entry.input, [
    "text",
  ])
  assert.deepEqual(
    mapModelEntry({ id: "m", attachments: ["text"], supports_images: true }).entry.input,
    ["text"],
    "the attachments list wins over the boolean hint",
  )
})

/* ---------------------------------------------------------------- reasoning -- */

check("supported_reasoning_levels objects map to wire spellings", () => {
  const { entry } = mapModelEntry({
    id: "m",
    reasoning: true,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
  })
  assert.deepEqual(entry.reasoningEfforts, { low: "low", medium: "medium", high: "high" })
})

check("plain-string level lists are accepted from either field", () => {
  assert.deepEqual(
    mapModelEntry({ id: "m", reasoning: true, reasoning_levels: ["LOW", "High"] }).entry.reasoningEfforts,
    { low: "low", high: "high" },
  )
  assert.deepEqual(
    mapModelEntry({ id: "m", reasoning: true, supported_reasoning_levels: ["minimal", "max"] }).entry.reasoningEfforts,
    { minimal: "minimal", max: "max" },
  )
  // supported_reasoning_levels wins when both disclose names.
  assert.deepEqual(
    mapModelEntry({
      id: "m",
      reasoning: true,
      supported_reasoning_levels: [{ effort: "high" }],
      reasoning_levels: ["low"],
    }).entry.reasoningEfforts,
    { high: "high" },
  )
})

check("WorkBuddy reasoning_supported_efforts maps to levels and has an alias", () => {
  assert.deepEqual(
    mapModelEntry({
      id: "m",
      only_reasoning: true,
      reasoning_supported_efforts: ["low", "high", "xhigh"],
    }).entry.reasoningEfforts,
    { low: "low", high: "high", xhigh: "xhigh" },
  )
  assert.deepEqual(
    mapModelEntry({
      id: "m",
      supports_reasoning: true,
      supported_reasoning_efforts: ["none", "LOW"],
    }).entry.reasoningEfforts,
    { off: null, low: "low" },
  )
  // Unknown levels keep the existing skip-with-warning behavior.
  const unknown = mapModelEntry({
    id: "gateway/wb",
    supports_reasoning: true,
    reasoning_supported_efforts: ["low", "ultra"],
  })
  assert.deepEqual(unknown.entry.reasoningEfforts, { low: "low" })
  assert.deepEqual(unknown.warnings, ["gateway/wb：跳过 DSH 不支持的推理档位 ultra"])
})

check("Magpie level sources win over the WorkBuddy arrays", () => {
  assert.deepEqual(
    mapModelEntry({
      id: "m",
      supported_reasoning_levels: [{ effort: "medium" }],
      reasoning_supported_efforts: ["low"],
    }).entry.reasoningEfforts,
    { medium: "medium" },
  )
  assert.deepEqual(
    mapModelEntry({
      id: "m",
      reasoning_levels: ["high"],
      reasoning_supported_efforts: ["low"],
    }).entry.reasoningEfforts,
    { high: "high" },
  )
  assert.deepEqual(
    mapModelEntry({
      id: "m",
      reasoning_supported_efforts: ["low"],
      supported_reasoning_efforts: ["high"],
    }).entry.reasoningEfforts,
    { low: "low" },
  )
})

check("a WorkBuddy reasoning flag without usable levels warns and omits the field", () => {
  for (const flags of [{ only_reasoning: true }, { supports_reasoning: true }, { only_reasoning: true, supports_reasoning: true }]) {
    const { entry, warnings } = mapModelEntry({ id: "gateway/wb", ...flags })
    assert.equal(Object.hasOwn(entry, "reasoningEfforts"), false)
    assert.deepEqual(warnings, ["gateway/wb：网关声明支持推理，但未提供推理档位"])
  }
  // An all-unknown level list is reported with the existing second warning.
  const unknown = mapModelEntry({
    id: "gateway/wb",
    only_reasoning: true,
    reasoning_supported_efforts: ["ultra"],
  })
  assert.equal(Object.hasOwn(unknown.entry, "reasoningEfforts"), false)
  assert.deepEqual(unknown.warnings, [
    "gateway/wb：跳过 DSH 不支持的推理档位 ultra",
    "gateway/wb：没有 DSH 支持的推理档位，已省略",
  ])
})

check("supports_reasoning:false declines reasoning only when nothing else is declared", () => {
  assert.deepEqual(mapModelEntry({ id: "m", supports_reasoning: false }).entry, {
    id: "m",
    reasoningEfforts: false,
  })
  // A disclosed level list wins over the decline.
  assert.deepEqual(
    mapModelEntry({ id: "m", supports_reasoning: false, reasoning_supported_efforts: ["low"] }).entry.reasoningEfforts,
    { low: "low" },
  )
  // A declared flag wins over the decline as well, and warns (no levels).
  const declared = mapModelEntry({ id: "gateway/wb", supports_reasoning: false, only_reasoning: true })
  assert.equal(Object.hasOwn(declared.entry, "reasoningEfforts"), false)
  assert.deepEqual(declared.warnings, ["gateway/wb：网关声明支持推理，但未提供推理档位"])
  // `reasoning: false` stays authoritative.
  assert.equal(mapModelEntry({ id: "m", reasoning: false, supports_reasoning: false }).entry.reasoningEfforts, false)
})

check("reasoning_default_effort is a single default, not a level list", () => {
  assert.deepEqual(mapModelEntry({ id: "m", reasoning_default_effort: "high" }).entry, { id: "m" })
  assert.deepEqual(mapModelEntry({ id: "m", reasoning_default_effort: "high", supports_reasoning: false }).entry, {
    id: "m",
    reasoningEfforts: false,
  })
})

check("off and none become key off with a null wire spelling", () => {
  assert.deepEqual(
    mapModelEntry({ id: "m", supported_reasoning_levels: [{ effort: "off" }] }).entry.reasoningEfforts,
    { off: null },
  )
  assert.deepEqual(
    mapModelEntry({ id: "m", reasoning: true, reasoning_levels: ["none", "low"] }).entry.reasoningEfforts,
    { off: null, low: "low" },
  )
})

check("duplicate levels are emitted once", () => {
  assert.deepEqual(
    mapModelEntry({
      id: "m",
      supported_reasoning_levels: [{ effort: "low" }, "LOW", { effort: "high" }],
    }).entry.reasoningEfforts,
    { low: "low", high: "high" },
  )
})

check("unknown levels are skipped with a warning, others survive", () => {
  const { entry, warnings } = mapModelEntry({
    id: "gateway/reasoner",
    reasoning: true,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }, { effort: "turbo" }],
  })
  assert.deepEqual(entry.reasoningEfforts, { low: "low" })
  assert.deepEqual(warnings, [
    "gateway/reasoner：跳过 DSH 不支持的推理档位 ultra",
    "gateway/reasoner：跳过 DSH 不支持的推理档位 turbo",
  ])
})

check("reasoning:true with nothing usable omits the field and warns", () => {
  const empty = mapModelEntry({ id: "gateway/x", reasoning: true, supported_reasoning_levels: [] })
  assert.equal(Object.hasOwn(empty.entry, "reasoningEfforts"), false)
  assert.deepEqual(empty.warnings, ["gateway/x：网关声明支持推理，但未提供推理档位"])

  const allUnsupported = mapModelEntry({
    id: "gateway/y",
    reasoning: true,
    supported_reasoning_levels: [{ effort: "ultra" }],
  })
  assert.equal(Object.hasOwn(allUnsupported.entry, "reasoningEfforts"), false)
  assert.deepEqual(allUnsupported.warnings, [
    "gateway/y：跳过 DSH 不支持的推理档位 ultra",
    "gateway/y：没有 DSH 支持的推理档位，已省略",
  ])
})

check("no reasoning flag and no levels omits the field silently", () => {
  const { entry, warnings } = mapModelEntry({ id: "m", name: "M" })
  assert.equal(Object.hasOwn(entry, "reasoningEfforts"), false)
  assert.deepEqual(warnings, [])
})

/* ------------------------------------------------------ WorkBuddy fixture -- */

check("the WorkBuddy fixture maps its own spellings and warns only for the undisclosed model", () => {
  const { models, warnings } = mapModelListing(workbuddyFixture)
  assert.deepEqual(
    models.map((model) => model.id),
    workbuddyFixture.data.map((raw) => raw.id),
  )
  const byId = new Map(models.map((model) => [model.id, model]))

  assert.deepEqual(byId.get("cn:kimi-k3-1"), {
    id: "cn:kimi-k3-1",
    name: "Kimi-K3",
    contextWindow: 1000000,
    maxTokens: 32000,
    input: ["text", "image"],
    reasoningEfforts: { low: "low", high: "high", xhigh: "xhigh" },
  })
  assert.deepEqual(byId.get("cn:glm-5.3"), {
    id: "cn:glm-5.3",
    name: "GLM-5.3",
    contextWindow: 1000000,
    maxTokens: 64000,
    input: ["text", "image"],
    reasoningEfforts: { low: "low", high: "high", max: "max" },
  })
  assert.deepEqual(byId.get("cn:hy4-preview-ctrl"), {
    id: "cn:hy4-preview-ctrl",
    name: "Hy4 preview",
    contextWindow: 960000,
    maxTokens: 64000,
    input: ["text", "image"],
    reasoningEfforts: { high: "high" },
  })

  // `only_reasoning` with no `reasoning_supported_efforts` is the warning path.
  assert.equal(Object.hasOwn(byId.get("cn:hy3-b"), "reasoningEfforts"), false)
  assert.deepEqual(byId.get("cn:hy3-b").input, ["text", "image"])

  // A non-reasoning model discloses modalities only; the boolean decline is a
  // reasoning disclosure on the image model, which also discloses no input.
  assert.deepEqual(byId.get("cn:deepseek-v3-1"), {
    id: "cn:deepseek-v3-1",
    name: "DeepSeek-V3.1",
    contextWindow: 96000,
    maxTokens: 32000,
    input: ["text", "image"],
  })
  assert.deepEqual(byId.get("cn:hunyuan-image-alpha"), {
    id: "cn:hunyuan-image-alpha",
    name: "Hunyuan Image Alpha",
    contextWindow: 1000000,
    reasoningEfforts: false,
  })

  assert.deepEqual(warnings, ["cn:hy3-b：网关声明支持推理，但未提供推理档位"])
})

/* ------------------------------------------------------------ listing shapes */

check("a models map envelope uses the key as the id when none is disclosed", () => {
  const { models, warnings } = mapModelListing({
    models: {
      "magpie/router": { display_name: "Router", context_window: 64000, max_output_tokens: 8000 },
    },
  })
  assert.deepEqual(models, [
    { id: "magpie/router", name: "Router", contextWindow: 64000, maxTokens: 8000 },
  ])
  assert.deepEqual(warnings, [])
})

check("a models map entry keeps its own id when it discloses one", () => {
  const { models } = mapModelListing({
    models: { alias: { id: "canonical-id", display_name: "Canonical" } },
  })
  assert.deepEqual(models, [{ id: "canonical-id", name: "Canonical" }])
})

check("a models map ignores primitive directory metadata", () => {
  const { models } = mapModelListing({
    models: {
      object: "list",
      created: 0,
      "gateway/real": { display_name: "Real" },
    },
  })
  assert.deepEqual(models, [{ id: "gateway/real", name: "Real" }])
})

check("a data array wins over a models map", () => {
  const { models } = mapModelListing({
    data: [{ id: "from-data" }],
    models: { "from-map": { display_name: "Map" } },
  })
  assert.deepEqual(models, [{ id: "from-data" }])
})

check("malformed listings throw a descriptive error", () => {
  for (const body of [null, "text", 7, [], {}, { data: {} }, { models: [] }, { models: "x" }]) {
    assert.throws(() => mapModelListing(body), /模型列表|JSON/, `expected a throw for ${JSON.stringify(body)}`)
  }
  assert.throws(() => parseModelListing({ data: "x" }), /模型列表/)
})

check("entries without a usable id are skipped with a warning", () => {
  const { models, warnings } = mapModelListing({
    data: [
      { display_name: "No Id" },
      { id: "   ", display_name: "Blank Id" },
      { id: "kept", display_name: "Kept" },
    ],
  })
  assert.deepEqual(models, [{ id: "kept", name: "Kept" }])
  assert.equal(warnings.length, 2)
  assert.ok(warnings[0].includes("缺少模型 id"))
  assert.ok(warnings[1].includes("缺少模型 id"))
})

check("a non-object entry is skipped, not fatal", () => {
  const { models, warnings } = mapModelListing({ data: ["nope", { id: "kept" }] })
  assert.deepEqual(models, [{ id: "kept" }])
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes("缺少模型 id"))
})

check("mapModelEntry accepts a fallback id for map-style callers", () => {
  const { entry, warnings } = mapModelEntry({ display_name: "Fallback" }, { id: "gateway/fallback" })
  assert.deepEqual(entry, { id: "gateway/fallback", name: "Fallback" })
  assert.deepEqual(warnings, [])
  const anonymous = mapModelEntry({ display_name: "Anonymous" }, { index: 1 })
  assert.equal(anonymous.entry, null)
  assert.ok(anonymous.warnings[0].startsWith("第 2 个条目："))
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
