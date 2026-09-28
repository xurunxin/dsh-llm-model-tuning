/**
 * Client half of `dsh-llm-model-tuning`.
 *
 * Registers one card on the `settings.models.provider-card` seat, keyed by the
 * owning settings namespace. Because every configurable pi-ai route declares
 * `settingsNs: 'llm-pi-ai'`, one registration under that key receives every
 * custom-provider card — saved rows and the add-provider draft alike — without
 * the Models section learning anything about this plugin.
 *
 * The shipped `ProviderEditor` deliberately omits a reasoning-effort control:
 * effort is a per-MODEL capability and the models under one provider disagree
 * about it, so a provider-scoped control could only be set to a value some of
 * them reject. This card takes the per-model shape instead — it lists the
 * route's own model entries and edits `reasoningEfforts` (offered levels and
 * their wire spellings) and `input` (request modalities) on each one, which is
 * exactly the granularity those two fields have in the `llm-pi-ai` schema.
 *
 * Writes go through the client settings transport (`configForms`) so the
 * namespace revision fences a stale card, and they land as path ops against the
 * stored user layer — the card only ever names fields it can see.
 *
 * @module dsh-llm-model-tuning/client
 */
window.__ModuleLoader__.load({
  id: "dsh-llm-model-tuning",
  factory: (require) => {
    const React = require("react")
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    /** Settings namespace owned by the pi-ai adapter. */
    const NS = "llm-pi-ai"

    /**
     * Every reasoning level the adapter's config schema accepts, in escalation
     * order. Mirrors `THINKING_LEVELS` in `dsh-llm-pi-ai`; a value outside this
     * set is refused by the schema, so the card offers only these.
     */
    const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

    /** Every request modality the adapter's config schema accepts. */
    const MODALITIES = ["text", "image"]

    /** The one level allowed to carry no wire spelling ("supported, send nothing"). */
    const OPTIONAL_WIRE_LEVEL = "off"

    const LEVEL_LABEL = {
      off: "关闭 (off)",
      minimal: "极低 (minimal)",
      low: "低 (low)",
      medium: "中 (medium)",
      high: "高 (high)",
      xhigh: "极高 (xhigh)",
      max: "最大 (max)",
    }

    const MODALITY_LABEL = { text: "文本", image: "图像" }

    /** Whether a value is a plain data object (not an array, null, or class instance). */
    function isPlainObject(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value)
    }

    /** Read one path out of a plain JSON value, or `undefined`. */
    function getPath(root, path) {
      let node = root
      for (const key of path) {
        if (!isPlainObject(node)) return undefined
        node = node[key]
      }
      return node
    }

    /** Structural JSON equality for the small values this card writes. */
    function deepEqual(a, b) {
      if (a === b) return true
      if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((entry, index) => deepEqual(entry, b[index]))
      }
      if (isPlainObject(a) && isPlainObject(b)) {
        const keysA = Object.keys(a)
        const keysB = Object.keys(b)
        if (keysA.length !== keysB.length) return false
        return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
      }
      return false
    }

    /** A model-entry id, or `undefined` when it carries none. */
    function idOf(entry) {
      const id = isPlainObject(entry) ? entry.id : undefined
      return typeof id === "string" && id.length > 0 ? id : undefined
    }

    /**
     * The reasoning control a model entry carries, in the card's own shape.
     * `inherit` means the field is absent (keep the installed catalog's
     * capability), `none` means the explicit `false` the adapter reads as "this
     * model does not reason", and `custom` carries the offered levels.
     */
    function readEffort(raw) {
      const declared = isPlainObject(raw) ? raw.reasoningEfforts : undefined
      if (declared === undefined) return { kind: "inherit", levels: [], unknown: {} }
      if (declared === false) return { kind: "none", levels: [], unknown: {} }
      if (!isPlainObject(declared)) return { kind: "inherit", levels: [], unknown: {} }
      const levels = []
      for (const level of LEVELS) {
        if (!Object.prototype.hasOwnProperty.call(declared, level)) continue
        const wire = declared[level]
        levels.push({ level, wire: wire === null || wire === undefined ? "" : String(wire) })
      }
      // A stored level this build does not know about is preserved rather than
      // dropped: the card edits the field, it does not narrow the schema.
      const unknown = {}
      for (const [level, wire] of Object.entries(declared)) {
        if (!LEVELS.includes(level)) unknown[level] = wire
      }
      return { kind: levels.length > 0 ? "custom" : "inherit", levels, unknown }
    }

    /** The modality list a model entry declares, or `undefined` when it inherits. */
    function readInput(raw) {
      const declared = isPlainObject(raw) ? raw.input : undefined
      if (!Array.isArray(declared) || declared.length === 0) return undefined
      return declared.filter((entry) => MODALITIES.includes(entry))
    }

    /**
     * The route's editable model entries plus the addressing mode they need.
     *
     * A `models` list replaces the installed catalog and a `modelOverrides` dict
     * reshapes it; the adapter refuses both together, so the card edits whichever
     * the profile already uses. A route with neither serves the installed catalog
     * untouched, and the card then offers to add `modelOverrides` entries.
     */
    function readModels(profile) {
      const list = isPlainObject(profile) ? profile.models : undefined
      if (Array.isArray(list)) {
        return {
          mode: "models",
          entries: list.map((raw) => ({
            id: idOf(raw) ?? "",
            label: (isPlainObject(raw) && typeof raw.name === "string" && raw.name) || idOf(raw) || "",
            input: readInput(raw),
            effort: readEffort(raw),
            raw: isPlainObject(raw) ? raw : {},
          })),
        }
      }
      const overrides = isPlainObject(profile) ? profile.modelOverrides : undefined
      if (isPlainObject(overrides)) {
        return {
          mode: "overrides",
          entries: Object.entries(overrides).map(([id, raw]) => ({
            id,
            label: (isPlainObject(raw) && typeof raw.name === "string" && raw.name) || id,
            input: readInput(raw),
            effort: readEffort(raw),
            raw: isPlainObject(raw) ? raw : {},
          })),
        }
      }
      return { mode: "overrides", entries: [] }
    }

    /** The route-level `defaultInput` fallback, or `undefined` while it is inherited. */
    function readDefaultInput(profile) {
      const declared = isPlainObject(profile) ? profile.defaultInput : undefined
      if (!Array.isArray(declared) || declared.length === 0) return undefined
      return declared.filter((entry) => MODALITIES.includes(entry))
    }

    /**
     * The adapter's own resolution rules for `reasoningEfforts`, reproduced so a
     * refusal names the field while the user is still looking at it. The
     * settings transport folds a rejected write into a recovery read without
     * telling the caller which entry failed, so the card cannot delegate this.
     * @param level - one offered level.
     * @returns the failure text, or `undefined` when the level is serviceable.
     */
    function validateLevel(level) {
      const wire = level.wire.trim()
      if (level.level === OPTIONAL_WIRE_LEVEL) {
        if (level.wire.length > 0 && wire.length === 0) {
          return `${LEVEL_LABEL[level.level]} 的线上取值不能只有空白`
        }
        return undefined
      }
      if (wire.length === 0) {
        return `${LEVEL_LABEL[level.level]} 需要填写发送给接口的线上取值（只有 off 可以留空）`
      }
      return undefined
    }

    /** Validate one draft entry; returns the first failure text or `undefined`. */
    function validateEntry(entry) {
      if (entry.id.trim().length === 0) return "模型 id 不能为空"
      if (entry.effort.kind === "custom") {
        const usable = entry.effort.levels.filter((level) => level.level !== OPTIONAL_WIRE_LEVEL)
        if (usable.length === 0) {
          return `模型 "${entry.id}" 的推理档位至少要包含一个 off 以外的档位，或者改为「关闭推理」/「继承目录」`
        }
        for (const level of entry.effort.levels) {
          const failure = validateLevel(level)
          if (failure !== undefined) return `模型 "${entry.id}"：${failure}`
        }
      }
      return undefined
    }

    /** Validate the whole draft before any write is attempted. */
    function validateDraft(draft) {
      const seen = new Set()
      for (const entry of draft.entries) {
        const failure = validateEntry(entry)
        if (failure !== undefined) return failure
        const id = entry.id.trim()
        if (seen.has(id)) return `模型 id "${id}" 重复`
        seen.add(id)
      }
      return undefined
    }

    /** Build the `reasoningEfforts` value one entry writes, or `undefined` to remove it. */
    function effortValue(entry) {
      if (entry.effort.kind === "inherit") return undefined
      if (entry.effort.kind === "none") return false
      const declared = { ...(entry.effort.unknown ?? {}) }
      for (const level of entry.effort.levels) {
        const wire = level.wire.trim()
        // `off` with an empty spelling means "supported, send nothing", which the
        // adapter spells as an explicit null; every other level needs a string.
        declared[level.level] = level.level === OPTIONAL_WIRE_LEVEL && wire.length === 0 ? null : wire
      }
      return declared
    }

    /** Apply one entry's two edited fields onto its stored shape. */
    function applyEntry(entry) {
      const next = { ...entry.raw }
      const input = entry.input === undefined || entry.input.length === 0 ? undefined : entry.input
      if (input === undefined) delete next.input
      else next.input = input
      const effort = effortValue(entry)
      if (effort === undefined) delete next.reasoningEfforts
      else next.reasoningEfforts = effort
      delete next.id
      return next
    }

    /** The fields one entry actually declares, ignoring identity. */
    function declaredFields(entry) {
      return Object.keys(applyEntry(entry))
    }

    /**
     * The comparison shape of a draft: in `modelOverrides` mode an entry that
     * declares nothing is not a change at all, because an empty override cannot
     * be stored and would produce no path op.
     */
    function shapeOf(mode, entries, defaultInput) {
      const shaped = (mode === "models" ? entries : entries.filter((entry) => declaredFields(entry).length > 0)).map((entry) => ({
        id: entry.id.trim(),
        fields: applyEntry(entry),
      }))
      return { entries: shaped, defaultInput: defaultInput ?? [] }
    }

    /**
     * The ordered path ops for this draft, addressed against the stored section.
     *
     * A `models` list is an array, and the settings path-op walker deliberately
     * refuses to descend through arrays, so that whole array is written as one
     * value. A `modelOverrides` dict is a plain object, so those entries are
     * edited field by field and every unrelated field stays untouched.
     * @param settingsPath - path from the section root to this route's profile.
     * @param draft - the validated draft.
     * @returns ordered path ops for one settings write.
     */
    function buildOps(settingsPath, draft) {
      const ops = []
      if (draft.defaultInput === undefined || draft.defaultInput.length === 0) {
        ops.push({ op: "unset", path: [...settingsPath, "defaultInput"] })
      } else {
        ops.push({ op: "set", path: [...settingsPath, "defaultInput"], value: draft.defaultInput })
      }
      if (draft.mode === "models") {
        const value = draft.entries.map((entry) => {
          const next = applyEntry(entry)
          next.id = entry.id.trim()
          return next
        })
        ops.push({ op: "set", path: [...settingsPath, "models"], value })
        return ops
      }
      // Every entry the card showed but the draft no longer carries goes away.
      for (const id of draft.removed ?? []) {
        ops.push({ op: "unset", path: [...settingsPath, "modelOverrides", id] })
      }
      for (const entry of draft.entries) {
        const id = entry.id.trim()
        const next = applyEntry(entry)
        delete next.id
        // An entry that ends up declaring nothing cannot be stored as an empty
        // override, so the whole id is removed rather than left as `{}`.
        if (Object.keys(next).length === 0) {
          ops.push({ op: "unset", path: [...settingsPath, "modelOverrides", id] })
          continue
        }
        // Otherwise fields are addressed one at a time so the other entries of
        // the dict — including ones this card never rendered — stay exactly as
        // stored. A field the entry used to declare but no longer does must be
        // unset, or reverting a control to "inherit" would leave the old value.
        const fields = new Set([...Object.keys(entry.raw), ...Object.keys(next)])
        fields.delete("id")
        for (const field of fields) {
          if (Object.prototype.hasOwnProperty.call(next, field)) {
            ops.push({ op: "set", path: [...settingsPath, "modelOverrides", id, field], value: next[field] })
          } else {
            ops.push({ op: "unset", path: [...settingsPath, "modelOverrides", id, field] })
          }
        }
      }
      return ops
    }

    /** Subscribe to one configuration form and return its current snapshot. */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])
      return snapshot
    }

    /** The card stylesheet. */
    const CSS = `
.dsh-mtune { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-mtune-head { display: flex; align-items: baseline; gap: 8px; }
.dsh-mtune-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-mtune-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.dsh-mtune-group { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.dsh-mtune-group-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-mtune-model { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.dsh-mtune-model-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-mtune-model-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-mtune-model-id { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-mtune-field { display: flex; flex-direction: column; gap: 5px; }
.dsh-mtune-field-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-mtune-radios { display: flex; flex-wrap: wrap; gap: 10px; }
.dsh-mtune-radio { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsh-mtune-levels { display: flex; flex-direction: column; gap: 5px; padding-left: 2px; }
.dsh-mtune-level { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-mtune-level-name { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-primary); min-width: 132px; cursor: pointer; }
.dsh-mtune-input { font: inherit; font-size: 12px; padding: 4px 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); min-width: 132px; }
.dsh-mtune-input:disabled { opacity: 0.5; }
.dsh-mtune-modalities { display: flex; flex-wrap: wrap; gap: 12px; }
.dsh-mtune-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-mtune-button { font: inherit; font-size: 12px; padding: 5px 11px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsh-mtune-button-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dsh-mtune-button:disabled { opacity: 0.5; cursor: default; }
.dsh-mtune-button-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-mtune-status { font-size: 12px; }
.dsh-mtune-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-mtune-fail { color: var(--dsw-alias-state-error-primary); }
.dsh-mtune-warn { color: var(--dsw-alias-state-warn-primary); }
`

    /**
     * Install the card stylesheet and return the disposer that removes it.
     *
     * A module bundle is invoked with `require` alone, so it has no `styles`
     * helper — that API belongs to the dynamic-Plugin sandbox. The sheet is
     * owned by this Plugin's fiber through the returned disposer, which
     * `ctx.effect` runs on stop or update. This mirrors what the shipped
     * bundles do.
     */
    function installStyles() {
      const tag = document.createElement("style")
      tag.setAttribute("data-dsh-plugin", "llm-model-tuning")
      tag.textContent = CSS
      document.head.append(tag)
      return () => tag.remove()
    }

    /** One checkbox or radio bound to a boolean. */
    function Check(props) {
      return React.createElement(
        "label",
        { className: "dsh-mtune-radio" },
        React.createElement("input", {
          type: props.type ?? "checkbox",
          name: props.name,
          checked: props.checked,
          disabled: props.disabled,
          onChange: () => props.onChange(!props.checked),
        }),
        props.label,
      )
    }

    /** The reasoning-effort control for one model entry. */
    function EffortEditor(props) {
      const { entry, disabled, onChange, group } = props
      const effort = entry.effort
      const setKind = (kind) => onChange({ ...entry, effort: { ...effort, kind, levels: kind === "custom" && effort.levels.length === 0 ? [{ level: "high", wire: "high" }] : effort.levels } })
      const toggleLevel = (level) => {
        const present = effort.levels.some((candidate) => candidate.level === level)
        const levels = present
          ? effort.levels.filter((candidate) => candidate.level !== level)
          : [...effort.levels, { level, wire: level === OPTIONAL_WIRE_LEVEL ? "" : level }]
        onChange({ ...entry, effort: { ...effort, kind: "custom", levels } })
      }
      const setWire = (level, wire) => {
        onChange({ ...entry, effort: { ...effort, levels: effort.levels.map((candidate) => (candidate.level === level ? { ...candidate, wire } : candidate)) } })
      }
      return React.createElement(
        "div",
        { className: "dsh-mtune-field" },
        React.createElement("span", { className: "dsh-mtune-field-label" }, "推理强度档位"),
        React.createElement(
          "div",
          { className: "dsh-mtune-radios" },
          React.createElement(Check, { type: "radio", name: group, checked: effort.kind === "inherit", disabled, label: "继承目录", onChange: () => setKind("inherit") }),
          React.createElement(Check, { type: "radio", name: group, checked: effort.kind === "none", disabled, label: "关闭推理", onChange: () => setKind("none") }),
          React.createElement(Check, { type: "radio", name: group, checked: effort.kind === "custom", disabled, label: "自定义档位", onChange: () => setKind("custom") }),
        ),
        effort.kind === "custom"
          ? React.createElement(
              "div",
              { className: "dsh-mtune-levels" },
              LEVELS.map((level) => {
                const declared = effort.levels.find((candidate) => candidate.level === level)
                const checked = declared !== undefined
                return React.createElement(
                  "div",
                  { className: "dsh-mtune-level", key: level },
                  React.createElement(
                    "label",
                    { className: "dsh-mtune-level-name" },
                    React.createElement("input", { type: "checkbox", checked, disabled, onChange: () => toggleLevel(level) }),
                    LEVEL_LABEL[level],
                  ),
                  React.createElement("input", {
                    className: "dsh-mtune-input",
                    type: "text",
                    value: checked ? declared.wire : "",
                    disabled: disabled || !checked,
                    placeholder: level === OPTIONAL_WIRE_LEVEL ? "留空 = 不发送" : "线上取值",
                    onChange: (event) => setWire(level, event.target.value),
                  }),
                )
              }),
              React.createElement("span", { className: "dsh-mtune-hint" }, "档位键是选择器显示的名字，线上取值是该档位实际发给接口的字段值；只有 off 允许留空。"),
            )
          : null,
      )
    }

    /**
     * The multimodal-input control for one model entry.
     *
     * `input` REPLACES the modality list rather than extending it, so declaring
     * images alone would quietly drop text and leave a model the harness can no
     * longer talk to. Text is the one modality every supported protocol carries,
     * so it is held on and only the optional modalities are user-controlled.
     */
    function InputEditor(props) {
      const { entry, disabled, onChange } = props
      const toggle = (modality) => {
        const current = entry.input ?? []
        const next = current.includes(modality)
          ? current.filter((candidate) => candidate !== modality)
          : [...current, modality]
        // A declaration always carries text; with no optional modality left the
        // entry declares nothing, which returns the model to the installed
        // catalog's own answer instead of pinning it to text-only.
        const optional = next.filter((candidate) => candidate !== "text")
        onChange({ ...entry, input: optional.length === 0 ? undefined : ["text", ...optional] })
      }
      return React.createElement(
        "div",
        { className: "dsh-mtune-field" },
        React.createElement("span", { className: "dsh-mtune-field-label" }, "多模态输入"),
        React.createElement(
          "div",
          { className: "dsh-mtune-modalities" },
          MODALITIES.map((modality) =>
            React.createElement(Check, {
              key: modality,
              checked: modality === "text" ? true : (entry.input ?? []).includes(modality),
              // Text cannot be turned off: it is the floor, not a choice.
              disabled: disabled || modality === "text",
              label: MODALITY_LABEL[modality],
              onChange: () => toggle(modality),
            }),
          ),
        ),
        React.createElement(
          "span",
          { className: "dsh-mtune-hint" },
          "文本始终保留；不勾选「图像」表示沿用内置目录对该模型的声明。声明会整体覆盖该模型的输入模态列表。",
        ),
      )
    }

    /** One model row: identity, reasoning levels, modalities, removal. */
    function ModelRow(props) {
      const { entry, disabled, onChange, onRemove, removable, group } = props
      return React.createElement(
        "div",
        { className: "dsh-mtune-model" },
        React.createElement(
          "div",
          { className: "dsh-mtune-model-head" },
          React.createElement(
            "span",
            null,
            React.createElement("span", { className: "dsh-mtune-model-name" }, entry.label || entry.id || "(未命名)"),
            entry.label && entry.label !== entry.id ? React.createElement("span", { className: "dsh-mtune-model-id" }, ` · ${entry.id}`) : null,
          ),
          removable
            ? React.createElement(
                "button",
                { type: "button", className: "dsh-mtune-button dsh-mtune-button-danger", disabled, onClick: onRemove },
                "移除",
              )
            : null,
        ),
        React.createElement(EffortEditor, { entry, disabled, onChange, group }),
        React.createElement(InputEditor, { entry, disabled, onChange }),
      )
    }

    /**
     * The card itself: one provider row's per-model tuning surface.
     * @param props - the resolved route, its configuration form, and owner facts.
     * @returns the card, or `null` when this route is not a pi-ai profile.
     */
    function ModelTuningCard(props) {
      const { form, provider, configured } = props
      const snapshot = useFormSnapshot(form)
      const settingsPath = Array.isArray(provider?.settingsPath) ? provider.settingsPath : []
      const available = snapshot.status === "ready" && snapshot.value !== undefined

      // The user layer is the card's edit surface; a route declared only in the
      // composition base falls back to the resolved value so it can still be
      // tuned (that write is what materializes it in the user layer).
      const storedProfile = getPath(snapshot.user, settingsPath)
      const resolvedProfile = getPath(snapshot.value, settingsPath)
      const profile = isPlainObject(storedProfile) ? storedProfile : isPlainObject(resolvedProfile) ? resolvedProfile : undefined
      const source = React.useMemo(() => readModels(profile), [profile])
      const sourceDefault = React.useMemo(() => readDefaultInput(profile), [profile])
      const signature = React.useMemo(
        () => `${String(snapshot.revision)}|${JSON.stringify(profile ?? null)}`,
        [snapshot.revision, profile],
      )

      const [draft, setDraft] = React.useState(() => ({ mode: source.mode, entries: source.entries, defaultInput: sourceDefault, removed: [] }))
      const [newId, setNewId] = React.useState("")
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState(undefined)
      const [expanded, setExpanded] = React.useState(false)

      // Re-seed the draft whenever the stored section moves: an accepted write,
      // another tab, or a hand edit of settings.yaml.
      React.useEffect(() => {
        setDraft({ mode: source.mode, entries: source.entries, defaultInput: sourceDefault, removed: [] })
        setNewId("")
        setStatus(undefined)
      }, [signature])

      if (settingsPath.length === 0 || provider?.settingsNs !== NS) return null

      const disabled = busy || !snapshot.writable
      const dirty =
        !deepEqual(
          shapeOf(draft.mode, draft.entries, draft.defaultInput),
          shapeOf(source.mode, source.entries, sourceDefault),
        ) || (draft.removed ?? []).length > 0

      const setEntry = (index, next) => {
        setDraft((current) => ({ ...current, entries: current.entries.map((entry, i) => (i === index ? next : entry)) }))
        setStatus(undefined)
      }
      const removeEntry = (index) => {
        setDraft((current) => {
          const entry = current.entries[index]
          const removed = current.mode === "overrides" && current.removed.includes(entry.id) === false && source.entries.some((candidate) => candidate.id === entry.id)
            ? [...current.removed, entry.id]
            : current.removed
          return { ...current, entries: current.entries.filter((_, i) => i !== index), removed }
        })
        setStatus(undefined)
      }
      const addEntry = () => {
        const id = newId.trim()
        if (id.length === 0) return
        setDraft((current) => {
          if (current.entries.some((entry) => entry.id === id)) return current
          return {
            ...current,
            entries: [...current.entries, { id, label: id, input: undefined, effort: { kind: "inherit", levels: [] }, raw: {} }],
            removed: (current.removed ?? []).filter((candidate) => candidate !== id),
          }
        })
        setNewId("")
        setStatus(undefined)
      }
      const toggleDefaultInput = (modality) => {
        setDraft((current) => {
          const list = current.defaultInput ?? []
          const next = list.includes(modality) ? list.filter((candidate) => candidate !== modality) : [...list, modality]
          // `defaultInput` REPLACES the fallback for models that declare nothing
          // and may not be empty, so it always carries text; with no optional
          // modality left the field is removed so the adapter's own `[text]`
          // default answers instead of a text-only list being pinned here.
          const optional = next.filter((candidate) => candidate !== "text")
          return { ...current, defaultInput: optional.length === 0 ? undefined : ["text", ...optional] }
        })
        setStatus(undefined)
      }

      /**
       * Write the draft.
       *
       * `mutate` resolves to whether the Host ACCEPTED the write, after any
       * recovery read, so a validation refusal is reported as a failure rather
       * than being mistaken for success. The card still validates locally first:
       * the transport says a write was refused, not which field caused it.
       */
      const save = async () => {
        const failure = validateDraft(draft)
        if (failure !== undefined) {
          setStatus({ kind: "fail", text: failure })
          return
        }
        setBusy(true)
        setStatus(undefined)
        try {
          const accepted = await form.mutate(buildOps(settingsPath, draft))
          setStatus(
            accepted
              ? { kind: "ok", text: "已写入设置，下一个请求生效。" }
              : { kind: "fail", text: "写入未生效：档位取值或模型定义被适配器校验拒绝，请检查后重试。" },
          )
        } catch (error) {
          setStatus({ kind: "fail", text: `写入失败：${error instanceof Error ? error.message : String(error)}` })
        } finally {
          setBusy(false)
        }
      }

      if (!available) {
        return React.createElement(
          "div",
          { className: "dsh-mtune" },
          React.createElement("div", { className: "dsh-mtune-head" }, React.createElement("span", { className: "dsh-mtune-title" }, "推理强度与多模态输入")),
          React.createElement("span", { className: "dsh-mtune-hint" }, snapshot.writable === false && snapshot.status === "ready" ? "当前设置文档只读，无法修改。" : "正在读取设置…"),
        )
      }

      return React.createElement(
        "div",
        { className: "dsh-mtune" },
        React.createElement(
          "div",
          { className: "dsh-mtune-head" },
          React.createElement("span", { className: "dsh-mtune-title" }, "推理强度与多模态输入"),
          React.createElement(
            "button",
            { type: "button", className: "dsh-mtune-button", onClick: () => setExpanded((value) => !value) },
            expanded ? "收起" : "展开配置",
          ),
        ),
        React.createElement(
          "span",
          { className: "dsh-mtune-hint" },
          configured
            ? `按模型配置 ${String(draft.entries.length)} 个模型条目；档位与模态都是每个模型各自的能力。`
            : "该供应商尚未配置：下面的修改会写入其档案，保存后即生效。",
        ),
        expanded
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                "div",
                { className: "dsh-mtune-group" },
                React.createElement("span", { className: "dsh-mtune-group-title" }, "本供应商默认输入模态"),
                React.createElement(
                  "div",
                  { className: "dsh-mtune-modalities" },
                  MODALITIES.map((modality) =>
                    React.createElement(Check, {
                      key: modality,
                      checked: modality === "text" ? true : (draft.defaultInput ?? []).includes(modality),
                      // Text is the floor here too: `defaultInput` cannot be empty.
                      disabled: disabled || modality === "text",
                      label: MODALITY_LABEL[modality],
                      onChange: () => toggleDefaultInput(modality),
                    }),
                  ),
                ),
                React.createElement("span", { className: "dsh-mtune-hint" }, "只对该供应商列出、且自身与内置目录都没声明的模型生效；不会收窄任何已有声明。"),
              ),
              draft.entries.length === 0
                ? React.createElement(
                    "div",
                    { className: "dsh-mtune-group" },
                    React.createElement("span", { className: "dsh-mtune-hint" }, "该供应商使用内置目录、没有显式模型条目。添加一个模型 id 即可为它单独配置档位与模态（写为 modelOverrides）。"),
                  )
                : draft.entries.map((entry, index) =>
                    React.createElement(ModelRow, {
                      key: `${entry.id}-${String(index)}`,
                      entry,
                      disabled,
                      removable: true,
                      // A per-row radio group name keeps each row's effort choice
                      // independent instead of sharing one document-wide group.
                      group: `${String(provider?.provider ?? "provider")}-effort-${String(index)}`,
                      onChange: (next) => setEntry(index, next),
                      onRemove: () => removeEntry(index),
                    }),
                  ),
              React.createElement(
                "div",
                { className: "dsh-mtune-actions" },
                React.createElement("input", {
                  className: "dsh-mtune-input",
                  type: "text",
                  value: newId,
                  disabled,
                  placeholder: "模型 id",
                  onChange: (event) => setNewId(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      addEntry()
                    }
                  },
                }),
                React.createElement("button", { type: "button", className: "dsh-mtune-button", disabled: disabled || newId.trim().length === 0, onClick: addEntry }, "添加模型"),
              ),
              React.createElement(
                "div",
                { className: "dsh-mtune-actions" },
                React.createElement(
                  "button",
                  { type: "button", className: "dsh-mtune-button dsh-mtune-button-primary", disabled: disabled || !dirty, onClick: save },
                  busy ? "保存中…" : "保存",
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsh-mtune-button",
                    disabled: disabled || !dirty,
                    onClick: () => {
                      setDraft({ mode: source.mode, entries: source.entries, defaultInput: sourceDefault, removed: [] })
                      setStatus(undefined)
                    },
                  },
                  "放弃修改",
                ),
                status !== undefined
                  ? React.createElement(
                      "span",
                      { className: `dsh-mtune-status ${status.kind === "ok" ? "dsh-mtune-ok" : status.kind === "fail" ? "dsh-mtune-fail" : "dsh-mtune-warn"}` },
                      status.text,
                    )
                  : dirty
                    ? React.createElement("span", { className: "dsh-mtune-status dsh-mtune-warn" }, "有未保存的修改")
                    : null,
              ),
            )
          : null,
      )
    }

    /** Cordis plugin name. */
    const name = "llm-model-tuning"

    /**
     * Hard dependencies: the slot seat this card occupies and the settings
     * transport that reads and writes the pi-ai namespace. Both are provided by
     * shipped UI plugins, so the row waits for them rather than degrading.
     *
     * `configForms` replaces the older `settingsScope` service: a namespace's
     * editor now comes from the shared configuration-form registry, and its
     * `mutate` reports whether the Host accepted the write instead of only
     * folding a silent recovery read.
     */
    const inject = ["slots", "configForms"]

    /**
     * Register the card.
     *
     * The namespace is owned by the pi-ai adapter, not by this plugin, so the
     * card follows it through `configForms.whileServed`: it appears only while
     * the Host actually serves `llm-pi-ai`, and a deployment that never composed
     * that adapter shows no trace of this card. One form serves every provider
     * card of the family — it derives from the shared describe mirror, so no
     * card performs a wire read of its own.
     */
    function apply(ctx) {
      // Both contributions are owned by this Plugin's fiber: the stylesheet
      // through the disposer `installStyles` returns and the slot through
      // `slots.inject`/`slots.register`, so a stop or update removes them.
      ctx.effect(() => installStyles(), "llm-model-tuning: card styles")
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () => {
            const form = ctx.configForms.get(NS)
            return ctx.slots.inject("settings.models.provider-card", () =>
              ctx.slots.register({ name: "settings.models.provider-card", key: NS }, (ownerProps = {}) =>
                React.createElement(ModelTuningCard, {
                  form,
                  provider: ownerProps.provider,
                  configured: ownerProps.configured === true,
                }),
              ),
            )
          }),
        "llm-model-tuning: provider-card seat",
      )
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
