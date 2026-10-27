/**
 * Integration test: drive the REAL card through its own UI, then hand the exact
 * section it wrote to the REAL `llm-pi-ai` adapter schema.
 *
 * The unit suite proves the card produces the ops it intends, and the
 * conformance suite proves hand-written documents satisfy the adapter. Neither
 * covers the seam between them: a card could write a perfectly-shaped op that
 * the adapter still refuses. This test closes that gap by making the adapter's
 * own exported `Config` schema the judge of the card's own output.
 *
 * The gateway-import checks go one step further: they run the REAL mapping
 * module over the saved live Magpie listing, answer the card's import call with
 * that host-shaped payload, walk the NEW 选择要添加的模型 dialog (confirming it
 * with 添加所选), click 保存, and judge the written section with the same real
 * schema — including the overwrite semantics: a selected existing model has its
 * managed fields replaced, fields the gateway stopped disclosing cleared, and
 * unmanaged raw fields preserved.
 *
 * Run: node test/integration.mjs
 */
import { readFileSync } from "node:fs"
import {
  boot,
  opened,
  modelRows,
  choice,
  button,
  textOf,
  settle,
  storedProfile,
  fixtureUser,
  findAll,
  stubFetch,
  jsonResponse,
  importStatus,
  defaultInputGroup,
  dialogOpen,
  candidateIds,
  candidateBadge,
  candidateRow,
  openPicker,
  confirmPicker,
  setKind,
  kindSelect,
  levelRowEntries,
  addLevelButton,
  expandModel,
  toggleChoice,
  selectValue,
  click,
} from "./harness.mjs"
import { loadAdapterConfig, reportSkip } from "./dsh-adapter.mjs"
import { mapModelListing } from "../lib/magpie.js"

const Config = await loadAdapterConfig()
if (Config === undefined) {
  reportSkip("integration")
  process.exit(0)
}

/** Validate one written section against the adapter's real schema. */
function judge(section) {
  try {
    Config(section)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(canonical(actual))
  const b = JSON.stringify(canonical(expected))
  if (a !== b) throw new Error(`${message}\n    actual:   ${a}\n    expected: ${b}`)
}

/** Sort object keys recursively so assertions compare shape, not key order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

/**
 * Open one model row's editor, declare a custom level set (the seeded level plus
 * the optional off level) and return the tree.
 */
function declareCustomEfforts(handle, index, wire = "high") {
  let { tree, row } = expandModel(handle, index)
  setKind(row, "自定义档位")
  tree = handle.draw()
  row = modelRows(tree)[index]
  click(addLevelButton(row))
  tree = handle.draw()
  row = modelRows(tree)[index]
  for (const entry of levelRowEntries(tree, row)) {
    if (entry.level !== "off" && entry.input !== undefined) {
      entry.input.props.onChange({ target: { value: wire }, currentTarget: { value: wire }, preventDefault() {} })
    }
  }
  return handle.draw()
}

/** Click 保存 and wait for the settings write to settle; returns the stored route. */
async function saveOnce(handle) {
  const before = handle.form.calls.length
  click(button(opened(handle), "保存"))
  await settle(() => handle.form.calls.length > before)
  return storedProfile(handle)
}

await check("the card's written models section is accepted by the real adapter", async () => {
  const handle = boot()
  let tree = opened(handle)

  // Give the first model a custom effort set and image input.
  tree = declareCustomEfforts(handle, 0)
  const { row } = expandModel(handle, 0)
  toggleChoice(choice(row, "图片"))
  tree = opened(handle)
  click(button(tree, "保存"))
  await settle(() => handle.form.calls.length > 0)

  const written = storedProfile(handle)
  const failure = judge({ providers: { exampleGateway: written } })
  assert(failure === undefined, `the adapter refused the card's own output: ${failure}`)
  const efforts = written.models[0].reasoningEfforts
  assert(efforts !== null && typeof efforts === "object", "a custom set is written as a dict")
  assert(efforts.off === null, "off was written as an explicit null")
  const nonOff = Object.keys(efforts).filter((level) => level !== "off")
  assert(nonOff.length > 0, "the custom set carries a level beyond off")
  assert(
    nonOff.every((level) => efforts[level] === "high"),
    "every edited level kept its wire value",
  )
})

await check("a card-edited modelOverrides dict is accepted by the real adapter", async () => {
  const handle = boot({ provider: "catalogroute" })
  const { tree: expanded, row } = expandModel(handle, 0)
  toggleChoice(choice(row, "图片"))
  const tree = handle.draw()
  void expanded

  click(button(tree, "保存"))
  await settle(() => handle.form.calls.length > 0)

  const written = storedProfile(handle)
  const failure = judge({ providers: { catalogroute: written } })
  assert(failure === undefined, `the adapter refused the card's own output: ${failure}`)
  assert(
    written.modelOverrides["some-catalog-model"].input.join(",") === "text,image",
    "the override carries both modalities",
  )
  assert(
    written.modelOverrides["some-catalog-model"].contextWindow === 200000,
    "the unrelated override field survived",
  )
  assert(
    written.modelOverrides["some-catalog-model"].compat !== undefined,
    "the unmanaged override field survived",
  )
})

await check("the card's provider-level defaultInput is accepted by the real adapter", async () => {
  const handle = boot()
  const tree = opened(handle)
  const group = defaultInputGroup(tree)
  const imageLabel = findAll(group, (node) => node.type === "label" && textOf(node).includes("图片"))[0]
  toggleChoice(findAll(imageLabel, (node) => node.type === "input")[0])
  const dirty = handle.draw()
  click(button(dirty, "保存"))
  await settle(() => handle.form.calls.length > 0)

  const written = storedProfile(handle)
  const failure = judge({ providers: { exampleGateway: written } })
  assert(failure === undefined, `the adapter refused the card's own output: ${failure}`)
  assert(written.defaultInput.join(",") === "text,image", "the fallback is text+image")
})

await check("every write the card produces leaves the whole section adapter-valid", async () => {
  // A broader sweep: toggle every optional control in turn and re-validate the
  // section after each write, so no single edit can corrupt the document.
  const handle = boot()
  let writes = 0
  const steps = [
    { name: "图片", apply: () => toggleChoice(choice(modelRows(handle.draw())[0], "图片")) },
    { name: "关闭推理", apply: () => setKind(modelRows(handle.draw())[0], "关闭推理") },
    { name: "自定义档位", apply: () => setKind(modelRows(handle.draw())[0], "自定义档位") },
  ]
  for (const step of steps) {
    let tree = opened(handle)
    // Expanded row needed for the controls.
    tree = expandModel(handle, 0).tree
    if (step.name === "关闭推理" && selectValue(kindSelect(modelRows(tree)[0])) === "none") continue
    step.apply()
    tree = handle.draw()
    const save = findAll(tree, (node) => node.type === "button" && textOf(node).trim() === "保存")[0]
    if (save?.props.disabled === true) continue
    click(save)
    await settle(() => handle.form.calls.length > writes, 20)
    writes = handle.form.calls.length
    const written = storedProfile(handle)
    const failure = judge({ providers: { exampleGateway: written } })
    assert(failure === undefined, `after toggling "${step.name}" the adapter refused the section: ${failure}`)
  }
  assert(writes > 0, "the sweep performed at least one write")
})

await check("a fixture starting from the user's real settings shape stays valid", async () => {
  const handle = boot({ user: fixtureUser() })
  const written = storedProfile(handle)
  const failure = judge({
    providers: {
      exampleGateway: written,
      catalogroute: written === undefined ? written : handle.form.stored().providers.catalogroute,
    },
  })
  assert(failure === undefined, `the untouched fixture is adapter-valid: ${failure}`)
})

/* -------------------------------------------------- gateway-import integration */

/**
 * The REAL host answer for one import: the host maps the gateway listing with
 * `lib/magpie.js`, so build the same payload here by running the real mapping
 * module over the saved live Magpie listing. One entry overwrites a model the
 * fixture already stores; three brand-new Magpie models are appended.
 */
const magpieListing = mapModelListing(JSON.parse(readFileSync(new URL("./fixtures/magpie-models.json", import.meta.url), "utf8")))
const IMPORTED_IDS = ["group/never-stuck", "claude/claude-haiku-5-5", "codex/gpt-6.1-sol"]
const gatewayModels = [
  {
    id: "auto",
    name: "Auto (Magpie)",
    contextWindow: 200000,
    maxTokens: 64000,
    input: ["text", "image"],
    reasoningEfforts: { low: "low", medium: "medium", high: "high" },
  },
  ...IMPORTED_IDS.map((id) => {
    const model = magpieListing.models.find((entry) => entry.id === id)
    if (model === undefined) throw new Error(`fixtures/magpie-models.json no longer maps ${id}`)
    return model
  }),
]
const gatewayWarnings = magpieListing.warnings.filter((warning) => IMPORTED_IDS.some((id) => warning.includes(id)))
/** The payload `POST /api/dsh-llm-model-tuning/models` answers with. */
const gatewayAnswer = () => jsonResponse({ ok: true, models: gatewayModels, warnings: gatewayWarnings })
/**
 * Exactly what the fixture's `models` list must contain after one import: the
 * selected existing `auto` entry overwritten (its unmanaged `compat` kept), the
 * gateway-missing `deepseek-v4.1-flash` untouched, then the new ids appended.
 */
const expectedAfterImport = [
  { ...gatewayModels[0], compat: { supportsStore: true } },
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
  ...gatewayModels.slice(1),
]

/**
 * Click 获取可用模型, wait for the dialog, optionally adjust the selection,
 * confirm with 添加所选, wait for the status line, and return the redrawn tree.
 */
async function importOnce(handle, stub, expectedStatus, adjust) {
  const before = stub.calls.length
  click(button(opened(handle), "获取可用模型"))
  await settle(() => stub.calls.length > before)
  await settle(() => dialogOpen(handle.draw()) || importStatus(handle.draw()) !== undefined)
  let tree = handle.draw()
  if (dialogOpen(tree)) {
    if (typeof adjust === "function") {
      adjust(tree)
      tree = handle.draw()
    }
    tree = await confirmPicker(handle)
  }
  await settle(() => {
    const status = importStatus(handle.draw())
    return status !== undefined && textOf(status).includes(expectedStatus)
  })
  return handle.draw()
}

await check("a card-imported Magpie section is accepted by the real adapter", async () => {
  const handle = boot()
  const stub = stubFetch(gatewayAnswer)
  try {
    const tree = await importOnce(handle, stub, "已导入 4 个模型（新增 3、覆盖 1）")

    // The dialog is the gate: while it is open nothing has been merged.
    assertEqual(handle.form.calls.length, 0, "clicking import performs no settings write")
    assertEqual(stub.calls.length, 1, "the card called the import route once")
    assertEqual(stub.calls[0].url, "api/dsh-llm-model-tuning/models", "the route is same-origin and browser-relative")
    assertEqual(stub.calls[0].init.method, "POST", "the import is a POST")
    assertEqual(
      JSON.parse(stub.calls[0].init.body),
      { provider: "exampleGateway", settingsNs: "llm-pi-ai" },
      "the body names the provider and the settings namespace",
    )
    assertEqual(modelRows(opened(handle)).length, 5, "two stored models plus three appended gateway models")
    const status = importStatus(tree)
    assertEqual(status.props.className.includes("dsh-mtune-ok"), true, "a successful import uses the ok class")
    assert(textOf(status).includes("跳过 DSH 不支持的推理档位 ultra"), "the host warnings are surfaced")

    const written = await saveOnce(handle)
    const failure = judge({ providers: { exampleGateway: written } })
    assert(failure === undefined, `the adapter refused the imported section: ${failure}`)
    assertEqual(written.models, expectedAfterImport, "the overwritten and imported entries were written verbatim")

    const haiku = written.models.find((model) => model.id === "claude/claude-haiku-5-5")
    assertEqual(haiku.contextWindow, 1000000, "haiku contextWindow from context_window")
    assertEqual(haiku.maxTokens, 128000, "haiku maxTokens from max_output_tokens")
    assertEqual(haiku.input, ["text", "image"], "pdf was skipped; text+image kept")
    assertEqual(
      Object.keys(haiku.reasoningEfforts).sort(),
      ["high", "low", "max", "medium", "xhigh"],
      "the five disclosed reasoning levels map 1:1 (wire spelling = disclosed name)",
    )

    const neverStuck = written.models.find((model) => model.id === "group/never-stuck")
    assertEqual("ultra" in neverStuck.reasoningEfforts, false, "the unsupported ultra level was skipped")
    assertEqual(neverStuck.input, ["text", "image"], "never-stuck keeps its disclosed modalities")

    const untouched = written.models.find((model) => model.id === "deepseek-v4.1-flash")
    assertEqual(
      untouched,
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
      "a model the gateway did not return is untouched",
    )
  } finally {
    stub.restore()
  }
})

await check("the dialog lists the mapped candidates with 新增/覆盖 badges before importing", async () => {
  const handle = boot()
  const stub = stubFetch(gatewayAnswer)
  try {
    const tree = await openPicker(handle)
    const ids = candidateIds(tree)
    // gatewayModels is [auto, ...IMPORTED_IDS], so the dialog keeps that order.
    assertEqual(ids, ["auto", ...IMPORTED_IDS], "gateway order is preserved")
    assertEqual(candidateBadge(candidateRow(tree, "auto")), "覆盖", "the stored id is marked 覆盖")
    for (const id of IMPORTED_IDS) {
      assertEqual(candidateBadge(candidateRow(tree, id)), "新增", `the gateway-only ${id} is marked 新增`)
    }
    assertEqual(handle.form.calls.length, 0, "opening the dialog writes nothing")
    // Cancel out of the dialog; the draft and the settings stay untouched.
    click(button(tree, "取消"))
    await settle(() => dialogOpen(handle.draw()) === false)
    assertEqual(modelRows(opened(handle)).length, 2, "cancelling leaves the draft untouched")
  } finally {
    stub.restore()
  }
})

await check("importing the same Magpie answer twice is idempotent", async () => {
  const handle = boot()
  const stub = stubFetch(gatewayAnswer)
  try {
    await importOnce(handle, stub, "已导入 4 个模型（新增 3、覆盖 1）")
    const first = await saveOnce(handle)

    await importOnce(handle, stub, "已导入 4 个模型（新增 0、覆盖 4）")
    const tree = opened(handle)
    // The second merge is shape-identical: the draft is not dirty and the
    // stored section is already exactly what the import would write.
    assertEqual(button(tree, "保存").props.disabled, true, "an identical second import leaves nothing to save")
    assertEqual(handle.form.calls.length, 1, "only the first import needed a save")
    const second = storedProfile(handle)
    assertEqual(second, first, "a second import leaves the section identical")
    const ids = second.models.map((model) => model.id)
    assertEqual(ids, expectedAfterImport.map((model) => model.id), "model order is stable across imports")
    assertEqual(new Set(ids).size, ids.length, "no duplicate model ids after the second import")
    const failure = judge({ providers: { exampleGateway: second } })
    assert(failure === undefined, `the adapter refused the re-imported section: ${failure}`)

    // The harness drives the handler directly, so force the write too: the
    // idempotent section is proven at the settings layer as well.
    click(button(tree, "保存"))
    await settle(() => handle.form.calls.length > 1)
    assertEqual(storedProfile(handle), first, "even a forced second write produces the identical section")
  } finally {
    stub.restore()
  }
})

await check("an overwrite that stops disclosing a field clears it and stays adapter-valid", async () => {
  const user = fixtureUser()
  const auto = user.providers.exampleGateway.models[0]
  auto.input = ["text", "image"]
  auto.reasoningEfforts = { low: "low", high: "high" }
  const handle = boot({ user })
  // The gateway still lists `auto` but no longer discloses its name, output
  // cap, modalities or reasoning levels: the overwrite must clear all four.
  const stub = stubFetch(() =>
    jsonResponse({
      ok: true,
      models: [{ id: "auto", contextWindow: 300000 }],
      warnings: [],
    }),
  )
  try {
    await importOnce(handle, stub, "已导入 1 个模型（新增 0、覆盖 1）")
    const written = await saveOnce(handle)
    const failure = judge({ providers: { exampleGateway: written } })
    assert(failure === undefined, `the adapter refused the cleared section: ${failure}`)
    assertEqual(
      written.models[0],
      { id: "auto", contextWindow: 300000, compat: { supportsStore: true } },
      "managed fields the candidate stopped disclosing are cleared; unmanaged compat survives",
    )
    assertEqual(
      written.models[1],
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
      "the model the gateway did not return is untouched",
    )
    const { row } = expandModel(handle, 0)
    assert(textOf(row).includes("上下文 300,000"), "the rebuilt controls show the overwritten capacity")
    assert(button(opened(handle), "保存").props.disabled === true, "the rebuilt draft is not left dirty")
  } finally {
    stub.restore()
  }
})

await check("deselecting a candidate in the dialog leaves that model untouched", async () => {
  const user = fixtureUser()
  const auto = user.providers.exampleGateway.models[0]
  auto.input = ["text", "image"]
  auto.reasoningEfforts = { low: "low", high: "high" }
  const handle = boot({ user })
  const stub = stubFetch(() =>
    jsonResponse({
      ok: true,
      models: [
        { id: "auto", contextWindow: 900000 },
        { id: "brand-new", name: "Brand New", contextWindow: 4096, maxTokens: 1024 },
      ],
      warnings: [],
    }),
  )
  try {
    await importOnce(handle, stub, "已导入 1 个模型（新增 1、覆盖 0）", (tree) => {
      // Keep the new model's checkbox, drop auto: only the new model imports.
      const autoBox = findAll(tree, (node) => node.type === "input" && node.props?.["data-mtune-candidate"] === "auto")[0]
      toggleChoice(autoBox)
    })
    const written = await saveOnce(handle)
    const failure = judge({ providers: { exampleGateway: written } })
    assert(failure === undefined, `the adapter refused the section: ${failure}`)
    assertEqual(written.models.length, 3, "only the selected new model was appended")
    assertEqual(
      written.models[0],
      { id: "auto", name: "Auto", contextWindow: 168000, maxTokens: 32000, input: ["text", "image"], reasoningEfforts: { low: "low", high: "high" }, compat: { supportsStore: true } },
      "the unselected existing model is byte-for-byte untouched",
    )
    assertEqual(written.models[2].id, "brand-new", "the selected new model was appended")
  } finally {
    stub.restore()
  }
})

await check("a Magpie import in modelOverrides mode only updates shown ids, adapter-valid", async () => {
  const handle = boot({ provider: "catalogroute" })
  const stub = stubFetch(() =>
    jsonResponse({
      ok: true,
      models: [
        {
          id: "some-catalog-model",
          name: "Some Catalog Model",
          contextWindow: 300000,
          maxTokens: 64000,
          input: ["text", "image"],
          reasoningEfforts: { low: "low", high: "high" },
        },
        // A gateway-only id cannot become an override: it must be skipped, not invented.
        { id: "gateway-only-model", name: "Gateway Only", contextWindow: 1000 },
      ],
      warnings: [],
    }),
  )
  try {
    const tree = await importOnce(handle, stub, "跳过 1 个新模型")
    assert(
      textOf(importStatus(tree)).includes("已导入 1 个模型（新增 0、覆盖 1）"),
      "the updated override is reported (N counts entries produced, not gateway rows)",
    )
    assertEqual(handle.form.calls.length, 0, "import alone wrote nothing")

    const written = await saveOnce(handle)
    const failure = judge({ providers: { catalogroute: written } })
    assert(failure === undefined, `the adapter refused the imported override: ${failure}`)
    assertEqual(
      written.modelOverrides["some-catalog-model"],
      {
        name: "Some Catalog Model",
        contextWindow: 300000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoningEfforts: { low: "low", high: "high" },
        compat: { supportsStore: true },
      },
      "the existing override has every managed field overwritten and its unmanaged compat kept",
    )
    assertEqual("gateway-only-model" in written.modelOverrides, false, "a gateway-only model was not invented as an override")
  } finally {
    stub.restore()
  }
})

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}`)
  if (!entry.ok) console.log(`      ${entry.error}`)
}
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
if (failed.length > 0) process.exitCode = 1
