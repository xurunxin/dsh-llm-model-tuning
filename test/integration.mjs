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
 * Run: node test/integration.mjs
 */
import { boot, opened, modelRows, choice, button, textOf, settle, storedProfile, fixtureUser, findAll } from "./harness.mjs"
import { loadAdapterConfig, reportSkip } from "./dsh-adapter.mjs"

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

await check("the card's written models section is accepted by the real adapter", async () => {
  const handle = boot()
  let tree = opened(handle)

  // Give the first model an off + high effort set and image input.
  let rows = modelRows(tree)
  choice(rows[0], "自定义档位").props.onChange()
  tree = opened(handle)
  rows = modelRows(tree)
  choice(rows[0], "关闭 (off)").props.onChange()
  tree = opened(handle)
  rows = modelRows(tree)
  choice(rows[0], "图像").props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => handle.form.calls.length > 0)

  const written = storedProfile(handle)
  const failure = judge({ providers: { exampleGateway: written } })
  assert(failure === undefined, `the adapter refused the card's own output: ${failure}`)
  assert(written.models[0].reasoningEfforts.off === null, "off was written as an explicit null")
  assert(written.models[0].reasoningEfforts.high === "high", "the high level kept its wire value")
})

await check("a card-edited modelOverrides dict is accepted by the real adapter", async () => {
  const handle = boot({ provider: "catalogroute" })
  let tree = opened(handle)
  const rows = modelRows(tree)
  choice(rows[0], "图像").props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
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
})

await check("the card's provider-level defaultInput is accepted by the real adapter", async () => {
  const handle = boot()
  let tree = opened(handle)
  const group = findAll(
    tree,
    (node) =>
      node.props?.className === "dsh-mtune-group" &&
      findAll(node, (child) => child.type === "span" && textOf(child).includes("本供应商默认输入模态")).length > 0,
  )[0]
  const imageLabel = findAll(group, (node) => node.type === "label" && textOf(node).includes("图像"))[0]
  findAll(imageLabel, (node) => node.type === "input")[0].props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
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
  for (const label of ["图像", "关闭推理", "自定义档位"]) {
    let tree = opened(handle)
    const rows = modelRows(tree)
    if (label === "关闭推理" && choice(rows[0], "关闭推理").props.checked) continue
    choice(rows[0], label).props.onChange()
    tree = opened(handle)
    const save = findAll(tree, (node) => node.type === "button" && textOf(node).trim() === "保存")[0]
    if (save?.props.disabled === true) continue
    save.props.onClick()
    await settle(() => handle.form.calls.length > writes, 20)
    writes = handle.form.calls.length
    const written = storedProfile(handle)
    const failure = judge({ providers: { exampleGateway: written } })
    assert(failure === undefined, `after toggling "${label}" the adapter refused the section: ${failure}`)
  }
  assert(writes > 0, "the sweep performed at least one write")
})

await check("a fixture starting from the user's real settings shape stays valid", async () => {
  const handle = boot({ user: fixtureUser() })
  const written = storedProfile(handle)
  const failure = judge({ providers: { exampleGateway: written, catalogroute: written === undefined ? written : handle.form.stored().providers.catalogroute } })
  assert(failure === undefined, `the untouched fixture is adapter-valid: ${failure}`)
})

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}`)
  if (!entry.ok) console.log(`      ${entry.error}`)
}
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
if (failed.length > 0) process.exitCode = 1
