/**
 * Offline harness for the `dsh-llm-model-tuning` client half.
 *
 * It loads the real bundle file with a stubbed module loader, React, and
 * settings scope, then drives the redesigned card through its own controls —
 * the DSH-native page layout, the `获取可用模型` → 选择要添加的模型 dialog, and
 * the per-model reasoning-level editor — against a faithful settings-write
 * simulator. The settings write path is reproduced faithfully enough to catch
 * the two things most likely to break in production: a path op that the Host's
 * walker refuses, and a write that silently does not land.
 *
 * The React stub is a miniature renderer rather than a set of no-ops: it tracks
 * one hook cell per component instance (keyed by position/key in the tree), runs
 * effects after commit with dependency comparison, and re-renders until state
 * updates settle. That matters because the redesigned card renders nested
 * components that hold their own state.
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
 * carry capacities but neither effort nor modalities yet, plus one unmanaged
 * raw field (`compat`) that the import must preserve when it overwrites a
 * selected model.
 */
function fixtureUser() {
  return {
    providers: {
      exampleGateway: {
        apiKeyEnv: "MY_GATEWAY_API_KEY",
        api: "openai-completions",
        baseURL: "https://gateway.example.com/v1",
        models: [
          {
            id: "auto",
            name: "Auto",
            contextWindow: 168000,
            maxTokens: 32000,
            compat: { supportsStore: true },
          },
          { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
        ],
      },
      catalogroute: {
        apiKeyEnv: "CATALOG_API_KEY",
        modelOverrides: {
          "some-catalog-model": { contextWindow: 200000, compat: { supportsStore: true } },
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

/* -------------------------------------------------------------- fake React */

/**
 * A miniature React renderer with the ordering rules the card relies on.
 *
 * Each function component gets a stable instance keyed by its position and key
 * in the element tree, so hooks keep their state across renders even when
 * sibling components mount or unmount. Hooks are stored per instance in call
 * order; state setters mark the tree dirty and the runner re-renders until it
 * settles, exactly like React would after an effect or an event.
 */
function createReact() {
  /** path -> { type, hooks, cursor, visited } */
  const instances = new Map()
  let current
  let dirty = false
  let pendingEffects = []
  let idCounter = 0

  function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  }

  function hookCell() {
    if (current === undefined) throw new Error("harness: hook called outside a component render")
    const index = current.cursor++
    let cell = current.hooks[index]
    if (cell === undefined) {
      cell = {}
      current.hooks[index] = cell
    }
    return cell
  }

  /** Register an effect whose deps changed (or that declares none). */
  function scheduleEffect(effect, deps) {
    const cell = hookCell()
    if (deps !== undefined && cell.deps !== undefined && sameDeps(cell.deps, deps)) return
    cell.deps = deps
    pendingEffects.push({ cell, effect })
  }

  function setterFor(cell) {
    return (next) => {
      const value = typeof next === "function" ? next(cell.value) : next
      if (!Object.is(value, cell.value)) {
        cell.value = value
        dirty = true
      }
    }
  }

  const React = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      const element = {
        type,
        props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
      }
      // React strips `key` from props; keep it on the element so the renderer
      // can use it for instance identity.
      if (props !== null && typeof props === "object" && Object.prototype.hasOwnProperty.call(props, "key")) {
        element.key = props.key
      }
      return element
    },
    useState(initial) {
      const cell = hookCell()
      if (!Object.prototype.hasOwnProperty.call(cell, "value")) {
        cell.value = typeof initial === "function" ? initial() : initial
      }
      return [cell.value, setterFor(cell)]
    },
    useReducer(reducer, initial) {
      const cell = hookCell()
      if (!Object.prototype.hasOwnProperty.call(cell, "value")) {
        cell.value = typeof initial === "function" ? initial() : initial
      }
      return [cell.value, (action) => setterFor(cell)(reducer(cell.value, action))]
    },
    useRef(initial) {
      const cell = hookCell()
      if (!Object.prototype.hasOwnProperty.call(cell, "ref")) cell.ref = { current: initial }
      return cell.ref
    },
    useMemo(factory, deps) {
      const cell = hookCell()
      if (!Object.prototype.hasOwnProperty.call(cell, "memo") || !sameDeps(cell.deps, deps)) {
        cell.deps = deps
        cell.memo = factory()
      }
      return cell.memo
    },
    useCallback(fn, deps) {
      const cell = hookCell()
      if (!Object.prototype.hasOwnProperty.call(cell, "memo") || !sameDeps(cell.deps, deps)) {
        cell.deps = deps
        cell.memo = fn
      }
      return cell.memo
    },
    useEffect(effect, deps) {
      scheduleEffect(effect, deps)
    },
    useLayoutEffect(effect, deps) {
      scheduleEffect(effect, deps)
    },
    useId() {
      const cell = hookCell()
      if (cell.id === undefined) cell.id = `harness-id-${String(idCounter++)}`
      return cell.id
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const [, forceRender] = React.useState(0)
      React.useEffect(() => subscribe(() => forceRender((value) => value + 1)), [subscribe])
      return getSnapshot()
    },
    memo(component) {
      return component
    },
  }

  function runCleanups(instance) {
    for (const cell of instance.hooks) {
      if (cell !== undefined && typeof cell.cleanup === "function") {
        const cleanup = cell.cleanup
        cell.cleanup = undefined
        cleanup()
      }
    }
  }

  /**
   * Expand one element: function components are invoked with their props and
   * their output is expanded in turn, host elements keep their type and get
   * expanded children. Instance identity comes from the position/key path.
   */
  function renderNode(node, parentPath, slot) {
    if (node === null || node === undefined || typeof node === "boolean") return node
    if (typeof node === "string" || typeof node === "number") return node
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, parentPath, index))
    const type = node.type
    const props = node.props ?? {}
    const slotKey = node.key !== undefined ? `k:${String(node.key)}` : `i:${String(slot)}`
    if (typeof type === "function") {
      const path = `${parentPath}/c:${slotKey}`
      let instance = instances.get(path)
      if (instance === undefined || instance.type !== type) {
        if (instance !== undefined) runCleanups(instance)
        instance = { type, hooks: [], cursor: 0, visited: true }
        instances.set(path, instance)
      }
      instance.visited = true
      instance.cursor = 0
      const previous = current
      current = instance
      let output
      try {
        output = type(props)
      } finally {
        current = previous
      }
      return renderNode(output, `${path}/out`, 0)
    }
    return { ...node, props: { ...props, children: renderNode(props.children, `${parentPath}/h:${slotKey}`, 0) } }
  }

  return {
    React,
    /** Render once, then keep rendering until no state update is pending. */
    render(thunk) {
      let guard = 0
      let tree
      do {
        dirty = false
        pendingEffects = []
        for (const instance of instances.values()) instance.visited = false
        tree = renderNode(thunk(), "", 0)
        for (const [path, instance] of [...instances.entries()]) {
          if (instance.visited) continue
          runCleanups(instance)
          instances.delete(path)
        }
        const effects = pendingEffects
        pendingEffects = []
        for (const { cell, effect } of effects) {
          if (typeof cell.cleanup === "function") {
            const cleanup = cell.cleanup
            cell.cleanup = undefined
            cleanup()
          }
          const cleanup = effect()
          cell.cleanup = typeof cleanup === "function" ? cleanup : undefined
        }
        guard += 1
        if (guard > 100) throw new Error("harness: render did not settle (state update loop)")
      } while (dirty)
      return tree
    },
    unmount() {
      for (const instance of instances.values()) runCleanups(instance)
      instances.clear()
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

/** Every node paired with its parent element, depth first. */
function walkEntries(node, parent, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out
  if (Array.isArray(node)) {
    for (const child of node) walkEntries(child, parent, out)
    return out
  }
  out.push({ node, parent })
  walkEntries(node.props?.children, node, out)
  return out
}

/** Build a `node -> parent` map for one tree. */
function parentsOf(tree) {
  const parents = new Map()
  for (const entry of walkEntries(tree, undefined, [])) parents.set(entry.node, entry.parent)
  return parents
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

/** Read a node's class list, tolerating the absence of props. */
function classNamesOf(node) {
  const value = node.props?.className
  return typeof value === "string" ? value.split(/\s+/).filter((entry) => entry.length > 0) : []
}

/** Whether an element carries one exact class. */
function classHas(node, name) {
  return classNamesOf(node).includes(name)
}

/** Find the first element carrying one exact class. */
function findClass(tree, name) {
  const found = find(tree, (node) => classHas(node, name))
  return found
}

/** Find every element carrying one exact class. */
function findAllClass(tree, name) {
  return findAll(tree, (node) => classHas(node, name))
}

/**
 * Every name a control is addressable by: its visible text, its aria-label, and
 * its title. Icon-only buttons carry their label in one of the latter two.
 */
function labelTexts(node) {
  const texts = []
  const visible = textOf(node).trim()
  if (visible.length > 0) texts.push(visible)
  for (const attribute of ["aria-label", "title"]) {
    const value = node.props?.[attribute]
    if (typeof value === "string" && value.trim().length > 0) texts.push(value.trim())
  }
  return texts
}

/**
 * Whether a control's labels address it by `label`. An aria-label may carry a
 * positional suffix (`模型选项 1`), so a space-delimited prefix also matches.
 */
function labelMatches(node, label) {
  return labelTexts(node).some((text) => text === label || text.startsWith(`${label} `))
}

/** Find a button by its label (visible text, aria-label, or title). */
function button(tree, label) {
  const found = find(tree, (node) => node.type === "button" && labelMatches(node, label))
  if (found === undefined) throw new Error(`harness: no button labelled "${label}"`)
  return found
}

/** Find a button by label, or `undefined` when the card does not render one. */
function maybeButton(tree, label) {
  return find(tree, (node) => node.type === "button" && labelMatches(node, label))
}

/** Find a checkbox/radio whose enclosing label text contains the fragment. */
function choice(tree, fragment) {
  const found = find(
    tree,
    (node) =>
      node.type === "label" &&
      textOf(node).includes(fragment) &&
      findAll(node, (child) => child.type === "input").length > 0,
  )
  if (found === undefined) throw new Error(`harness: no choice labelled "${fragment}"`)
  return findAll(found, (child) => child.type === "input")[0]
}

/** Find a text/search input by its placeholder. */
function input(tree, placeholder) {
  const found = find(tree, (node) => node.type === "input" && node.props?.placeholder === placeholder)
  if (found === undefined) throw new Error(`harness: no input with placeholder "${placeholder}"`)
  return found
}

/**
 * Find the single ENABLED input carrying a placeholder. Kept for compatibility
 * with the old interaction layer: a disabled match renders the same placeholder
 * but is not the field being edited.
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

/** Every `<select>` under a node. */
function selectsIn(node) {
  return findAll(node, (child) => child.type === "select")
}

/** The `<option>` elements of a select. */
function optionsOf(select) {
  return findAll(select, (node) => node.type === "option")
}

/** The trimmed text of each option, in order. */
function optionTexts(select) {
  return optionsOf(select).map((option) => textOf(option).trim())
}

/** The `value` an option carries, falling back to its text. */
function optionValue(option) {
  const value = option.props?.value
  return value === undefined ? textOf(option).trim() : value
}

/** Read the current value of a select, from its controlled prop. */
function selectValue(select) {
  return select.props?.value
}

/** Simulate a controlled select change. */
function changeSelect(select, value) {
  select.props.onChange({ target: { value }, currentTarget: { value }, preventDefault() {}, stopPropagation() {} })
}

/** Whether a select is the reasoning-kind select (继承目录 / 关闭推理 / 自定义档位). */
function isKindSelect(select) {
  const texts = optionTexts(select)
  return texts.includes("继承目录") && texts.includes("关闭推理")
}

/** Whether a select is a per-level select (关闭 (off) … 最大 (max)). */
function isLevelSelect(select) {
  return optionTexts(select).includes("关闭 (off)")
}

/** The reasoning-kind select of one model row. */
function kindSelect(row) {
  const found = find(row, (node) => node.type === "select" && isKindSelect(node))
  if (found === undefined) throw new Error("harness: no reasoning-kind select in row")
  return found
}

/** Set the reasoning kind by the option's visible label. */
function setKind(row, label) {
  const select = kindSelect(row)
  const option = optionsOf(select).find((entry) => textOf(entry).trim() === label)
  if (option === undefined) {
    throw new Error(`harness: reasoning select has no option "${label}" (has: ${optionTexts(select).join(" / ")})`)
  }
  changeSelect(select, optionValue(option))
}

/** Whether a placeholder belongs to a reasoning level's API-value field. */
function isApiValuePlaceholder(placeholder) {
  return typeof placeholder === "string" && (placeholder === "API 参数值" || placeholder === "关闭思考")
}

/**
 * One reasoning-level row inside a model row: its select, its API-value input,
 * and its remove button. The row container is the nearest ancestor that holds
 * both an API-value input and the 删除档位 button.
 */
function levelRowEntries(tree, scope) {
  const parents = parentsOf(tree)
  const entries = []
  for (const select of findAll(scope, (node) => node.type === "select" && isLevelSelect(node))) {
    let owner
    let walker = parents.get(select)
    while (walker !== undefined) {
      const inputs = findAll(walker, (node) => node.type === "input" && isApiValuePlaceholder(node.props?.placeholder))
      const buttons = findAll(walker, (node) => node.type === "button" && labelMatches(node, "删除档位"))
      if (inputs.length > 0 && buttons.length > 0) {
        owner = walker
        break
      }
      walker = parents.get(walker)
    }
    const valueInput =
      owner === undefined
        ? undefined
        : findAll(owner, (node) => node.type === "input" && isApiValuePlaceholder(node.props?.placeholder))[0]
    const removeButton =
      owner === undefined
        ? undefined
        : findAll(owner, (node) => node.type === "button" && labelMatches(node, "删除档位"))[0]
    entries.push({ select, level: selectValue(select), input: valueInput, removeButton })
  }
  return entries
}

/** The level-row entry for one level key, by the select's controlled value. */
function levelRow(tree, scope, level) {
  const found = levelRowEntries(tree, scope).find((entry) => entry.level === level)
  if (found === undefined) {
    const levels = levelRowEntries(tree, scope).map((entry) => String(entry.level))
    throw new Error(`harness: no level row for "${level}" (has: ${levels.join(", ")})`)
  }
  return found
}

/** The 添加档位 button inside one model row. */
function addLevelButton(row) {
  return button(row, "添加档位")
}

/** The 模型选项 expand/collapse chevron of one model row. */
function modelToggleButton(row) {
  return button(row, "模型选项")
}

/** The 移除模型 icon button of one model row. */
function modelRemoveButton(row) {
  return button(row, "移除模型")
}

/** Every model entry in a tree. */
function modelRows(tree) {
  return findAll(tree, (node) => classHas(node, "dsh-mtune-model"))
}

/** The dialog root, when the picker is open. */
function dialog(tree) {
  return findClass(tree, "dsh-mtune-modal")
}

/** Whether the model-selection dialog is rendered. */
function dialogOpen(tree) {
  return dialog(tree) !== undefined
}

/** The candidate list rows inside the dialog. */
function candidateRows(tree) {
  const root = dialog(tree)
  if (root === undefined) return []
  return findAll(root, (node) => node.type === "li" && classHas(node, "dsh-mtune-candidate"))
}

/** The checkbox controlling one candidate. */
function candidateCheckbox(tree, id) {
  const found = find(tree, (node) => node.type === "input" && node.props?.["data-mtune-candidate"] === id)
  if (found === undefined) throw new Error(`harness: no candidate checkbox for "${id}"`)
  return found
}

/** The candidate row element for one id. */
function candidateRow(tree, id) {
  const rows = candidateRows(tree)
  const found =
    rows.find((row) => findAll(row, (node) => node.props?.["data-mtune-candidate"] === id).length > 0) ??
    rows.find((row) => textOf(row).includes(id))
  if (found === undefined) throw new Error(`harness: no candidate row for "${id}"`)
  return found
}

/** Every candidate id the dialog currently lists, in order. */
function candidateIds(tree) {
  return candidateRows(tree).map((row) => {
    const box = find(row, (node) => node.type === "input" && node.props?.["data-mtune-candidate"] !== undefined)
    return box === undefined ? textOf(row).trim() : String(box.props["data-mtune-candidate"])
  })
}

/** The displayed id text of a candidate row (the mono `.dsh-mtune-candidate-id`). */
function candidateIdText(row) {
  const found = findClass(row, "dsh-mtune-candidate-id")
  return found === undefined ? undefined : textOf(found).trim()
}

/** The 新增 / 覆盖 badge of a candidate row, if rendered. */
function candidateBadge(row) {
  const found = find(row, (node) => {
    const text = textOf(node).trim()
    return (text === "新增" || text === "覆盖") && node.type === "span"
  })
  return found === undefined ? undefined : textOf(found).trim()
}

/** Whether a checkbox controls a checkbox input rather than a radio. */
function isChecked(inputNode) {
  return inputNode.props?.checked === true
}

/** Simulate toggling a checkbox/radio, honouring both event-reading and closure handlers. */
function toggleChoice(inputNode) {
  const next = !isChecked(inputNode)
  inputNode.props.onChange({ target: { checked: next }, currentTarget: { checked: next }, preventDefault() {}, stopPropagation() {} })
}

/** Simulate checking/unchecking one dialog candidate. */
function setCandidate(tree, id, checked = true) {
  const box = candidateCheckbox(tree, id)
  if (isChecked(box) !== checked) toggleChoice(box)
}

/** The dialog's search input. */
function searchInput(tree) {
  return input(tree, "搜索模型")
}

/** Type into the dialog's search box. */
function setSearch(tree, text) {
  const box = searchInput(tree)
  box.props.onChange({ target: { value: text }, currentTarget: { value: text }, preventDefault() {}, stopPropagation() {} })
}

/** The 全选 / 取消全选 toolbar button, whichever label the current state shows. */
function selectAllButton(tree) {
  return maybeButton(tree, "全选") ?? maybeButton(tree, "取消全选")
}

/** The 添加所选 confirm button of the dialog. */
function confirmButton(tree) {
  return button(tree, "添加所选")
}

/** The 取消 button of the dialog (or the card's 放弃修改 is NOT this label). */
function cancelButton(tree) {
  return button(tree, "取消")
}

/** Click a control, tolerating handlers that do not read the event. */
function click(node) {
  node.props.onClick?.({ target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} })
}

/** A synthetic keydown event. */
function keyEvent(key) {
  return { key, target: null, currentTarget: null, preventDefault() {}, stopPropagation() {} }
}

/**
 * Press Escape at the dialog. Prefers the dialog's own key handler and falls
 * back to a document/window keydown listener registered by the card.
 */
function pressEscape(tree) {
  const root = dialog(tree) ?? tree
  const target = find(root, (node) => typeof node.props?.onKeyDown === "function")
  if (target !== undefined) {
    target.props.onKeyDown(keyEvent("Escape"))
    return
  }
  const listeners = [...(documentListeners.get("keydown") ?? []), ...(windowListeners.get("keydown") ?? [])]
  for (const listener of listeners) listener(keyEvent("Escape"))
}

/** Click the dialog's mask. */
function clickMask(tree) {
  const mask = findClass(tree, "dsh-mtune-modal-mask")
  if (mask === undefined) throw new Error("harness: no dialog mask")
  click(mask)
}

/**
 * The tightest element whose text contains `fragment`: the group itself rather
 * than the card that wraps it. Used when the implementation does not reuse the
 * old `dsh-mtune-group` container class.
 */
function smallestContaining(tree, fragment) {
  const candidates = findAll(tree, (node) => textOf(node).includes(fragment))
  candidates.sort((a, b) => walk(a).length - walk(b).length)
  return candidates[0]
}

/** The provider-level default-input group. */
function defaultInputGroup(tree) {
  const byFieldset = find(tree, (node) => node.type === "fieldset" && textOf(node).includes("默认输入类型"))
  if (byFieldset !== undefined) return byFieldset
  const byGroup = find(tree, (node) => classHas(node, "dsh-mtune-group") && textOf(node).includes("默认输入类型"))
  if (byGroup !== undefined) return byGroup
  const any = smallestContaining(tree, "默认输入类型")
  if (any === undefined) throw new Error("harness: no default-input group")
  return any
}

/** The gateway-import group inside the expanded card. */
function importGroup(tree) {
  const byHeading = find(tree, (node) => classHas(node, "dsh-mtune-group") && textOf(node).includes("从网关导入"))
  if (byHeading !== undefined) return byHeading
  const any = smallestContaining(tree, "从网关导入")
  if (any === undefined) throw new Error("harness: no gateway-import group")
  return any
}

/** The status line rendered inside the gateway-import group, if any. */
function importStatus(tree) {
  const group = importGroup(tree)
  return find(
    group,
    (node) => classHas(node, "dsh-mtune-status") && textOf(node).length > 0,
  )
}

/* ------------------------------------------------------------- bundle loader */

const styleTags = []
const documentListeners = new Map()
const windowListeners = new Map()

/** A minimal EventTarget surface for one stubbed global. */
function makeEventTarget(listeners) {
  return {
    addEventListener(type, listener) {
      if (typeof listener !== "function") return
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
  }
}

/** Install the browser globals the bundle expects. Called once, never restored:
 * `apply()` runs at boot time, after the bundle has already been evaluated. */
function installGlobals() {
  globalThis.document = {
    ...makeEventTarget(documentListeners),
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
    ...makeEventTarget(windowListeners),
    // The card only reads CSS tokens from the real page; a no-match media query
    // keeps a reduced-motion guard from throwing in the stub.
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
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
      displayName: profile?.displayName ?? provider,
      settingsNs: "llm-pi-ai",
      settingsPath,
      active: true,
    },
    configured: true,
    keyConfigured: true,
  }
  const draw = () => {
    if (renderCard === undefined) return null
    return fake.render(() => fake.React.createElement(renderCard, ownerProps))
  }
  return { exports, form, draw, provider, settingsPath, user, cleanups, registered: renderCard !== undefined }
}

/** Expand the card if it is not already expanded, and return its tree. */
function opened(handle) {
  const tree = handle.draw()
  const expand = maybeButton(tree, "展开配置")
  if (expand !== undefined) {
    click(expand)
    return handle.draw()
  }
  return tree
}

/** Read the stored profile out of the scope's user layer. */
function storedProfile(handle) {
  const stored = handle.form.stored()
  return stored.providers[handle.provider]
}

/**
 * Expand one model entry (if it is not already open) and return its row.
 * @returns `{ tree, row }` — the redrawn tree and the row at the same index.
 */
function expandModel(handle, index) {
  let tree = opened(handle)
  let rows = modelRows(tree)
  if (rows[index] === undefined) throw new Error(`harness: no model row at index ${String(index)}`)
  const toggle = modelToggleButton(rows[index])
  if (toggle.props["aria-expanded"] !== true) {
    click(toggle)
    tree = handle.draw()
    rows = modelRows(tree)
  }
  return { tree, row: rows[index] }
}

/** Collapse one model entry (if it is open) and return its row. */
function collapseModel(handle, index) {
  let tree = opened(handle)
  let rows = modelRows(tree)
  const toggle = modelToggleButton(rows[index])
  if (toggle.props["aria-expanded"] === true) {
    click(toggle)
    tree = handle.draw()
    rows = modelRows(tree)
  }
  return { tree, row: rows[index] }
}

/* -------------------------------------------------------- gateway-import stubs */

/**
 * Stub the browser's same-origin fetch for one import attempt.
 *
 * The card calls the global directly, so installing `globalThis.fetch` and
 * restoring it afterwards is enough to drive the host half's answer shape
 * without a server. The original is restored by the caller's `finally`, so a
 * later suite (integration) that stubs fetch itself still sees a clean global.
 * @param handler - invoked with `{url, init, call}` and resolves a Response.
 * @returns the recorded calls plus a `restore()` that puts the global back.
 */
function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input)
    calls.push({ url, init })
    return handler({ url, init, call: calls.length - 1 })
  }
  return {
    calls,
    restore() {
      if (original === undefined) delete globalThis.fetch
      else globalThis.fetch = original
    },
  }
}

/** One JSON `Response` for a stubbed host route (Node 20 has a global Response). */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

/**
 * Open the model-selection dialog by clicking 获取可用模型 and waiting for it.
 * @returns the redrawn tree with the dialog open (or the settled tree when the
 *   gateway returned nothing importable and the card chose not to open it).
 */
async function openPicker(handle) {
  const tree = opened(handle)
  const trigger = button(tree, "获取可用模型")
  click(trigger)
  await settle(() => dialogOpen(handle.draw()) || importStatus(handle.draw()) !== undefined)
  return handle.draw()
}

/**
 * Confirm the open dialog with 添加所选 and wait for it to close.
 * @returns the redrawn tree after the merge.
 */
async function confirmPicker(handle) {
  const tree = handle.draw()
  click(confirmButton(tree))
  await settle(() => dialogOpen(handle.draw()) === false)
  return handle.draw()
}

/* -------------------------------------------------------------------- tests */

check("registers as a provider-card contribution named after the plugin", () => {
  const handle = boot()
  assertEqual(handle.exports.name, "llm-model-tuning", "plugin name")
  assertEqual(handle.exports.inject, ["slots", "configForms"], "declared dependencies")
  assert(typeof handle.exports.apply === "function", "apply is exported")
  const tree = handle.draw()
  assert(textOf(tree).includes("模型调优"), "the card title is the redesigned one")
  assert(
    textOf(tree).includes("按模型配置推理等级与输入类型；可从网关获取模型列表。"),
    "the collapsed card explains itself",
  )
  assert(textOf(tree).includes("展开配置"), "a collapsed card can be expanded")
})

check("expands and collapses the card through its header toggle", () => {
  const handle = boot()
  const collapsed = handle.draw()
  assert(!textOf(collapsed).includes("默认输入类型"), "the collapsed card hides the settings groups")
  assertEqual(modelRows(collapsed).length, 0, "the collapsed card renders no rows")

  const tree = opened(handle)
  assert(textOf(tree).includes("默认输入类型"), "the expanded card shows the provider default group")
  assert(textOf(tree).includes("从网关导入"), "the expanded card shows the import group")
  assertEqual(button(tree, "收起") !== undefined, true, "the toggle now offers 收起")

  click(button(tree, "收起"))
  const closed = handle.draw()
  assert(!textOf(closed).includes("默认输入类型"), "收起 hides the settings again")
})

check("renders one row per configured model with the redesigned vocabulary", () => {
  const tree = opened(boot())
  assert(textOf(tree).includes("模型（2）"), "the section heading counts the configured models")
  const rows = modelRows(tree)
  assertEqual(rows.length, 2, "two model rows")
  assert(textOf(rows[0]).includes("Auto"), "the stored name is shown")
  assert(textOf(rows[0]).includes("auto"), "the model id is shown")
  assert(textOf(rows[1]).includes("Deepseek-V4.1-Flash"), "the second model is shown")
  // Icon-only buttons carry their label in aria-label, not visible text.
  assert(button(rows[0], "模型选项") !== undefined, "each row offers its options toggle")
  assert(button(rows[0], "移除模型") !== undefined, "each row offers its remove button")
  for (const label of ["获取可用模型", "添加模型", "保存", "放弃修改"]) {
    assert(button(tree, label) !== undefined, `the card renders ${label}`)
  }
})

check("expands a model into input types and a reasoning select, then collapses it", () => {
  const handle = boot()
  let { tree, row } = expandModel(handle, 0)
  assert(textOf(row).includes("输入类型"), "the expanded row shows the input-type fieldset")
  assert(textOf(row).includes("推理能力"), "the expanded row shows the reasoning control")
  choice(row, "文本")
  choice(row, "图片")
  const kinds = optionTexts(kindSelect(row))
  for (const label of ["继承目录", "关闭推理", "自定义档位"]) {
    assert(kinds.includes(label), `the reasoning select offers ${label}`)
  }
  // Capacities are shown as a formatted meta line and are not hand-editable.
  assert(textOf(row).includes("上下文 168,000 · 最大输出 32,000"), `meta line: ${textOf(row).slice(0, 400)}`)

  const collapsed = collapseModel(handle, 0)
  tree = collapsed.tree
  row = collapsed.row
  assert(!textOf(row).includes("输入类型"), "the collapsed row hides the fieldset")
})

check("writes custom reasoning levels and modalities onto the models list", async () => {
  const handle = boot()
  let { tree, row } = expandModel(handle, 0)

  // Declare a custom level set. Turning custom on seeds one usable level so the
  // editor is never empty.
  setKind(row, "自定义档位")
  tree = handle.draw()
  row = modelRows(tree)[0]
  let entries = levelRowEntries(tree, row)
  assertEqual(entries.map((entry) => entry.level), ["high"], "the custom editor seeds a single high level")
  assertEqual(entries[0].input.props.value, "high", "the seeded level defaults its API value to its own name")

  // Add the optional off level and declare no wire value for it.
  click(addLevelButton(row))
  tree = handle.draw()
  row = modelRows(tree)[0]
  entries = levelRowEntries(tree, row)
  const off = entries.find((entry) => entry.level === "off")
  assert(off !== undefined, "添加档位 adds the next unused level")
  assertEqual(off.input.props.value, "", "off defaults to empty (send nothing)")

  // Give the model image input.
  toggleChoice(choice(row, "图片"))
  tree = handle.draw()
  row = modelRows(tree)[0]
  assert(textOf(tree).includes("有未保存的修改"), "a dirty draft is announced")
  click(button(tree, "保存"))
  await settle(() => handle.form.calls.length > 0)

  const models = storedProfile(handle).models
  const written = models[0]
  assertEqual(written.input, ["text", "image"], "declared modalities landed")
  assertEqual(
    written.reasoningEfforts,
    { off: null, high: "high" },
    "the levels landed with off spelled as an explicit null",
  )
  assertEqual(models[1].reasoningEfforts, undefined, "the untouched row was left alone")
  // Capacities and unmanaged fields the card never edited must survive the
  // models-array rewrite.
  assertEqual(written.contextWindow, 168000, "unrelated model fields preserved")
  assertEqual(written.compat, { supportsStore: true }, "unmanaged raw fields preserved")
  assertEqual(models[1].maxTokens, 128000, "unrelated rows preserved")
})

check("reverting a control to inherit removes the stored field", async () => {
  const user = fixtureUser()
  user.providers.exampleGateway.models[0].reasoningEfforts = { high: "high" }
  user.providers.exampleGateway.models[0].input = ["text", "image"]
  const handle = boot({ user })
  let { tree, row } = expandModel(handle, 0)

  setKind(row, "继承目录")
  tree = handle.draw()
  row = modelRows(tree)[0]
  toggleChoice(choice(row, "图片"))
  tree = handle.draw()
  click(button(tree, "保存"))
  await settle(() => handle.form.calls.length > 0)

  const model = storedProfile(handle).models[0]
  assertEqual(model.reasoningEfforts, undefined, "effort removed, not left behind")
  assertEqual(model.input, undefined, "with no optional modality the entry declares nothing")
  assertEqual(model.compat, { supportsStore: true }, "the unmanaged field is untouched")
})

check("edits a catalog route through modelOverrides without touching other entries", async () => {
  const handle = boot({ provider: "catalogroute" })
  let tree = opened(handle)

  // The catalog route has one stored override; add a second model to it.
  input(tree, "模型 ID").props.onChange({ target: { value: "new-vision-model" }, currentTarget: { value: "new-vision-model" } })
  tree = opened(handle)
  click(button(tree, "添加模型"))
  tree = opened(handle)

  const rows = modelRows(tree)
  assertEqual(rows.length, 2, "both the stored and the added entry are shown")
  const added = expandModel(handle, 1)
  tree = added.tree
  const row = added.row
  toggleChoice(choice(row, "图片"))
  tree = handle.draw()
  click(button(tree, "保存"))
  await settle(() => handle.form.calls.length > 0)

  const overrides = storedProfile(handle).modelOverrides
  assertEqual(overrides["new-vision-model"], { input: ["text", "image"] }, "the new override landed")
  assertEqual(
    overrides["some-catalog-model"],
    { contextWindow: 200000, compat: { supportsStore: true } },
    "the pre-existing override is untouched",
  )
})

check("removing an override entry deletes exactly that entry", async () => {
  const handle = boot({ provider: "catalogroute" })
  let tree = opened(handle)
  const rows = modelRows(tree)
  click(modelRemoveButton(rows[0]))
  tree = opened(handle)
  assertEqual(modelRows(tree).length, 0, "the row is gone from the draft")
  click(button(tree, "保存"))
  await settle(() => handle.form.calls.length > 0)

  assertEqual(storedProfile(handle).modelOverrides, {}, "the removed override is gone from the stored dict")
})

check("refuses a level beyond off that carries no API value", async () => {
  const handle = boot()
  let { tree, row } = expandModel(handle, 0)
  setKind(row, "自定义档位")
  tree = handle.draw()
  row = modelRows(tree)[0]

  let entries = levelRowEntries(tree, row)
  const target = entries.find((entry) => entry.level !== "off")
  assert(target !== undefined, "the custom editor has a non-off level to blank")
  target.input.props.onChange({ target: { value: "   " }, currentTarget: { value: "   " }, preventDefault() {} })
  tree = handle.draw()
  click(button(tree, "保存"))
  await settle(() => textOf(handle.draw()).includes("需要填写"))

  const text = textOf(handle.draw())
  assertEqual(handle.form.calls.length, 0, "no write was attempted")
  assert(text.includes("需要填写"), `the refusal names the missing value: ${text.slice(0, 400)}`)
})

check("refuses an effort set that offers nothing beyond off", async () => {
  const handle = boot()
  let { tree, row } = expandModel(handle, 0)
  setKind(row, "自定义档位")
  tree = handle.draw()
  row = modelRows(tree)[0]

  // Drop every level beyond off.
  let entries = levelRowEntries(tree, row)
  for (const entry of entries) {
    if (entry.level === "off") continue
    if (entry.removeButton !== undefined) click(entry.removeButton)
    tree = handle.draw()
    row = modelRows(tree)[0]
    entries = levelRowEntries(tree, row)
  }
  assertEqual(entries.filter((entry) => entry.level !== "off").length, 0, "only the off level is left")
  click(button(tree, "保存"))
  await settle(() => textOf(handle.draw()).includes("至少要包含一个 off 以外的档位"))

  assertEqual(handle.form.calls.length, 0, "no write was attempted")
  assert(textOf(handle.draw()).includes("至少要包含一个 off 以外的档位"), "the refusal explains the rule")
})

check("reports a write the Host refused instead of claiming success", async () => {
  const handle = boot({ refuse: true })
  const { tree, row } = expandModel(handle, 0)
  toggleChoice(choice(row, "图片"))
  const dirty = handle.draw()
  click(button(dirty, "保存"))
  await settle(() => textOf(handle.draw()).includes("写入未生效") || textOf(handle.draw()).includes("已写入设置"))
  const text = textOf(handle.draw())
  assertEqual(handle.form.calls.length, 1, "the write was attempted")
  assert(text.includes("写入未生效"), `expected a refusal notice, got: ${text.slice(0, 300)}`)
})

check("reports a landed write", async () => {
  const handle = boot()
  const { row } = expandModel(handle, 0)
  toggleChoice(choice(row, "图片"))
  const dirty = handle.draw()
  click(button(dirty, "保存"))
  await settle(() => textOf(handle.draw()).includes("已写入设置"))
  assert(textOf(handle.draw()).includes("已写入设置"), "success is reported")
})

check("a read-only document disables every control", () => {
  const handle = boot({ writable: false })
  const tree = opened(handle)
  assertEqual(button(tree, "保存").props.disabled, true, "save is disabled")
  for (const node of findAll(tree, (candidate) => candidate.type === "input" || candidate.type === "select")) {
    assertEqual(node.props.disabled, true, "every input and select is disabled")
  }
  for (const node of findAll(tree, (candidate) => candidate.type === "button")) {
    if (node.props.disabled !== true) {
      // Only the card-level expand/collapse toggle stays usable on a read-only
      // document; every mutating control (and every row chevron) is disabled.
      assert(
        labelMatches(node, "展开配置") || labelMatches(node, "收起"),
        `unexpected enabled button: ${labelTexts(node).join(" / ")}`,
      )
    }
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
    fake.React.createElement(renderCard, {
      provider: { provider: "x", settingsNs: "llm-deepseek", settingsPath: [] },
      configured: true,
    }),
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
  const group = defaultInputGroup(tree)
  const text = choice(group, "文本")
  assertEqual(text.props.checked, true, "text is always declared")
  assertEqual(text.props.disabled, true, "text cannot be turned off")
  const image = choice(group, "图片")
  assertEqual(image.props.checked, false, "image starts inherited")

  toggleChoice(image)
  tree = opened(handle)
  click(button(tree, "保存"))
  await settle(() => handle.form.calls.length > 0)

  assertEqual(storedProfile(handle).defaultInput, ["text", "image"], "the fallback keeps text and adds image")
})

check("clearing the optional modality removes the inherited defaultInput", async () => {
  const user = fixtureUser()
  user.providers.exampleGateway.defaultInput = ["text", "image"]
  const handle = boot({ user })
  let tree = opened(handle)
  toggleChoice(choice(defaultInputGroup(tree), "图片"))
  tree = opened(handle)
  click(button(tree, "保存"))
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

/* ------------------------------------------------ gateway-import behaviours */

/** Candidate payload: one existing id (覆盖), one existing without a name (覆盖), one new (新增). */
const PICKER_MODELS = [
  {
    id: "auto",
    name: "Auto (Gateway)",
    contextWindow: 200000,
    maxTokens: 64000,
    input: ["text", "image"],
    reasoningEfforts: { low: "low", high: "high" },
  },
  // Declares only effort: every other managed field must be cleared under the
  // overwrite semantics, and `compat` (unmanaged) must survive.
  { id: "deepseek-v4.1-flash", reasoningEfforts: { off: null, high: "high" } },
  {
    id: "glm-4.6-air",
    name: "GLM-4.6-Air",
    contextWindow: 131072,
    maxTokens: 32768,
    input: ["text", "image"],
    reasoningEfforts: { low: "low", medium: "medium", high: "high" },
  },
]

/** The standard successful host answer. */
function pickerAnswer() {
  return jsonResponse({
    ok: true,
    models: PICKER_MODELS.map((model) => clone(model)),
    warnings: ["glm-4.6-air：跳过不支持的输入模态 audio"],
  })
}

check("fetches the gateway listing without writing settings", async () => {
  const handle = boot()
  const stub = stubFetch(pickerAnswer)
  try {
    const tree = await openPicker(handle)
    assertEqual(stub.calls.length, 1, "the card called the import route exactly once")
    assertEqual(stub.calls[0].url, "api/dsh-llm-model-tuning/models", "the route is same-origin and browser-relative")
    assertEqual(stub.calls[0].init.method, "POST", "the import is a POST")
    assertEqual(stub.calls[0].init.credentials, "include", "the session is sent with the request")
    assertEqual(
      JSON.parse(stub.calls[0].init.body),
      { provider: "exampleGateway", settingsNs: "llm-pi-ai" },
      "the body names the provider and the settings namespace",
    )
    assertEqual(dialogOpen(tree), true, "a usable answer opens the selection dialog")
    assertEqual(handle.form.calls.length, 0, "fetching touches only the draft; saving stays a separate click")
  } finally {
    stub.restore()
  }
})

check("the picker lists every candidate selected by default with 新增/覆盖 badges", async () => {
  const handle = boot()
  const stub = stubFetch(pickerAnswer)
  try {
    const tree = await openPicker(handle)
    const root = dialog(tree)
    assertEqual(root.props.role, "dialog", "the dialog root declares its role")
    assertEqual(root.props["aria-modal"], "true", "the dialog is modal")
    assertEqual(root.props["aria-label"], "选择要添加的模型", "the dialog is labelled")
    assert(textOf(root).includes("选择要添加的模型"), "the dialog title is shown")
    assert(
      textOf(root).includes("以下是该提供商当前可用的模型。已存在的模型被选中时会覆盖其当前设置。"),
      "the dialog explains the overwrite rule",
    )
    assertEqual(searchInput(root).props.placeholder, "搜索模型", "the dialog has its search field")
    assertEqual(candidateIds(root), ["auto", "deepseek-v4.1-flash", "glm-4.6-air"], "candidates stay in gateway order")
    const unique = new Set(candidateIds(root))
    assertEqual(unique.size, 3, "every candidate id is unique")

    for (const id of candidateIds(root)) {
      assertEqual(candidateCheckbox(root, id).props.checked, true, `candidate ${id} is selected by default`)
    }
    const rows = candidateRows(root)
    assertEqual(candidateBadge(rows[0]), "覆盖", "an id already in the draft is marked 覆盖")
    assertEqual(candidateBadge(rows[1]), "覆盖", "the second stored id is marked 覆盖")
    assertEqual(candidateBadge(rows[2]), "新增", "a gateway-only id is marked 新增")
    assertEqual(candidateIdText(rows[2]), "glm-4.6-air", "the candidate shows its mono id")
    assert(textOf(rows[2]).includes("GLM-4.6-Air"), "the candidate shows the display name when present")
    assertEqual(confirmButton(root).props.disabled, false, "with everything selected 添加所选 is enabled")
  } finally {
    stub.restore()
  }
})

check("search, 全选/取消全选, and an empty result behave as the shipped dialog does", async () => {
  const handle = boot()
  const stub = stubFetch(pickerAnswer)
  try {
    let tree = await openPicker(handle)

    setSearch(tree, "glm")
    tree = handle.draw()
    assertEqual(candidateIds(tree), ["glm-4.6-air"], "the search filters the candidate list")
    assertEqual(textOf(selectAllButton(tree)).trim(), "取消全选", "a full selection offers 取消全选")

    setSearch(tree, "没有这个模型")
    tree = handle.draw()
    assertEqual(candidateIds(tree).length, 0, "no candidate matches the nonsense query")
    assert(textOf(dialog(tree)).includes("没有匹配的模型。"), "the empty result is announced")

    setSearch(tree, "")
    tree = handle.draw()
    assertEqual(candidateIds(tree).length, 3, "clearing the search restores every candidate")

    // 全选/取消全选 toggles all VISIBLE candidates.
    click(selectAllButton(tree))
    tree = handle.draw()
    for (const id of candidateIds(tree)) {
      assertEqual(candidateCheckbox(tree, id).props.checked, false, `${id} was deselected by 取消全选`)
    }
    assertEqual(confirmButton(tree).props.disabled, true, "nothing selected disables 添加所选")

    click(button(tree, "全选"))
    tree = handle.draw()
    for (const id of candidateIds(tree)) {
      assertEqual(candidateCheckbox(tree, id).props.checked, true, `${id} was re-selected by 全选`)
    }
    assertEqual(confirmButton(tree).props.disabled, false, "a full selection re-enables 添加所选")
  } finally {
    stub.restore()
  }
})

check("取消 closes the dialog without importing anything", async () => {
  const handle = boot()
  const stub = stubFetch(pickerAnswer)
  try {
    let tree = await openPicker(handle)
    setCandidate(tree, "auto", false)
    tree = handle.draw()
    click(cancelButton(tree))
    tree = handle.draw()
    assertEqual(dialogOpen(tree), false, "取消 closes the dialog")
    assertEqual(importStatus(tree), undefined, "cancelling imports nothing")
    assertEqual(modelRows(opened(handle)).length, 2, "the draft keeps its two rows")
    assertEqual(handle.form.calls.length, 0, "cancelling writes no settings")
  } finally {
    stub.restore()
  }
})

check("the mask click and Escape close the dialog without importing", async () => {
  const handle = boot()
  const stub = stubFetch(pickerAnswer)
  try {
    let tree = await openPicker(handle)
    clickMask(tree)
    tree = handle.draw()
    assertEqual(dialogOpen(tree), false, "a mask click closes the dialog")

    tree = await openPicker(handle)
    pressEscape(tree)
    tree = handle.draw()
    assertEqual(dialogOpen(tree), false, "Escape closes the dialog")
    assertEqual(importStatus(handle.draw()), undefined, "closing never imports")
  } finally {
    stub.restore()
  }
})

check("imports the selected gateway models into the models list, then saves them", async () => {
  const handle = boot()
  const stub = stubFetch(pickerAnswer)
  try {
    let tree = await openPicker(handle)
    // Keep the default full selection and confirm.
    tree = await confirmPicker(handle)
    assertEqual(dialogOpen(tree), false, "confirming closes the dialog")

    const status = importStatus(tree)
    assert(status !== undefined, "the import reports its outcome")
    assertEqual(status.props.className.includes("dsh-mtune-ok"), true, "a successful import uses the ok class")
    assert(
      textOf(status).includes("已导入 3 个模型（新增 1、覆盖 2）"),
      `unexpected status text: ${textOf(status)}`,
    )
    assert(textOf(status).includes("网关提示："), "the host warnings follow the import line")
    assertEqual(modelRows(opened(handle)).length, 3, "the brand-new model was appended to the draft")
    assertEqual(handle.form.calls.length, 0, "confirming an import still writes nothing")

    tree = opened(handle)
    click(button(tree, "保存"))
    await settle(() => handle.form.calls.length > 0)

    const models = storedProfile(handle).models
    assertEqual(
      models.map((model) => model.id),
      ["auto", "deepseek-v4.1-flash", "glm-4.6-air"],
      "existing order is kept and new ids append in gateway order",
    )
    assertEqual(
      models[0],
      {
        id: "auto",
        name: "Auto (Gateway)",
        contextWindow: 200000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoningEfforts: { low: "low", high: "high" },
        compat: { supportsStore: true },
      },
      "a selected existing model has every managed field overwritten, unmanaged fields kept",
    )
    assertEqual(
      models[1],
      { id: "deepseek-v4.1-flash", reasoningEfforts: { off: null, high: "high" } },
      "a managed field the candidate no longer declares is cleared, not kept",
    )
    assertEqual(
      models[2],
      {
        id: "glm-4.6-air",
        name: "GLM-4.6-Air",
        contextWindow: 131072,
        maxTokens: 32768,
        input: ["text", "image"],
        reasoningEfforts: { low: "low", medium: "medium", high: "high" },
      },
      "the appended entry carries the mapped capacities, modalities and levels",
    )
  } finally {
    stub.restore()
  }
})

check("imports only the selected candidates", async () => {
  const handle = boot()
  const stub = stubFetch(pickerAnswer)
  try {
    let tree = await openPicker(handle)
    // Drop the brand-new model and the second existing model: only auto is kept.
    setCandidate(tree, "glm-4.6-air", false)
    setCandidate(tree, "deepseek-v4.1-flash", false)
    tree = handle.draw()
    tree = await confirmPicker(handle)

    const status = importStatus(tree)
    assert(
      textOf(status).includes("已导入 1 个模型（新增 0、覆盖 1）"),
      `unexpected status text: ${textOf(status)}`,
    )
    assertEqual(modelRows(opened(handle)).length, 2, "unselected new candidates are not appended")
    click(button(tree, "保存"))
    await settle(() => handle.form.calls.length > 0)
    const models = storedProfile(handle).models
    assertEqual(models.length, 2, "no row was added")
    assertEqual(
      models[1],
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
      "an unselected existing model is untouched",
    )
  } finally {
    stub.restore()
  }
})

check("overwrites managed fields, deletes a no-longer-declared one, and keeps unmanaged fields", async () => {
  const user = fixtureUser()
  const auto = user.providers.exampleGateway.models[0]
  auto.input = ["text", "image"]
  auto.reasoningEfforts = { low: "low", high: "high" }
  const handle = boot({ user })
  const stub = stubFetch(() =>
    jsonResponse({
      ok: true,
      // Discloses only capacities: name, maxTokens, input and reasoningEfforts
      // must be deleted from the stored entry by the overwrite.
      models: [{ id: "auto", contextWindow: 300000 }],
      warnings: [],
    }),
  )
  try {
    let tree = await openPicker(handle)
    assertEqual(candidateBadge(candidateRows(tree)[0]), "覆盖", "the return-only candidate is an overwrite")
    tree = await confirmPicker(handle)
    assert(textOf(importStatus(tree)).includes("已导入 1 个模型（新增 0、覆盖 1）"), "one overwrite is reported")

    tree = opened(handle)
    click(button(tree, "保存"))
    await settle(() => handle.form.calls.length > 0)

    const models = storedProfile(handle).models
    assertEqual(
      models[0],
      { id: "auto", contextWindow: 300000, compat: { supportsStore: true } },
      "every managed field the candidate stopped disclosing is cleared, unmanaged compat survives",
    )
    assertEqual(models[1], fixtureUser().providers.exampleGateway.models[1], "the gateway-missing entry is untouched")

    // The editable controls are rebuilt from the mapped values: the label falls
    // back to the id and the meta line shows the new capacities.
    tree = opened(handle)
    const rows = modelRows(tree)
    assertEqual(modelToggleButton(rows[0]) !== undefined, true, "the overwritten row still renders")
    const { row } = expandModel(handle, 0)
    assert(textOf(row).includes("上下文 300,000"), "the overwritten capacity is shown")
    assertEqual(choice(row, "文本").props.checked, true, "text remains the floor")
    assertEqual(choice(row, "图片").props.checked, false, "cleared modalities show as inherited")
    assertEqual(selectValue(kindSelect(row)), "inherit", "cleared effort shows as inherited")
  } finally {
    stub.restore()
  }
})

check("preserves entries the gateway did not return", async () => {
  const handle = boot()
  const stub = stubFetch(() =>
    jsonResponse({ ok: true, models: [{ id: "auto", name: "Auto", contextWindow: 200000 }], warnings: [] }),
  )
  try {
    let tree = await openPicker(handle)
    tree = await confirmPicker(handle)
    assert(
      textOf(importStatus(tree)).includes("已导入 1 个模型（新增 0、覆盖 1）"),
      `unexpected status text: ${textOf(importStatus(tree))}`,
    )

    click(button(tree, "保存"))
    await settle(() => handle.form.calls.length > 0)
    const models = storedProfile(handle).models
    assertEqual(models.length, 2, "the model the gateway did not return is preserved")
    assertEqual(
      models[1],
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1000000, maxTokens: 128000 },
      "the gateway-missing entry is byte-for-byte untouched",
    )
    assertEqual(models[0].contextWindow, 200000, "the returned entry was updated")
    // The auto candidate declared no input/effort, so those inherited defaults
    // stay deleted while `compat` survives.
    assertEqual(models[0].compat, { supportsStore: true }, "unmanaged raw fields survive the overwrite")
  } finally {
    stub.restore()
  }
})

check("shows the failure message and writes nothing when the fetch fails", async () => {
  const handle = boot()
  const stub = stubFetch(() => jsonResponse({ ok: false, message: "网关返回 HTTP 401：请检查 API key" }, 502))
  try {
    let tree = await openPicker(handle)
    assertEqual(dialogOpen(tree), false, "a failed fetch keeps the dialog closed")
    tree = handle.draw()
    const status = importStatus(tree)
    assert(status !== undefined, "a failed fetch reports a status")
    assertEqual(textOf(status), "导入失败：网关返回 HTTP 401：请检查 API key", "the host's message is shown")
    assertEqual(status.props.className.includes("dsh-mtune-fail"), true, "a failure uses the fail class")
    assertEqual(handle.form.calls.length, 0, "a failed import performs no settings write")
    assertEqual(modelRows(opened(handle)).length, 2, "the draft is unchanged")
  } finally {
    stub.restore()
  }
})

check("treats a non-JSON import answer as a failure", async () => {
  const handle = boot()
  const stub = stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }))
  try {
    const tree = await openPicker(handle)
    assertEqual(dialogOpen(tree), false, "a non-JSON answer keeps the dialog closed")
    const text = textOf(importStatus(tree))
    assert(text.startsWith("导入失败："), `expected a failure status, got: ${text}`)
    assert(text.includes("HTTP 502"), "the status names the HTTP status")
    assertEqual(handle.form.calls.length, 0, "no settings write")
  } finally {
    stub.restore()
  }
})

check("reports a network failure without writing settings", async () => {
  const handle = boot()
  const stub = stubFetch(() => {
    throw new TypeError("fetch failed")
  })
  try {
    const tree = await openPicker(handle)
    assertEqual(dialogOpen(tree), false, "a network failure keeps the dialog closed")
    const text = textOf(importStatus(tree))
    assert(text.startsWith("导入失败："), `expected a failure status, got: ${text}`)
    assert(text.includes("fetch failed"), "the underlying network error is surfaced")
    assertEqual(handle.form.calls.length, 0, "no settings write")
  } finally {
    stub.restore()
  }
})

check("modelOverrides mode updates selected shown ids and skips new models", async () => {
  const user = fixtureUser()
  user.providers.catalogroute.modelOverrides = {
    "some-catalog-model": { contextWindow: 200000, compat: { supportsStore: true } },
    "second-override": { maxTokens: 8192 },
  }
  const handle = boot({ user, provider: "catalogroute" })
  const stub = stubFetch(() =>
    jsonResponse({
      ok: true,
      models: [
        {
          id: "some-catalog-model",
          name: "Some Catalog Model",
          contextWindow: 262144,
          reasoningEfforts: { low: "low", high: "high" },
        },
        { id: "not-in-catalog-model", name: "Brand New", contextWindow: 4096 },
      ],
      warnings: [],
    }),
  )
  try {
    let tree = await openPicker(handle)
    assertEqual(candidateIds(tree).sort().join(","), ["not-in-catalog-model", "some-catalog-model"].sort().join(","), "both candidates are listed")
    const rows = candidateRows(tree)
    assertEqual(candidateBadge(candidateRow(tree, "some-catalog-model")), "覆盖", "the shown id is an overwrite")
    assertEqual(candidateBadge(candidateRow(tree, "not-in-catalog-model")), "新增", "the gateway-only id is new")
    void rows

    const shownBefore = modelRows(opened(handle)).length
    tree = await confirmPicker(handle)
    assertEqual(modelRows(opened(handle)).length, shownBefore, "an override import cannot add rows")

    const status = textOf(importStatus(tree))
    // N counts the selected candidates that produced an entry: one overwrite.
    assert(status.includes("已导入 1 个模型（新增 0、覆盖 1）"), `unexpected status text: ${status}`)
    assert(status.includes("跳过 1 个新模型"), "the skipped gateway-only model is reported")
    assert(status.includes("modelOverrides 模式，不能新增模型条目"), "the skip note explains the mode")

    click(button(tree, "保存"))
    await settle(() => handle.form.calls.length > 0)
    const overrides = storedProfile(handle).modelOverrides
    assertEqual(
      overrides["some-catalog-model"],
      {
        name: "Some Catalog Model",
        contextWindow: 262144,
        reasoningEfforts: { low: "low", high: "high" },
        compat: { supportsStore: true },
      },
      "the selected override has its managed fields overwritten and unmanaged compat kept",
    )
    assertEqual(overrides["second-override"], { maxTokens: 8192 }, "the override the gateway did not return is untouched")
    assertEqual(overrides["not-in-catalog-model"], undefined, "a gateway-only model was not invented as an override")
  } finally {
    stub.restore()
  }
})

check("overwrites and unsets the managed fields of a selected modelOverrides entry", async () => {
  const user = fixtureUser()
  // Every managed field is stored, so the overwrite has something to clear in
  // the field-by-field dict write, not just in the array rewrite.
  user.providers.catalogroute.modelOverrides = {
    "some-catalog-model": {
      name: "Old Name",
      contextWindow: 200000,
      maxTokens: 8192,
      input: ["text", "image"],
      reasoningEfforts: { low: "low" },
      compat: { supportsStore: true },
    },
  }
  const handle = boot({ user, provider: "catalogroute" })
  const stub = stubFetch(() =>
    jsonResponse({ ok: true, models: [{ id: "some-catalog-model", contextWindow: 300000 }], warnings: [] }),
  )
  try {
    let tree = await openPicker(handle)
    assertEqual(candidateBadge(candidateRows(tree)[0]), "覆盖", "the existing override is an overwrite")
    tree = await confirmPicker(handle)
    assert(textOf(importStatus(tree)).includes("已导入 1 个模型（新增 0、覆盖 1）"), "the overwrite is reported")

    click(button(tree, "保存"))
    await settle(() => handle.form.calls.length > 0)
    assertEqual(
      storedProfile(handle).modelOverrides["some-catalog-model"],
      { contextWindow: 300000, compat: { supportsStore: true } },
      "managed fields no longer disclosed are unset in the override dict; compat survives",
    )
  } finally {
    stub.restore()
  }
})

check("warns when the gateway returns no models", async () => {
  const handle = boot()
  const stub = stubFetch(() => jsonResponse({ ok: true, models: [], warnings: ["该供应商没有可用模型"] }))
  try {
    const tree = await openPicker(handle)
    const status = importStatus(tree)
    assert(status !== undefined, "an empty listing reports a status")
    assert(textOf(status).includes("网关没有返回可导入的模型。"), `unexpected status text: ${textOf(status)}`)
    assert(textOf(status).includes("该供应商没有可用模型"), "the host warnings are surfaced")
    assertEqual(status.props.className.includes("dsh-mtune-warn"), true, "zero models uses the warn class")
    assertEqual(handle.form.calls.length, 0, "nothing was imported, so nothing was written")
  } finally {
    stub.restore()
  }
})

check("shows 正在询问提供商… and disables the card while the fetch runs", async () => {
  const handle = boot()
  let release
  const stub = stubFetch(
    () =>
      new Promise((resolve) => {
        release = () => resolve(jsonResponse({ ok: true, models: [], warnings: [] }))
      }),
  )
  try {
    let tree = opened(handle)
    // Make the draft dirty first, so the save assertion below proves the busy
    // state disables it (an untouched draft would be disabled for !dirty anyway).
    const { row } = expandModel(handle, 0)
    toggleChoice(choice(row, "图片"))
    tree = opened(handle)
    assertEqual(button(tree, "保存").props.disabled, false, "the dirty draft can be saved before importing")
    click(button(tree, "获取可用模型"))
    tree = handle.draw()
    const busy = button(tree, "正在询问提供商…")
    assertEqual(busy.props.disabled, true, "the fetch button is disabled while running")
    // The save path shares the busy state, so the draft cannot be written while
    // the listing is still in flight.
    assertEqual(button(tree, "保存").props.disabled, true, "saving is disabled while fetching")

    release()
    await settle(() => maybeButton(handle.draw(), "获取可用模型") !== undefined)
    tree = handle.draw()
    assert(maybeButton(tree, "获取可用模型") !== undefined, "the label returns after the fetch settles")
    assertEqual(handle.form.calls.length, 0, "the fetch itself never wrote settings")
  } finally {
    stub.restore()
  }
})

check("a second identical import is idempotent", async () => {
  const handle = boot()
  const stub = stubFetch(pickerAnswer)
  try {
    // First import + save.
    await openPicker(handle)
    let tree = await confirmPicker(handle)
    click(button(opened(handle), "保存"))
    await settle(() => handle.form.calls.length > 0)
    const first = storedProfile(handle)

    // Second import: every candidate now exists (all 覆盖), same map.
    const again = await openPicker(handle)
    const badges = candidateRows(again).map((row) => candidateBadge(row))
    assertEqual(badges, ["覆盖", "覆盖", "覆盖"], "after the first save every candidate is an overwrite")
    assertEqual(candidateIds(again).length, 3, "the picker lists the mapped ids once each")
    await confirmPicker(handle)
    tree = opened(handle)
    const second = storedProfile(handle)

    // The second merge is shape-identical, so the draft is not even dirty: no
    // second write is needed for the section to stay the same.
    assertEqual(button(tree, "保存").props.disabled, true, "an identical second import leaves nothing to save")
    assertEqual(handle.form.calls.length, 1, "the first import needed its save; the idempotent one did not")
    assertEqual(second, first, "a second import leaves the saved section identical")
    const ids = second.models.map((model) => model.id)
    assertEqual(ids, ["auto", "deepseek-v4.1-flash", "glm-4.6-air"], "model order is stable across imports")
    assertEqual(new Set(ids).size, ids.length, "no duplicate model ids after the second import")

    // Force the write through anyway: the harness drives the handler directly,
    // so the idempotent section is also proven at the settings layer.
    click(button(tree, "保存"))
    await settle(() => handle.form.calls.length > 1)
    assertEqual(storedProfile(handle), first, "even a forced second write produces the identical section")
    assertEqual(handle.form.calls.length, 2, "the forced write is the only extra call")
  } finally {
    stub.restore()
  }
})

check("removing a models-list row rewrites the array without it", async () => {
  const handle = boot()
  const tree = opened(handle)
  click(modelRemoveButton(modelRows(tree)[0]))
  const after = opened(handle)
  assertEqual(modelRows(after).length, 1, "the row is gone from the draft")
  click(button(after, "保存"))
  await settle(() => handle.form.calls.length > 0)
  const models = storedProfile(handle).models
  assertEqual(models.map((model) => model.id), ["deepseek-v4.1-flash"], "the removed entry left the stored array")
})

check("a failed validation names the field and never attempts a write", async () => {
  const handle = boot()
  let { tree, row } = expandModel(handle, 0)
  setKind(row, "自定义档位")
  tree = handle.draw()
  row = modelRows(tree)[0]
  // Remove every non-off level, leaving an effort set with no usable level.
  for (const entry of levelRowEntries(tree, row)) {
    if (entry.level === "off") continue
    click(entry.removeButton)
    tree = handle.draw()
    row = modelRows(tree)[0]
  }
  click(button(tree, "保存"))
  await settle(() => textOf(handle.draw()).includes("至少要包含"))
  assertEqual(handle.form.calls.length, 0, "the refusal prevents the write")
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
  maybeButton,
  textOf,
  findAll,
  find,
  input,
  enabledInput,
  storedProfile,
  settle,
  fixtureUser,
  stubFetch,
  jsonResponse,
  importGroup,
  importStatus,
  defaultInputGroup,
  // redesigned-UI interaction layer
  dialog,
  dialogOpen,
  candidateRows,
  candidateCheckbox,
  candidateRow,
  candidateIds,
  candidateIdText,
  candidateBadge,
  searchInput,
  setSearch,
  selectAllButton,
  confirmButton,
  cancelButton,
  click,
  clickMask,
  pressEscape,
  openPicker,
  confirmPicker,
  setCandidate,
  setKind,
  kindSelect,
  levelRowEntries,
  levelRow,
  addLevelButton,
  modelToggleButton,
  modelRemoveButton,
  expandModel,
  collapseModel,
  toggleChoice,
  changeSelect,
  selectValue,
  optionTexts,
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
