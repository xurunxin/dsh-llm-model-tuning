/**
 * Offline harness for the `dsh-llm-model-tuning` client half.
 *
 * It loads the real bundle file with a stubbed module loader, React, and
 * settings scope, then drives the card through its own inputs. The settings
 * write path is reproduced faithfully enough to catch the two things most
 * likely to break in production: a path op that the Host's walker refuses, and
 * a write that silently does not land.
 *
 * Run: node test/harness.mjs
 */
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, "..", "lib", "client.js")

/* ------------------------------------------------------------------ fixtures */

/**
 * The stored `llm-pi-ai` user section used as the starting document. It mirrors
 * the shape a real custom-provider profile has: a `models` list whose entries
 * carry capacities but neither effort nor modalities yet.
 */
function fixtureUser() {
  return {
    providers: {
      exampleGateway: {
        apiKeyEnv: "MY_GATEWAY_API_KEY",
        api: "openai-completions",
        baseURL: "https://gateway.example.com/v1",
        models: [
          { id: "auto", name: "Auto", contextWindow: 168000, maxTokens: 32000 },
          { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
        ],
      },
      catalogroute: {
        apiKeyEnv: "CATALOG_API_KEY",
        modelOverrides: {
          "some-catalog-model": { contextWindow: 200000 },
        },
      },
    },
  }
}

/* ------------------------------------------------- settings write semantics */

/** Whether a value is a plain data object — the walker refuses to descend arrays. */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Faithful copy of the Host's path-op application, including its array refusal. */
function applyPathOp(section, op) {
  const [head, ...rest] = op.path
  if (head === undefined) {
    if (op.op === "unset") return {}
    if (!isPlainObject(op.value)) throw new TypeError("settings mutate: setting the section root requires a plain object")
    return { ...op.value }
  }
  if (rest.length === 0) {
    if (op.op === "set") return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) {
    if (op.op === "unset") return section
    return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

/** Deep clone through JSON, matching how the transport copies its arguments. */
const clone = (value) => JSON.parse(JSON.stringify(value))

/* ------------------------------------------------------------ fake settings */

/**
 * A stand-in `ConfigFormController` modelling the real one: a stored user layer,
 * a revision fence, and a `mutate` that applies only the ops it can validate and
 * REPORTS whether it accepted them. A rejected write still changes nothing, so a
 * card that ignored the return value would be caught here.
 */
function makeForm(user, options = {}) {
  const listeners = new Set()
  const state = {
    user,
    revision: 3,
    writable: options.writable !== false,
    /** Validate-then-apply, like the Host. Returns false when refused. */
    apply(ops) {
      let next = clone(state.user)
      try {
        for (const op of ops) next = applyPathOp(next, op)
      } catch {
        return false
      }
      if (options.refuse === true) return false
      state.user = next
      state.revision += 1
      return true
    },
  }
  const form = {
    calls: [],
    getSnapshot: () => ({
      status: "ready",
      value: clone(state.user),
      base: undefined,
      user: clone(state.user),
      revision: state.revision,
      writable: state.writable,
      mode: "host",
    }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /**
     * `ConfigFormController.mutate` resolves to whether the Host ACCEPTED the
     * write, after any recovery read. The harness reproduces that contract — a
     * stub that resolved `undefined` would let a card mistake a refusal for
     * success, which is exactly the defect this fixture exists to catch.
     */
    async mutate(ops) {
      form.calls.push(clone(ops))
      const accepted = state.apply(ops)
      if (accepted) for (const listener of listeners) listener()
      return accepted
    },
    stored: () => clone(state.user),
    revision: () => state.revision,
  }
  return form
}

/* -------------------------------------------------------------- fake React  */

/**
 * A minimal hooks implementation with the ordering rules the card relies on.
 * `useState`, `useMemo`, and `useEffect` all consume one slot in call order, so
 * a render that reorders them would break exactly as it would in React.
 */
function createReact() {
  let cursor = 0
  const cells = []
  const effects = []
  const cleanups = []
  let dirty = false

  const React = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      const index = cursor++
      if (cells[index] === undefined) cells[index] = { value: typeof initial === "function" ? initial() : initial }
      const cell = cells[index]
      return [
        cell.value,
        (next) => {
          const value = typeof next === "function" ? next(cell.value) : next
          if (!Object.is(value, cell.value)) {
            cell.value = value
            dirty = true
          }
        },
      ]
    },
    useMemo(factory, deps) {
      const index = cursor++
      const cell = cells[index]
      if (cell === undefined || !sameDeps(cell.deps, deps)) cells[index] = { deps, memo: factory() }
      return cells[index].memo
    },
    useEffect(effect, deps) {
      const index = cursor++
      const cell = cells[index]
      if (cell === undefined || !sameDeps(cell.deps, deps)) {
        cells[index] = { deps }
        effects.push(effect)
      }
    },
  }

  function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  }

  /**
   * Expand a tree the way React would: a function-typed element is invoked with
   * its props and its result expanded in turn, so the harness sees the real
   * host elements rather than a tree of component references. Only the root
   * card consumes hooks, so one cursor across a full pass is faithful here.
   */
  function expand(node) {
    if (node === null || node === undefined || typeof node !== "object") return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === "function") return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
  }

  return {
    React,
    /** Render once, then keep re-rendering until no state update is pending. */
    render(thunk) {
      let guard = 0
      let tree
      do {
        dirty = false
        cursor = 0
        effects.length = 0
        tree = expand(thunk())
        for (const effect of effects) {
          const cleanup = effect()
          if (typeof cleanup === "function") cleanups.push(cleanup)
        }
        guard += 1
        if (guard > 50) throw new Error("harness: render did not settle (state update loop)")
      } while (dirty)
      return tree
    },
    unmount() {
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
    },
  }
}

/* ------------------------------------------------------------- tree helpers */

/** Every node in a render tree, depth first, skipping primitives. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  out.push(node)
  walk(node.props?.children, out)
  return out
}

/** Find the first element matching a predicate. */
function find(tree, predicate) {
  return walk(tree).find((node) => predicate(node))
}

/** Find every element matching a predicate. */
function findAll(tree, predicate) {
  return walk(tree).filter((node) => predicate(node))
}

/** The visible text of a subtree, for asserting labels. */
function textOf(node) {
  if (node === null || node === undefined) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  return textOf(node.props?.children)
}

/** Find a button by its label. */
function button(tree, label) {
  const found = find(tree, (node) => node.type === "button" && textOf(node).trim() === label)
  if (found === undefined) throw new Error(`harness: no button labelled "${label}"`)
  return found
}

/** Find a checkbox/radio whose label text contains the given fragment. */
function choice(tree, fragment) {
  const found = find(
    tree,
    (node) =>
      node.type === "label" &&
      textOf(node).includes(fragment) &&
      node.props?.children?.[0]?.type === "input",
  )
  if (found === undefined) throw new Error(`harness: no choice labelled "${fragment}"`)
  return found.props.children[0]
}

/** Find a text input by its placeholder. */
function input(tree, placeholder) {
  const found = find(tree, (node) => node.type === "input" && node.props?.placeholder === placeholder)
  if (found === undefined) throw new Error(`harness: no input with placeholder "${placeholder}"`)
  return found
}

/**
 * Find the single ENABLED input carrying a placeholder. A checked level enables
 * its wire field and an unchecked one renders the same field disabled, so only
 * the enabled match identifies the level actually being edited.
 */
function enabledInput(tree, placeholder) {
  const found = findAll(
    tree,
    (node) => node.type === "input" && node.props?.placeholder === placeholder && node.props?.disabled !== true,
  )
  if (found.length !== 1) {
    throw new Error(`harness: expected exactly one enabled "${placeholder}" input, found ${String(found.length)}`)
  }
  return found[0]
}

/** The provider-level default-input group. */
function defaultInputGroup(tree) {
  const found = find(
    tree,
    (node) =>
      node.props?.className === "dsh-mtune-group" &&
      findAll(node, (child) => child.type === "span" && textOf(child).includes("本供应商默认输入模态")).length > 0,
  )
  if (found === undefined) throw new Error("harness: no default-input group")
  return found
}

/** Read a node's class name, tolerating the absence of props. */
function classNameOf(node) {
  return node.props?.className
}

/** Every model row in a tree. */
function modelRows(tree) {
  return findAll(tree, (node) => classNameOf(node) === "dsh-mtune-model")
}

/* ------------------------------------------------------------- bundle loader */

/** Install the browser globals the bundle expects. Called once, never restored:
 * `apply()` runs at boot time, after the bundle has already been evaluated. */
const styleTags = []
function installGlobals() {
  globalThis.document = {
    getElementById: (id) => styleTags.find((tag) => tag.id === id) ?? null,
    createElement: () => {
      const tag = {
        id: "",
        textContent: "",
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        remove() {
          styleTags.splice(styleTags.indexOf(tag), 1)
        },
      }
      return tag
    },
    // Faithful to the DOM: the tag really lands in `head`, so a test can assert
    // on what the plugin installed instead of trusting a no-op stub.
    head: {
      append: (tag) => styleTags.push(tag),
      appendChild: (tag) => styleTags.push(tag),
    },
  }
}

/** Load the real bundle with stubbed globals and return its exports. */
function loadBundle(React) {
  const source = readFileSync(clientPath, "utf8")
  let registration
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  // A real bundle is invoked with `require` ALONE: `styles` is a dynamic-Plugin
  // sandbox builtin and is deliberately not passed here, so a bundle that
  // depends on it fails in this harness exactly as it would in the browser.
  // eslint-disable-next-line no-new-func
  new Function("require", source)((specifier) => {
    if (specifier === "react") return React
    throw new Error(`harness: unexpected require("${specifier}")`)
  })
  if (registration === undefined) throw new Error("harness: bundle did not register with __ModuleLoader__")
  if (registration.id !== "dsh-llm-model-tuning") throw new Error(`harness: unexpected bundle id "${registration.id}"`)
  return registration.factory((specifier) => {
    if (specifier === "react") return React
    throw new Error(`harness: unexpected require("${specifier}")`)
  })
}

/* ------------------------------------------------------------------- runner */

const results = []
const pending = []
function check(name, fn) {
  // Registered in order; the runner awaits each so a rejected promise inside a
  // test body is a FAIL rather than an unhandled rejection nobody sees.
  pending.push({ name, fn })
}

/**
 * Drain microtasks until the given predicate holds or the budget runs out.
 * The settings write path awaits several promises, so tests that assert on a
 * settled write need the queue flushed rather than a fixed number of ticks.
 */
async function settle(predicate, budget = 50) {
  for (let i = 0; i < budget; i += 1) {
    if (predicate()) return true
    await Promise.resolve()
  }
  return predicate()
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
 * Boot the plugin against a fixture and return a driver bound to one provider
 * card.
 * @param options.served - whether the Host serves the `llm-pi-ai` namespace.
 *   The real `configForms.whileServed` registers the contribution only while a
 *   watched namespace is served, so `false` reproduces a deployment without the
 *   pi-ai adapter.
 */
function boot({ user = fixtureUser(), provider = "exampleGateway", writable = true, refuse = false, served = true } = {}) {
  const fake = createReact()
  const exports = loadBundle(fake.React)
  const form = makeForm(user, { writable, refuse })

  let renderCard
  const cleanups = []
  const slots = {
    inject(_name, callback) {
      callback()
      return () => {}
    },
    register(_options, component) {
      renderCard = component
      return () => {}
    },
  }
  const configForms = {
    get: (namespace) => {
      if (namespace !== "llm-pi-ai") throw new Error(`harness: unexpected form namespace "${namespace}"`)
      return form
    },
    whileServed: (namespaces, register) => {
      if (!served) return () => {}
      const off = register(new Set(namespaces))
      return () => {
        if (typeof off === "function") off()
      }
    },
  }
  const ctx = {
    effect: (callback) => {
      const cleanup = callback()
      const disposer = typeof cleanup === "function" ? cleanup : () => {}
      cleanups.push(disposer)
      return disposer
    },
    configForms,
    slots,
  }
  exports.apply(ctx)
  if (served && renderCard === undefined) throw new Error("harness: plugin registered no card")

  const profile = user.providers[provider]
  const settingsPath = ["providers", provider]
  const ownerProps = {
    provider: {
      provider,
      displayName: profile.displayName ?? provider,
      settingsNs: "llm-pi-ai",
      settingsPath,
      active: true,
    },
    configured: true,
    keyConfigured: true,
  }
  const draw = () => {
    if (renderCard === undefined) return null
    return fake.render(() => renderCard(ownerProps))
  }
  return { exports, form, draw, provider, settingsPath, user, cleanups, registered: renderCard !== undefined }
}

/** Expand the card if it is not already expanded, and return its tree. */
function opened(handle) {
  const tree = handle.draw()
  const expand = find(tree, (node) => node.type === "button" && textOf(node).trim() === "展开配置")
  if (expand !== undefined) {
    expand.props.onClick()
    return handle.draw()
  }
  return tree
}

/** Read the stored profile out of the scope's user layer. */
function storedProfile(handle) {
  const stored = handle.form.stored()
  return stored.providers[handle.provider]
}

/* -------------------------------------------------------------------- tests */

check("registers on the provider-card seat under the pi-ai namespace", () => {
  const handle = boot()
  assertEqual(handle.exports.name, "llm-model-tuning", "plugin name")
  assertEqual(handle.exports.inject, ["slots", "configForms"], "declared dependencies")
  assert(typeof handle.exports.apply === "function", "apply is exported")
  const tree = handle.draw()
  assert(textOf(tree).includes("推理强度与多模态输入"), "card renders its title")
})

check("renders one row per configured model, named from the profile", () => {
  const tree = opened(boot())
  const text = textOf(tree)
  assert(text.includes("Auto"), "first model shown")
  assert(text.includes("Deepseek-V4.1-Flash"), "second model shown")
})

check("writes custom reasoning levels and modalities onto the models list", async () => {
  const handle = boot()
  let tree = opened(handle)

  // First row: declare two levels, one of which needs an explicit wire value.
  let rows = modelRows(tree)
  assertEqual(rows.length, 2, "two model rows")
  choice(rows[0], "自定义档位").props.onChange()
  tree = opened(handle)

  // Switching to a custom set seeds one level so the editor is never empty.
  rows = modelRows(tree)
  const wire = enabledInput(rows[0], "线上取值")
  assertEqual(wire.props.value, "high", "the seeded level defaults its wire value to its own name")

  // The off level stays optional and empty.
  choice(rows[0], "关闭 (off)").props.onChange()
  tree = opened(handle)
  rows = modelRows(tree)
  const offInput = enabledInput(rows[0], "留空 = 不发送")
  assertEqual(offInput.props.value, "", "off defaults to empty (send nothing)")

  choice(rows[0], "图像").props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => handle.form.calls.length > 0)

  const models = storedProfile(handle).models
  assertEqual(
    models[0].reasoningEfforts,
    { off: null, high: "high" },
    "the levels landed with off spelled as an explicit null",
  )
  assertEqual(models[0].input, ["text", "image"], "declared modalities landed")
  assertEqual(models[1].reasoningEfforts, undefined, "the untouched row was left alone")
  // Capacities the card never showed must survive the array rewrite.
  assertEqual(models[0].contextWindow, 168000, "unrelated model fields preserved")
  assertEqual(models[1].maxTokens, 128000, "unrelated rows preserved")
})

check("reverting a control to inherit removes the stored field", async () => {
  const user = fixtureUser()
  user.providers.exampleGateway.models[0].reasoningEfforts = { high: "high" }
  user.providers.exampleGateway.models[0].input = ["text", "image"]
  const handle = boot({ user })
  let tree = opened(handle)

  let rows = modelRows(tree)
  choice(rows[0], "继承目录").props.onChange()
  tree = opened(handle)
  rows = modelRows(tree)
  choice(rows[0], "图像").props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => handle.form.calls.length > 0)

  const model = storedProfile(handle).models[0]
  assertEqual(model.reasoningEfforts, undefined, "effort removed, not left behind")
  assertEqual(model.input, undefined, "with no optional modality the entry declares nothing")
})

check("edits a catalog route through modelOverrides without touching other entries", async () => {
  const handle = boot({ provider: "catalogroute" })
  let tree = opened(handle)

  // The catalog route has one stored override; add a second model to it.
  input(tree, "模型 id").props.onChange({ target: { value: "new-vision-model" } })
  tree = opened(handle)
  button(tree, "添加模型").props.onClick()
  tree = opened(handle)

  let rows = modelRows(tree)
  assertEqual(rows.length, 2, "both the stored and the added entry are shown")
  choice(rows[1], "图像").props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => handle.form.calls.length > 0)

  const overrides = storedProfile(handle).modelOverrides
  assertEqual(overrides["new-vision-model"], { input: ["text", "image"] }, "the new override landed")
  assertEqual(
    overrides["some-catalog-model"],
    { contextWindow: 200000 },
    "the pre-existing override is untouched",
  )
  void rows
})

check("removing an override entry deletes exactly that entry", async () => {
  const handle = boot({ provider: "catalogroute" })
  let tree = opened(handle)
  const rows = modelRows(tree)
  button(rows[0], "移除").props.onClick()
  tree = opened(handle)
  assertEqual(modelRows(tree).length, 0, "the row is gone from the draft")
  button(tree, "保存").props.onClick()
  await settle(() => handle.form.calls.length > 0)

  assertEqual(storedProfile(handle).modelOverrides, {}, "the removed override is gone from the stored dict")
})

check("refuses a level beyond off that carries no wire value", async () => {
  const handle = boot()
  let tree = opened(handle)
  let rows = modelRows(tree)
  choice(rows[0], "自定义档位").props.onChange()
  tree = opened(handle)

  // Blank the seeded level's required wire value.
  rows = modelRows(tree)
  enabledInput(rows[0], "线上取值").props.onChange({ target: { value: "   " } })
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => textOf(handle.draw()).includes("需要填写发送给接口的线上取值"))

  assertEqual(handle.form.calls.length, 0, "no write was attempted")
  assert(textOf(handle.draw()).includes("需要填写发送给接口的线上取值"), "the refusal names the field")
})

check("refuses an effort set that offers nothing beyond off", async () => {
  const handle = boot()
  let tree = opened(handle)
  let rows = modelRows(tree)
  choice(rows[0], "自定义档位").props.onChange()
  tree = opened(handle)
  rows = modelRows(tree)
  // Drop the default `high` level, leaving only off.
  choice(rows[0], "高 (high)").props.onChange()
  tree = opened(handle)
  rows = modelRows(tree)
  choice(rows[0], "关闭 (off)").props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => textOf(handle.draw()).includes("至少要包含一个 off 以外的档位"))

  assertEqual(handle.form.calls.length, 0, "no write was attempted")
  assert(textOf(handle.draw()).includes("至少要包含一个 off 以外的档位"), "the refusal explains the rule")
})

check("reports a write the Host refused instead of claiming success", async () => {
  const handle = boot({ refuse: true })
  let tree = opened(handle)
  const rows = modelRows(tree)
  choice(rows[0], "图像").props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => textOf(handle.draw()).includes("写入未生效") || textOf(handle.draw()).includes("已写入设置"))
  const text = textOf(handle.draw())
  assertEqual(handle.form.calls.length, 1, "the write was attempted")
  assert(text.includes("写入未生效"), `expected a refusal notice, got: ${text.slice(0, 300)}`)
})

check("reports a landed write", async () => {
  const handle = boot()
  let tree = opened(handle)
  const rows = modelRows(tree)
  choice(rows[0], "图像").props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => textOf(handle.draw()).includes("已写入设置"))
  assert(textOf(handle.draw()).includes("已写入设置"), "success is reported")
})

check("a read-only document disables every control", () => {
  const handle = boot({ writable: false })
  const tree = opened(handle)
  const save = button(tree, "保存")
  assertEqual(save.props.disabled, true, "save is disabled")
  for (const node of findAll(tree, (n) => n.type === "input")) {
    assertEqual(node.props.disabled, true, "every input is disabled")
  }
})

check("does not render for a provider outside its namespace", () => {
  const fake = createReact()
  const exports = loadBundle(fake.React)
  const form = makeForm(fixtureUser())
  let renderCard
  exports.apply({
    effect: (callback) => {
      callback()
      return () => {}
    },
    configForms: {
      get: () => form,
      whileServed: (_namespaces, register) => {
        const off = register(new Set(["llm-pi-ai"]))
        return () => {
          if (typeof off === "function") off()
        }
      },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (_options, component) => {
        renderCard = component
      },
    },
  })
  const tree = fake.render(() =>
    renderCard({ provider: { provider: "x", settingsNs: "llm-deepseek", settingsPath: [] }, configured: true }),
  )
  assertEqual(tree, null, "no card for a foreign namespace")
})

check("registers nothing when the Host does not serve the pi-ai namespace", () => {
  // `whileServed` is the guard that keeps this card invisible on a deployment
  // that never composed the pi-ai adapter, instead of rendering a dead panel.
  const handle = boot({ served: false })
  assertEqual(handle.registered, false, "no card was registered")
  assertEqual(handle.draw(), null, "nothing renders")
})

check("writes defaultInput as a provider-level fallback", async () => {
  const handle = boot()
  let tree = opened(handle)
  // The first checkbox in the provider-level group is `text`.
  const group = defaultInputGroup(tree)
  const boxes = findAll(group, (node) => node.type === "input")
  assertEqual(boxes.length, 2, "the group offers both modalities")
  // Text is the floor and is held on; only the optional modality is editable.
  assertEqual(boxes[0].props.checked, true, "text is always declared")
  assertEqual(boxes[0].props.disabled, true, "text cannot be turned off")
  assertEqual(boxes[1].props.checked, false, "image starts inherited")

  // Declaring image alone is the meaningful case: it is the fallback a gateway
  // serving vision models the catalog does not describe relies on.
  const imageBox = findAll(group, (node) => node.type === "label" && textOf(node).includes("图像"))[0]
  findAll(imageBox, (node) => node.type === "input")[0].props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => handle.form.calls.length > 0)

  assertEqual(storedProfile(handle).defaultInput, ["text", "image"], "the fallback keeps text and adds image")
})

check("clearing the optional modality removes the inherited defaultInput", async () => {
  const user = fixtureUser()
  user.providers.exampleGateway.defaultInput = ["text", "image"]
  const handle = boot({ user })
  let tree = opened(handle)
  let group = defaultInputGroup(tree)
  const imageBox = findAll(group, (node) => node.type === "label" && textOf(node).includes("图像"))[0]
  findAll(imageBox, (node) => node.type === "input")[0].props.onChange()
  tree = opened(handle)
  button(tree, "保存").props.onClick()
  await settle(() => handle.form.calls.length > 0)
  // With no optional modality left the field is removed, so the adapter's own
  // `[text]` default answers rather than a text-only list being pinned here.
  assertEqual(storedProfile(handle).defaultInput, undefined, "an empty list falls back to the adapter default")
})

check("installs its stylesheet and removes it on teardown", () => {
  // A bundle gets `require` alone — it has no `styles` builtin — so the sheet
  // must really reach the document and be owned by the fiber.
  const before = styleTags.length
  const handle = boot()
  const installed = styleTags.slice(before)
  assertEqual(installed.length, 1, "the card installed exactly one stylesheet")
  assert(installed[0].textContent.includes(".dsh-mtune"), "the sheet carries the card's rules")
  assertEqual(installed[0].attributes["data-dsh-plugin"], "llm-model-tuning", "the sheet is attributable")

  // The disposer `ctx.effect` registered must remove it.
  for (const cleanup of handle.cleanups) cleanup()
  assertEqual(styleTags.length, before, "teardown removed the stylesheet")
})

/* ---------------------------------------------------------------- reporting */

installGlobals()

/** Everything a caller needs to drive the card from another test file. */
export {
  boot,
  opened,
  modelRows,
  choice,
  button,
  textOf,
  findAll,
  find,
  input,
  enabledInput,
  storedProfile,
  settle,
  fixtureUser,
}

// Only run the suite when this file is the entry point, so the integration test
// can import the same driver without re-running these assertions.
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  for (const entry of pending) {
    try {
      await entry.fn()
      results.push({ name: entry.name, ok: true })
    } catch (error) {
      results.push({ name: entry.name, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const failed = results.filter((entry) => !entry.ok)
  for (const entry of results) {
    console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}`)
    if (!entry.ok) console.log(`      ${entry.error}`)
  }
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
  if (failed.length > 0) process.exitCode = 1
}
