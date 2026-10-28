/**
 * Client half of `dsh-llm-model-tuning`.
 *
 * Registers one card on the `settings.models.provider-card` seat, keyed by the
 * owning settings namespace. Because every configurable pi-ai route declares
 * `settingsNs: 'llm-pi-ai'`, one registration under that key receives every
 * custom-provider card — saved rows and the add-provider draft alike — without
 * the Models section learning anything about this plugin.
 *
 * The card is a per-model tuning surface rendered in the shipped Settings →
 * Models page's own visual language: a collapsed header, a provider-level
 * default-input field group, a gateway-import group that opens a model-selection
 * dialog, a `模型（N）` list whose entries expand into their input types and
 * reasoning-effort controls, an add-model row, and save/discard actions.
 *
 * The shipped `ProviderEditor` deliberately omits a reasoning-effort control:
 * effort is a per-MODEL capability and the models under one provider disagree
 * about it, so a provider-scoped control could only be set to a value some of
 * them reject. This card takes the per-model shape instead — it lists the
 * route's own model entries and edits `reasoningEfforts` (offered levels and
 * their wire spellings) and `input` (request modalities) on each one, which is
 * exactly the granularity those two fields have in the `llm-pi-ai` schema.
 *
 * Importing asks the host half to list the provider's gateway models, lets the
 * user pick which candidates to merge in a searchable dialog, and edits the
 * draft only. When a selected candidate already exists in the draft its managed
 * fields (`name`, `contextWindow`, `maxTokens`, `input`, `reasoningEfforts`)
 * are overwritten — a field the candidate no longer discloses is deleted — while
 * `id` and unmanaged raw fields survive. Nothing reaches settings until 保存.
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

    /**
     * The one level seeded when the user turns a model's reasoning control to
     * `自定义档位` while it declares none: a single, valid, commonly supported
     * level, so the editor starts from something the adapter accepts and the
     * user can add or delete rows from there.
     */
    const INITIAL_CUSTOM_LEVEL = "high"

    /**
     * The fields an import overwrites on a selected candidate that already
     * exists in the draft. Everything else a stored entry carries — `id` and
     * unmanaged adapter fields such as `compat` — is preserved.
     */
    const MANAGED_FIELDS = ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"]

    /**
     * Same-origin, browser-relative endpoint the host half registers. The path
     * carries no leading slash on purpose: the bundle is served to the settings
     * page the same way its assets are, and the host owns the origin.
     */
    const IMPORT_URL = "api/dsh-llm-model-tuning/models"

    const LEVEL_LABEL = {
      off: "关闭 (off)",
      minimal: "极低 (minimal)",
      low: "低 (low)",
      medium: "中 (medium)",
      high: "高 (high)",
      xhigh: "极高 (xhigh)",
      max: "最大 (max)",
    }

    const MODALITY_LABEL = { text: "文本", image: "图片" }

    /**
     * Chinese labels for the fields the Host's models.dev completion can fill,
     * shown in the `补全` badge's title. An unknown field name falls back to the
     * raw key so a future Host field is still named rather than hidden.
     */
    const MODELS_DEV_FIELD_LABEL = {
      name: "名称",
      contextWindow: "上下文",
      maxTokens: "最大输出",
      input: "输入类型",
      reasoningEfforts: "推理档位",
    }

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

    /** Own-property test that also works for null-prototype JSON objects. */
    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key)
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
        return keysA.every((key) => hasOwn(b, key) && deepEqual(a[key], b[key]))
      }
      return false
    }

    /** A model-entry id, or `undefined` when it carries none. */
    function idOf(entry) {
      const id = isPlainObject(entry) ? entry.id : undefined
      return typeof id === "string" && id.length > 0 ? id : undefined
    }

    /** The display label a model entry promises: its name when disclosed, else its id. */
    function labelOf(raw, fallback) {
      const name = isPlainObject(raw) ? raw.name : undefined
      return typeof name === "string" && name.length > 0 ? name : fallback
    }

    /* ------------------------------------------------------------ card model */

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
        if (!hasOwn(declared, level)) continue
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
            label: labelOf(raw, idOf(raw) ?? ""),
            input: readInput(raw),
            effort: readEffort(raw),
            raw: isPlainObject(raw) ? raw : {},
            deleted: [],
          })),
        }
      }
      const overrides = isPlainObject(profile) ? profile.modelOverrides : undefined
      if (isPlainObject(overrides)) {
        return {
          mode: "overrides",
          entries: Object.entries(overrides).map(([id, raw]) => ({
            id,
            label: labelOf(raw, id),
            input: readInput(raw),
            effort: readEffort(raw),
            raw: isPlainObject(raw) ? raw : {},
            deleted: [],
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

    /* ----------------------------------------------------------- gateway import */

    /**
     * Convert one host-mapped gateway entry into the card's own draft shape.
     *
     * The mapped entry already IS the storable shape, so `raw` carries every
     * disclosed capacity field (`name`, `contextWindow`, `maxTokens`) through the
     * later `models` array rewrite unchanged; only `input` and `reasoningEfforts`
     * are lifted into editable controls.
     * @param entry - one entry of the host's `models` answer.
     * @returns the draft entry for it, or `undefined` when it carries no id.
     */
    function toDraftEntry(entry) {
      const raw = isPlainObject(entry) ? entry : {}
      const id = idOf(raw)
      if (id === undefined) return undefined
      return {
        id,
        label: labelOf(raw, id),
        input: readInput(raw),
        effort: readEffort(raw),
        raw: { ...raw },
        deleted: [],
      }
    }

    /**
     * Overwrite one selected existing entry with a mapped gateway entry.
     *
     * Every managed field is replaced — including by deletion when the candidate
     * no longer discloses it, which is what lets a gateway that stops reporting a
     * model's reasoning levels clear the old ones. `id` and unmanaged raw fields
     * (`compat`, …) stay exactly as they were, and the editable controls are
     * rebuilt from the resulting raw shape.
     *
     * Deletion is remembered in `deleted`: a `modelOverrides` write addresses
     * fields one at a time and derives them from the entry's own raw shape, so a
     * field that only ever existed in the stored layer must still be named or
     * the write could not unset it.
     * @param stored - the draft entry being overwritten.
     * @param mapped - the mapped gateway entry (`toDraftEntry(...).raw`).
     * @returns the overwritten draft entry.
     */
    function overwriteDraftEntry(stored, mapped) {
      const raw = { ...stored.raw }
      const deleted = new Set(stored.deleted ?? [])
      for (const field of MANAGED_FIELDS) {
        if (hasOwn(mapped, field)) {
          raw[field] = mapped[field]
          deleted.delete(field)
        } else {
          delete raw[field]
          // Only a field that really existed needs an unset op; a managed field
          // the stored shape never had is simply absent either way.
          if (hasOwn(stored.raw, field) || deleted.has(field)) deleted.add(field)
        }
      }
      return {
        id: stored.id,
        label: labelOf(raw, stored.id),
        input: readInput(raw),
        effort: readEffort(raw),
        raw,
        deleted: [...deleted],
      }
    }

    /**
     * Merge only the selected gateway candidates into the current draft.
     *
     * `models` mode keeps the existing order, overwrites ids it already shows and
     * appends brand-new ids in gateway order. `modelOverrides` mode can only
     * reshape models the installed catalog knows, so ids that are not already
     * shown are skipped and counted instead of being invented as overrides.
     * Entries the gateway does not return — and candidates the user did not
     * select — are left exactly as they are.
     * @param draft - the card's current draft.
     * @param candidates - the selected gateway candidates, in gateway order.
     * @returns the merged entries plus the counts the status line reports.
     */
    function mergeSelectedEntries(draft, candidates) {
      const entries = [...draft.entries]
      const indexes = new Map()
      entries.forEach((entry, index) => indexes.set(entry.id, index))
      const handled = new Set()
      let added = 0
      let overwritten = 0
      let skipped = 0
      for (const candidate of candidates) {
        const mapped = toDraftEntry(candidate)
        // One gateway id maps to one draft entry; a duplicate answer is ignored.
        if (mapped === undefined || handled.has(mapped.id)) continue
        handled.add(mapped.id)
        const index = indexes.get(mapped.id)
        if (index !== undefined) {
          entries[index] = overwriteDraftEntry(entries[index], mapped.raw)
          overwritten += 1
          continue
        }
        if (draft.mode !== "models") {
          skipped += 1
          continue
        }
        indexes.set(mapped.id, entries.length)
        entries.push(mapped)
        added += 1
      }
      return { entries, added, overwritten, skipped }
    }

    /**
     * Read the optional `modelsDev` key of the Host's import answer.
     *
     * The key is omitted by older Hosts, and returning `undefined` for it is
     * what keeps the pre-models.dev UI byte-for-byte unchanged. When present it
     * is normalized defensively: `available === true` means the lookup really
     * ran and `enriched` lists the ids it filled (and which fields it filled);
     * any other shape is reported as unavailable so the dialog can say why.
     * @param declared - the raw `modelsDev` value of the import answer.
     * @returns the normalized completion report, or `undefined` when the Host is older.
     */
    function readModelsDev(declared) {
      if (declared === undefined) return undefined
      const raw = isPlainObject(declared) ? declared : {}
      const enriched = []
      const seen = new Set()
      for (const entry of Array.isArray(raw.enriched) ? raw.enriched : []) {
        const id = idOf(entry)
        if (id === undefined || seen.has(id)) continue
        seen.add(id)
        enriched.push({
          id,
          fields: Array.isArray(entry.fields) ? entry.fields.map((field) => String(field)) : [],
        })
      }
      const unmatched = Array.isArray(raw.unmatched)
        ? raw.unmatched.filter((id) => typeof id === "string" && id.length > 0)
        : []
      const error = typeof raw.error === "string" && raw.error.length > 0 ? raw.error : undefined
      return {
        source: typeof raw.source === "string" && raw.source.length > 0 ? raw.source : "models.dev",
        available: raw.available === true,
        matched:
          typeof raw.matched === "number" && Number.isFinite(raw.matched)
            ? Math.max(0, Math.trunc(raw.matched))
            : enriched.length,
        enriched,
        unmatched,
        error,
      }
    }

    /** The Chinese field list a `补全` badge names in its title, e.g. `上下文、最大输出`. */
    function modelsDevFieldsText(fields) {
      const labels = fields.map((field) => MODELS_DEV_FIELD_LABEL[field] ?? field)
      return labels.length > 0 ? labels.join("、") : "设置"
    }

    /** The one-line completion hint above the candidate list, or `null` when there is nothing to say. */
    function modelsDevHint(modelsDev) {
      if (modelsDev === undefined) return null
      if (modelsDev.available === false) {
        return `models.dev 补全不可用：${modelsDev.error ?? "未知原因"}`
      }
      if (modelsDev.enriched.length === 0) return null
      return `已通过 models.dev 自动补全 ${String(modelsDev.enriched.length)} 个模型的设置。`
    }

    /**
     * Ask the host half to list this provider's models from its gateway.
     *
     * The host resolves the credential and does the Magpie mapping; the page only
     * speaks the same-origin route, so the API key never reaches the browser.
     * Ids are de-duplicated here so the selection dialog can key candidates by id
     * and a duplicated listing cannot make one model import twice.
     * @param providerId - the route id whose card this is.
     * @returns the mapped entry list, the host's per-model warnings, and the
     *   normalized models.dev completion report (`undefined` on an older Host).
     */
    async function requestGatewayModels(providerId) {
      if (typeof globalThis.fetch !== "function") throw new Error("当前页面没有可用的 fetch")
      let response
      try {
        response = await globalThis.fetch(IMPORT_URL, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: providerId, settingsNs: NS }),
        })
      } catch (error) {
        throw new Error(`无法连接设置服务：${error instanceof Error ? error.message : String(error)}`)
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`设置服务返回了无法解析的响应（HTTP ${String(response.status)}）`)
      }
      if (response.ok !== true || !isPlainObject(payload) || payload.ok !== true) {
        throw new Error(
          isPlainObject(payload) && typeof payload.message === "string" && payload.message.length > 0
            ? payload.message
            : `HTTP ${String(response.status)}`,
        )
      }
      const warnings = Array.isArray(payload.warnings) ? payload.warnings.map((warning) => String(warning)) : []
      const models = []
      const seen = new Set()
      let malformed = 0
      let duplicated = 0
      for (const entry of Array.isArray(payload.models) ? payload.models : []) {
        const id = idOf(entry)
        if (id === undefined) {
          malformed += 1
          continue
        }
        if (seen.has(id)) {
          duplicated += 1
          continue
        }
        seen.add(id)
        models.push(entry)
      }
      if (malformed > 0) warnings.push(`跳过 ${String(malformed)} 个缺少 id 的模型条目`)
      if (duplicated > 0) warnings.push(`跳过 ${String(duplicated)} 个重复 id 的模型条目`)
      return { models, warnings, modelsDev: readModelsDev(payload.modelsDev) }
    }

    /** Prefix the host's per-model warnings onto one status sentence. */
    function withWarnings(text, warnings) {
      return warnings.length > 0 ? `${text} 网关提示：${warnings.join("；")}` : text
    }

    /**
     * The status line for a fetch that produced nothing selectable.
     * @param warnings - the host's per-model mapping warnings.
     * @returns `{kind, text}` in the card's status shape.
     */
    function emptyImportStatus(warnings) {
      return { kind: "warn", text: withWarnings("网关没有返回可导入的模型。", warnings) }
    }

    /**
     * How many of the selected candidates both models.dev enriched and the merge
     * really turned into a draft entry. In `modelOverrides` mode a gateway-only id
     * is skipped rather than imported, so it is not reported as completed.
     * @param draft - the card's current draft.
     * @param selected - the selected candidates, in gateway order.
     * @param modelsDev - the normalized completion report, if any.
     * @returns the count appended to the import status line.
     */
    function mergedCompletionCount(draft, selected, modelsDev) {
      if (modelsDev === undefined || modelsDev.available !== true) return 0
      const enriched = new Set(modelsDev.enriched.map((entry) => entry.id))
      let count = 0
      for (const candidate of selected) {
        if (!enriched.has(candidate.id)) continue
        if (draft.mode !== "models" && !draft.entries.some((entry) => entry.id === candidate.id)) continue
        count += 1
      }
      return count
    }

    /**
     * The status line for one confirmed import.
     *
     * The success sentence is kept exactly as
     * `已导入 N 个模型（新增 X、覆盖 Y）` where N counts the selected candidates
     * that produced an entry (added + overwritten); the mode caveat, the
     * models.dev completion count and the host's warnings are appended after it.
     * A selection that produced no entry at all is reported with the warn class
     * instead of the ok class.
     * @param merged - `mergeSelectedEntries` result.
     * @param warnings - the host's per-model mapping warnings.
     * @param completionCount - how many imported models models.dev enriched.
     * @returns `{kind, text}` in the card's status shape.
     */
    function importOutcomeStatus(merged, warnings, completionCount = 0) {
      const imported = merged.added + merged.overwritten
      const parts = [
        `已导入 ${String(imported)} 个模型（新增 ${String(merged.added)}、覆盖 ${String(merged.overwritten)}）`,
      ]
      if (merged.skipped > 0) {
        parts.push(`跳过 ${String(merged.skipped)} 个新模型：当前是 modelOverrides 模式，不能新增模型条目。`)
      }
      if (completionCount > 0) parts.push(`models.dev 补全：${String(completionCount)} 个模型`)
      if (warnings.length > 0) parts.push(`网关提示：${warnings.join("；")}`)
      return { kind: imported > 0 ? "ok" : "warn", text: parts.join(" ") }
    }

    /* ------------------------------------------------------- validation/writes */

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
        // unset, or reverting a control to "inherit" would leave the old value;
        // `deleted` covers managed fields an import removed from `raw` itself.
        const fields = new Set([...Object.keys(entry.raw), ...Object.keys(next), ...(entry.deleted ?? [])])
        fields.delete("id")
        for (const field of fields) {
          if (hasOwn(next, field)) {
            ops.push({ op: "set", path: [...settingsPath, "modelOverrides", id, field], value: next[field] })
          } else {
            ops.push({ op: "unset", path: [...settingsPath, "modelOverrides", id, field] })
          }
        }
      }
      return ops
    }

    /* --------------------------------------------------------------- utilities */

    /** Subscribe to one configuration form and return its current snapshot. */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])
      return snapshot
    }

    /** No-op for the disabled parts of a checkbox group that must stay checked. */
    function noop() {}

    /** Thousands-separate a positive count, or `undefined` when there is nothing to show. */
    function formatCount(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
      return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    }

    /**
     * The imported-capacities line of one expanded model row, e.g.
     * `上下文 1,000,000 · 最大输出 128,000`; empty when the entry discloses neither.
     */
    function metaText(entry) {
      const raw = isPlainObject(entry.raw) ? entry.raw : {}
      const parts = []
      const contextWindow = formatCount(raw.contextWindow)
      if (contextWindow !== undefined) parts.push(`上下文 ${contextWindow}`)
      const maxTokens = formatCount(raw.maxTokens)
      if (maxTokens !== undefined) parts.push(`最大输出 ${maxTokens}`)
      return parts.join(" · ")
    }

    /* --------------------------------------------------- import dialog width */

    /**
     * Code-point ranges that take two display units: CJK, Hangul, the full-width
     * forms and their compatibility blocks. Everything else counts as one.
     */
    const WIDE_CHARACTER =
      /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u

    /**
     * Layout constants of the width estimate: the mono id line advances ~7.3px
     * per display unit, the UI name line ~7.0px, and the fixed row chrome —
     * checkbox, gaps, badges, body padding and scrollbar — needs ~164px.
     */
    const DIALOG_MONO_CHAR_WIDTH = 7.3
    const DIALOG_UI_CHAR_WIDTH = 7
    const DIALOG_CHROME_WIDTH = 164
    const DIALOG_MIN_WIDTH = 380
    const DIALOG_MAX_WIDTH = 920

    /** Approximate the rendered width of one string in pixels at the given per-unit width. */
    function textPixelWidth(text, unitWidth) {
      let units = 0
      for (const character of text) units += WIDE_CHARACTER.test(character) ? 2 : 1
      return units * unitWidth
    }

    /**
     * Estimate the width the import dialog needs to show every candidate in full.
     *
     * The dialog is where long gateway model ids and names used to be clipped, so
     * its width follows the widest id or name in the WHOLE listing rather than
     * the currently filtered one — typing in the search box must not resize the
     * dialog. The estimate is rounded up to the next 10px and clamped to
     * [380px, 920px]; the stylesheet additionally caps it by the viewport.
     * @param candidates - every candidate the dialog can list.
     * @returns the estimated dialog width in pixels.
     */
    function estimateImportDialogWidth(candidates) {
      let widest = 0
      for (const candidate of candidates) {
        const id = typeof candidate?.id === "string" ? candidate.id : ""
        const name = typeof candidate?.name === "string" && candidate.name.length > 0 ? candidate.name : ""
        widest = Math.max(
          widest,
          textPixelWidth(id, DIALOG_MONO_CHAR_WIDTH),
          textPixelWidth(name, DIALOG_UI_CHAR_WIDTH),
        )
      }
      const rounded = Math.ceil((widest + DIALOG_CHROME_WIDTH) / 10) * 10
      return Math.min(DIALOG_MAX_WIDTH, Math.max(DIALOG_MIN_WIDTH, rounded))
    }

    /** The class list of one status line in the card's status shape. */
    function statusClass(status) {
      const kind = status.kind === "ok" ? "dsh-mtune-ok" : status.kind === "fail" ? "dsh-mtune-fail" : "dsh-mtune-warn"
      return `dsh-mtune-status ${kind}`
    }

    /**
     * The wire spelling to keep when a level row's level is changed: keep a
     * spelled-out value that was not merely the level's own name, and reset
     * `off`/from `off` to the new level's default (empty for `off`).
     */
    function wireForLevelChange(from, wire, to) {
      const keep = wire.length > 0 && wire !== from && from !== OPTIONAL_WIRE_LEVEL && to !== OPTIONAL_WIRE_LEVEL
      if (keep) return wire
      return to === OPTIONAL_WIRE_LEVEL ? "" : to
    }

    /* ---------------------------------------------------------------- stylesheet */

    /**
     * The card stylesheet. Tokens and values are copied from the shipped
     * Settings → Models page stylesheet (`ModelsSection.module.css`) and the web
     * frontend's primitives (switch, checkbox, dialog shell), keeping the
     * `dsh-mtune-` prefix so a deployment can attribute every rule to this card.
     */
    const CSS = `
.dsh-mtune { display: flex; flex-direction: column; gap: 10px; max-width: 720px; color: var(--dsw-alias-label-primary); }
.dsh-mtune-head { display: flex; align-items: flex-start; gap: 12px; }
.dsh-mtune-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-mtune-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 22px; }
.dsh-mtune-toggle { flex: none; margin-left: auto; }
.dsh-mtune-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-mtune-visually-hidden { position: absolute; overflow: hidden; width: 1px; height: 1px; white-space: nowrap; clip: rect(0 0 0 0); }
.dsh-mtune-panel { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); }
.dsh-mtune-section { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding-top: 12px; border-top: .5px solid var(--dsw-alias-border-l2); }
.dsh-mtune-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dsh-mtune-section-title { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.dsh-mtune-fieldset { display: flex; flex-direction: column; gap: 6px; min-width: 0; margin: 0; padding: 0; border: none; }
.dsh-mtune-fieldset > legend { margin: 0 0 4px; padding: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.dsh-mtune-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-mtune-label { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.dsh-mtune-checks { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; min-height: 32px; }
.dsh-mtune-checkbox { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 20px; cursor: pointer; }
.dsh-mtune-checkbox input { flex: 0 0 auto; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.dsh-mtune-checkbox input:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-mtune-checkbox:has(input:disabled) { cursor: default; opacity: .5; }
.dsh-mtune-model-list { display: flex; flex-direction: column; gap: 8px; }
.dsh-mtune-model { display: flex; flex-direction: column; gap: 6px; padding: 6px; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg); }
.dsh-mtune-model-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-mtune-model-identity { display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; }
.dsh-mtune-model-name { overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 22px; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mtune-model-id { overflow: hidden; color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mtune-model-actions { display: inline-flex; flex: none; align-items: center; gap: 2px; margin-left: auto; }
.dsh-mtune-model-body { display: flex; flex-direction: column; gap: 10px; padding: 4px 6px 2px; }
.dsh-mtune-model-meta { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-mtune-empty { margin: 0; padding: 12px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; text-align: center; }
.dsh-mtune-input { box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; }
.dsh-mtune-input:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
.dsh-mtune-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-mtune-input:disabled { opacity: .6; cursor: default; }
select.dsh-mtune-input { max-width: 240px; cursor: pointer; }
.dsh-mtune-select { appearance: none; padding-right: 32px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-position: right 12px center; background-repeat: no-repeat; background-size: 12px 12px; }
.dsh-mtune-add-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-mtune-add-row .dsh-mtune-input { flex: 1 1 200px; max-width: 320px; }
.dsh-mtune-levels { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-mtune-level-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 28px; align-items: center; gap: 6px; }
.dsh-mtune-level { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.dsh-mtune-level .dsh-mtune-select { max-width: none; }
.dsh-mtune-wire { font-family: var(--ds-font-family-code); font-size: 13px; }
.dsh-mtune-model-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-mtune-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; }
.dsh-mtune-button:disabled { opacity: .4; cursor: default; }
.dsh-mtune-button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dsh-mtune-button-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-mtune-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-mtune-button-secondary { border: .5px solid var(--dsw-alias-border-l3); background: transparent; }
.dsh-mtune-button-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.dsh-mtune-button-ghost { color: var(--dsw-alias-label-primary); }
.dsh-mtune-button-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-mtune-button-sm { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 18px; }
.dsh-mtune-add-button { box-sizing: border-box; display: inline-flex; flex: none; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.dsh-mtune-add-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-mtune-add-button:disabled { opacity: .4; cursor: default; }
.dsh-mtune-add-button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dsh-mtune-icon-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dsh-mtune-icon-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-mtune-icon-button:disabled { opacity: .4; cursor: default; }
.dsh-mtune-icon-button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dsh-mtune-icon-button-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.dsh-mtune-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.dsh-mtune-editor-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.dsh-mtune-editor-actions .dsh-mtune-status { flex: 1 1 auto; min-width: 0; }
.dsh-mtune-status { font-size: 12px; line-height: 18px; }
.dsh-mtune-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-mtune-fail { color: var(--dsw-alias-state-error-primary); }
.dsh-mtune-warn { color: var(--dsw-alias-state-warn-label); }
.dsh-mtune-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; }
.dsh-mtune-switch[aria-checked=true] { background: var(--dsw-alias-brand-primary); }
.dsh-mtune-switch:disabled { opacity: .5; cursor: default; }
.dsh-mtune-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-mtune-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform .12s ease; }
.dsh-mtune-switch[aria-checked=false] .dsh-mtune-switch-thumb { background: var(--dsw-alias-switch-thumb); }
.dsh-mtune-switch[aria-checked=true] .dsh-mtune-switch-thumb { transform: translate(16px); }
.dsh-mtune-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px; }
.dsh-mtune-modal-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); animation: dsh-mtune-modal-enter var(--ds-transition-duration) var(--ds-ease-in-out); }
.dsh-mtune-modal-dialog { position: relative; z-index: 1; box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; width: min(var(--dsh-mtune-dialog-width, 380px), calc(100vw - 48px)); max-width: 920px; max-height: 100%; padding: 0 0 24px; overflow: hidden; border: 0; border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); animation: dsh-mtune-modal-enter var(--ds-transition-duration) var(--ds-ease-in-out); }
.dsh-mtune-modal-dialog:focus { outline: none; }
.dsh-mtune-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }
.dsh-mtune-modal-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 16px; font-weight: 500; line-height: 24px; }
.dsh-mtune-modal-close { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-mtune-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-mtune-modal-close:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dsh-mtune-modal-description { margin: 0; padding: 0 24px; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 400; line-height: 22px; }
.dsh-mtune-modal-body { display: flex; flex-direction: column; min-width: 0; margin-top: 20px; padding: 0 24px; }
.dsh-mtune-modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.dsh-mtune-candidate-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dsh-mtune-candidate-search { flex: 240px; min-width: 0; }
.dsh-mtune-candidates { display: flex; flex-direction: column; gap: 2px; max-height: 320px; margin: 0; padding: 0; overflow-y: auto; list-style: none; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.dsh-mtune-candidate { border-radius: var(--dsw-radius-md); }
.dsh-mtune-candidate-label { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; cursor: pointer; }
.dsh-mtune-candidate-label input[type=checkbox] { flex: 0 0 auto; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); cursor: inherit; }
.dsh-mtune-candidate-label input[type=checkbox]:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-mtune-candidate-text { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-mtune-candidate-id { min-width: 0; overflow-wrap: anywhere; font-family: var(--ds-font-family-code); font-size: 13px; line-height: 18px; white-space: normal; }
.dsh-mtune-candidate-name { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; white-space: normal; }
.dsh-mtune-badge { flex: none; padding: 1px 6px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xs); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.dsh-mtune-badge-new { color: var(--dsw-alias-state-success-primary); }
.dsh-mtune-badge-overwrite { color: var(--dsw-alias-state-warn-label); }
.dsh-mtune-badge-complete { color: var(--dsw-alias-state-business-primary); }
.dsh-mtune-completion-hint { margin: 0 0 6px; }
.dsh-mtune-candidate-empty { margin: 24px 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; text-align: center; }
@keyframes dsh-mtune-modal-enter { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .dsh-mtune-modal-mask, .dsh-mtune-modal-dialog, .dsh-mtune-switch-thumb { animation: none; transition: none; }
}
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

    /* -------------------------------------------------------------------- icons */

    /** A tiny inline stroke icon; the shipped page uses the same 16-box geometry. */
    function icon(paths, size) {
      const dimension = size ?? 14
      return React.createElement(
        "svg",
        {
          width: dimension,
          height: dimension,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        paths.map((path) => React.createElement("path", { key: path, d: path })),
      )
    }

    const CHEVRON_RIGHT = ["M6 3.5L10.5 8L6 12.5"]
    const CHEVRON_DOWN = ["M3.5 6L8 10.5L12.5 6"]
    const TRASH = ["M2.5 4.5H13.5", "M5.5 4.5V3.5C5.5 3.1 5.8 3 6 3H10C10.2 3 10.5 3.1 10.5 3.5V4.5", "M4.5 4.5L5 13H11L11.5 4.5", "M6.5 7V10.5", "M9.5 7V10.5"]
    const CLOSE = ["M4 4L12 12", "M12 4L4 12"]
    const PLUS = ["M8 3.5V12.5", "M3.5 8H12.5"]

    /* --------------------------------------------------------------- components */

    /** One checkbox with the shipped page's checkbox styling. */
    function Checkbox(props) {
      return React.createElement(
        "label",
        { className: "dsh-mtune-checkbox" },
        React.createElement("input", {
          type: "checkbox",
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: () => (props.onChange ?? noop)(!props.checked),
        }),
        props.label,
      )
    }

    /** The provider-level default-input fallback, editing `defaultInput`. */
    function DefaultInputField(props) {
      const { value, disabled, onToggle } = props
      const selected = Array.isArray(value) ? value : []
      return React.createElement(
        "fieldset",
        { className: "dsh-mtune-fieldset", "aria-label": "默认输入类型" },
        React.createElement("legend", { className: "dsh-mtune-label" }, "默认输入类型"),
        React.createElement(
          "div",
          { className: "dsh-mtune-checks" },
          React.createElement(Checkbox, { label: MODALITY_LABEL.text, checked: true, disabled: true, onChange: noop }),
          React.createElement(Checkbox, {
            label: MODALITY_LABEL.image,
            checked: selected.includes("image"),
            disabled,
            onChange: () => onToggle("image"),
          }),
        ),
        React.createElement("p", { className: "dsh-mtune-hint" }, "仅对未声明输入类型的模型生效。"),
      )
    }

    /**
     * One model's input types. `input` REPLACES the modality list rather than
     * extending it, so text is held on as the floor: declaring images alone would
     * quietly drop text and leave a model the harness can no longer talk to.
     * With no optional modality left the entry declares nothing and returns to
     * the installed catalog's own answer.
     */
    function ModelInputTypes(props) {
      const { entry, disabled, onChange } = props
      const selected = Array.isArray(entry.input) ? entry.input : []
      const toggleImage = () => {
        const current = Array.isArray(entry.input) ? entry.input : []
        const next = current.includes("image") ? current.filter((modality) => modality !== "image") : [...current, "image"]
        const optional = next.filter((modality) => modality !== "text")
        onChange({ ...entry, input: optional.length === 0 ? undefined : ["text", ...optional] })
      }
      return React.createElement(
        "fieldset",
        { className: "dsh-mtune-fieldset", "aria-label": "输入类型" },
        React.createElement("legend", { className: "dsh-mtune-label" }, "输入类型"),
        React.createElement(
          "div",
          { className: "dsh-mtune-checks" },
          React.createElement(Checkbox, { label: MODALITY_LABEL.text, checked: true, disabled: true, onChange: noop }),
          React.createElement(Checkbox, { label: MODALITY_LABEL.image, checked: selected.includes("image"), disabled, onChange: toggleImage }),
        ),
      )
    }

    /**
     * One model's reasoning capability: a three-way select (inherit / off /
     * custom levels) and, for custom, one row per declared level pairing the
     * level with the API value sent for it.
     */
    function EffortEditor(props) {
      const { entry, disabled, onChange } = props
      const effort = entry.effort
      const used = new Set(effort.levels.map((level) => level.level))
      const update = (nextEffort) => onChange({ ...entry, effort: nextEffort })
      const setKind = (kind) => {
        if (kind === effort.kind) return
        // Turning custom on with nothing declared seeds one valid level so the
        // editor is never an empty group and the draft is immediately saveable.
        if (kind === "custom" && effort.levels.length === 0) {
          update({ ...effort, kind, levels: [{ level: INITIAL_CUSTOM_LEVEL, wire: INITIAL_CUSTOM_LEVEL }] })
          return
        }
        update({ ...effort, kind })
      }
      const addLevel = () => {
        const level = LEVELS.find((candidate) => !used.has(candidate))
        if (level === undefined) return
        update({ ...effort, kind: "custom", levels: [...effort.levels, { level, wire: level === OPTIONAL_WIRE_LEVEL ? "" : level }] })
      }
      const removeLevel = (level) => {
        update({ ...effort, kind: "custom", levels: effort.levels.filter((candidate) => candidate.level !== level) })
      }
      const changeLevel = (from, to) => {
        update({
          ...effort,
          kind: "custom",
          levels: effort.levels.map((candidate) =>
            candidate.level === from ? { level: to, wire: wireForLevelChange(from, candidate.wire, to) } : candidate,
          ),
        })
      }
      const setWire = (level, wire) => {
        update({
          ...effort,
          kind: "custom",
          levels: effort.levels.map((candidate) => (candidate.level === level ? { ...candidate, wire } : candidate)),
        })
      }
      return React.createElement(
        "div",
        { className: "dsh-mtune-field" },
        React.createElement(
          "label",
          { className: "dsh-mtune-field" },
          React.createElement("span", { className: "dsh-mtune-label" }, "推理能力"),
          React.createElement(
            "select",
            {
              className: "dsh-mtune-input dsh-mtune-select",
              value: effort.kind,
              disabled,
              "aria-label": "推理能力",
              onChange: (event) => setKind(event.target.value),
            },
            React.createElement("option", { value: "inherit" }, "继承目录"),
            React.createElement("option", { value: "none" }, "关闭推理"),
            React.createElement("option", { value: "custom" }, "自定义档位"),
          ),
        ),
        effort.kind === "custom"
          ? React.createElement(
              "div",
              { className: "dsh-mtune-levels" },
              React.createElement(
                "div",
                { className: "dsh-mtune-level-head", "aria-hidden": "true" },
                React.createElement("span", { className: "dsh-mtune-model-label" }, "档位"),
                React.createElement("span", { className: "dsh-mtune-model-label" }, "API 参数值"),
                React.createElement("span", null),
              ),
              effort.levels.map((level, index) =>
                React.createElement(
                  "div",
                  { className: "dsh-mtune-level", key: level.level },
                  React.createElement(
                    "select",
                    {
                      className: "dsh-mtune-input dsh-mtune-select",
                      value: level.level,
                      disabled,
                      "aria-label": `档位 ${String(index + 1)}`,
                      onChange: (event) => changeLevel(level.level, event.target.value),
                    },
                    LEVELS.map((candidate) =>
                      React.createElement(
                        "option",
                        { key: candidate, value: candidate, disabled: candidate !== level.level && used.has(candidate) },
                        LEVEL_LABEL[candidate],
                      ),
                    ),
                  ),
                  React.createElement("input", {
                    className: "dsh-mtune-input dsh-mtune-wire",
                    type: "text",
                    value: level.wire,
                    placeholder: level.level === OPTIONAL_WIRE_LEVEL ? "关闭思考" : "API 参数值",
                    disabled,
                    "aria-label": `API 参数值 ${String(index + 1)}`,
                    onChange: (event) => setWire(level.level, event.target.value),
                  }),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dsh-mtune-icon-button dsh-mtune-icon-button-danger",
                      "aria-label": "删除档位",
                      title: "删除档位",
                      disabled,
                      onClick: () => removeLevel(level.level),
                    },
                    icon(TRASH),
                    React.createElement("span", { className: "dsh-mtune-visually-hidden" }, "删除档位"),
                  ),
                ),
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-mtune-add-button",
                  disabled: disabled || used.size >= LEVELS.length,
                  onClick: addLevel,
                },
                icon(PLUS),
                "添加档位",
              ),
              React.createElement(
                "p",
                { className: "dsh-mtune-hint" },
                "API 参数值会写入请求的推理强度字段；Off 表示关闭思考，不需要填写参数值。",
              ),
            )
          : null,
      )
    }

    /** One model entry: identity row, then its expanded tuning controls. */
    function ModelRow(props) {
      const { entry, position, expanded, disabled, onToggle, onRemove, onChange } = props
      const meta = metaText(entry)
      return React.createElement(
        "div",
        { className: "dsh-mtune-model" },
        React.createElement(
          "div",
          { className: "dsh-mtune-model-head" },
          React.createElement(
            "div",
            { className: "dsh-mtune-model-identity" },
            React.createElement("span", { className: "dsh-mtune-model-name" }, entry.label || entry.id || "(未命名)"),
            React.createElement("span", { className: "dsh-mtune-model-id" }, entry.id),
          ),
          React.createElement(
            "div",
            { className: "dsh-mtune-model-actions" },
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-mtune-icon-button",
                "aria-label": "模型选项",
                title: "模型选项",
                "aria-expanded": expanded === true,
                disabled,
                onClick: onToggle,
              },
              icon(expanded ? CHEVRON_DOWN : CHEVRON_RIGHT),
              React.createElement("span", { className: "dsh-mtune-visually-hidden" }, "模型选项"),
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-mtune-icon-button dsh-mtune-icon-button-danger",
                "aria-label": "移除模型",
                title: "移除模型",
                disabled,
                onClick: onRemove,
              },
              icon(TRASH),
              React.createElement("span", { className: "dsh-mtune-visually-hidden" }, "移除模型"),
            ),
          ),
        ),
        expanded
          ? React.createElement(
              "div",
              { className: "dsh-mtune-model-body" },
              meta.length > 0 ? React.createElement("p", { className: "dsh-mtune-model-meta" }, meta) : null,
              React.createElement(ModelInputTypes, { entry, disabled, onChange }),
              React.createElement(EffortEditor, { entry, disabled, onChange }),
            )
          : null,
      )
    }

    /**
     * The model-selection dialog: every candidate starts checked, search filters
     * the list, the flat toggle applies to the visible candidates, and only the
     * checked candidates are merged when `添加所选` is confirmed. Escape and the
     * mask both close it without importing anything.
     *
     * The dialog's width follows the widest candidate in the WHOLE listing (never
     * the filtered one, so searching cannot resize the dialog) and is handed to
     * the stylesheet as the `--dsh-mtune-dialog-width` custom property. When the
     * Host reports models.dev completion, one hint line explains it and every
     * enriched candidate carries a `补全` badge naming the fields it filled.
     */
    function ImportDialog(props) {
      const { candidates, picked, query, existingIds, modelsDev, onToggle, onToggleVisible, onQuery, onClose, onConfirm } = props
      const normalized = query.trim().toLowerCase()
      const visible =
        normalized.length === 0
          ? candidates
          : candidates.filter((candidate) => {
              if (candidate.id.toLowerCase().includes(normalized)) return true
              return typeof candidate.name === "string" && candidate.name.toLowerCase().includes(normalized)
            })
      const allVisiblePicked = visible.length > 0 && visible.every((candidate) => picked.has(candidate.id))
      const width = estimateImportDialogWidth(candidates)
      const enrichedById = new Map()
      if (modelsDev !== undefined && modelsDev.available === true) {
        for (const entry of modelsDev.enriched) enrichedById.set(entry.id, entry)
      }
      const hint = modelsDevHint(modelsDev)
      return React.createElement(
        "div",
        {
          className: "dsh-mtune-modal",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "选择要添加的模型",
          onKeyDown: (event) => {
            if (event.key === "Escape") onClose()
          },
        },
        React.createElement("div", { className: "dsh-mtune-modal-mask", "aria-hidden": "true", onClick: onClose }),
        React.createElement(
          "div",
          {
            className: "dsh-mtune-modal-dialog",
            style: { "--dsh-mtune-dialog-width": `${String(width)}px` },
            "data-mtune-dialog-width": String(width),
          },
          React.createElement(
            "div",
            { className: "dsh-mtune-modal-header" },
            React.createElement("h2", { className: "dsh-mtune-modal-title" }, "选择要添加的模型"),
            React.createElement(
              "button",
              { type: "button", className: "dsh-mtune-modal-close", "aria-label": "关闭", title: "关闭", onClick: onClose },
              icon(CLOSE, 16),
              React.createElement("span", { className: "dsh-mtune-visually-hidden" }, "关闭"),
            ),
          ),
          React.createElement(
            "p",
            { className: "dsh-mtune-modal-description" },
            "以下是该提供商当前可用的模型。已存在的模型被选中时会覆盖其当前设置。",
          ),
          React.createElement(
            "div",
            { className: "dsh-mtune-modal-body" },
            hint === null
              ? null
              : React.createElement(
                  "p",
                  {
                    className:
                      modelsDev?.available === false
                        ? "dsh-mtune-hint dsh-mtune-warn dsh-mtune-completion-hint"
                        : "dsh-mtune-hint dsh-mtune-completion-hint",
                    role: "status",
                  },
                  hint,
                ),
            React.createElement(
              "div",
              { className: "dsh-mtune-candidate-toolbar" },
              React.createElement("input", {
                className: "dsh-mtune-input dsh-mtune-candidate-search",
                type: "search",
                value: query,
                placeholder: "搜索模型",
                "aria-label": "搜索模型",
                autoFocus: true,
                onChange: (event) => onQuery(event.target.value),
              }),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dsh-mtune-button dsh-mtune-button-ghost dsh-mtune-button-sm",
                  disabled: visible.length === 0,
                  onClick: () => onToggleVisible(visible),
                },
                allVisiblePicked ? "取消全选" : "全选",
              ),
            ),
            visible.length === 0
              ? React.createElement("p", { className: "dsh-mtune-candidate-empty", role: "status" }, "没有匹配的模型。")
              : React.createElement(
                  "ul",
                  { className: "dsh-mtune-candidates" },
                  visible.map((candidate) => {
                    const recognized = existingIds.has(candidate.id)
                    const enriched = enrichedById.get(candidate.id)
                    const name =
                      typeof candidate.name === "string" && candidate.name.length > 0 && candidate.name !== candidate.id
                        ? candidate.name
                        : undefined
                    // The row's title carries the identity in full, so a wrapped or
                    // hard-to-scan label is always readable on hover.
                    const identity = name === undefined ? candidate.id : `${candidate.id} · ${name}`
                    return React.createElement(
                      "li",
                      { className: "dsh-mtune-candidate", key: candidate.id, title: identity },
                      React.createElement(
                        "label",
                        { className: "dsh-mtune-candidate-label" },
                        React.createElement("input", {
                          type: "checkbox",
                          "data-mtune-candidate": candidate.id,
                          checked: picked.has(candidate.id),
                          onChange: () => onToggle(candidate.id),
                        }),
                        // A text column: the id, then the display name on its own
                        // line when it differs, so a long name wraps under the id
                        // instead of being clipped by the row.
                        React.createElement(
                          "span",
                          { className: "dsh-mtune-candidate-text" },
                          React.createElement("span", { className: "dsh-mtune-candidate-id", title: identity }, candidate.id),
                          name === undefined
                            ? null
                            : React.createElement("span", { className: "dsh-mtune-candidate-name", title: identity }, name),
                        ),
                        React.createElement(
                          "span",
                          {
                            className: recognized
                              ? "dsh-mtune-badge dsh-mtune-badge-overwrite"
                              : "dsh-mtune-badge dsh-mtune-badge-new",
                          },
                          recognized ? "覆盖" : "新增",
                        ),
                        enriched === undefined
                          ? null
                          : React.createElement(
                              "span",
                              {
                                className: "dsh-mtune-badge dsh-mtune-badge-complete",
                                title: `models.dev 已补全：${modelsDevFieldsText(enriched.fields)}`,
                              },
                              "补全",
                            ),
                      ),
                    )
                  }),
                ),
          ),
          React.createElement(
            "div",
            { className: "dsh-mtune-modal-footer" },
            React.createElement(
              "button",
              { type: "button", className: "dsh-mtune-button dsh-mtune-button-secondary", onClick: onClose },
              "取消",
            ),
            React.createElement(
              "button",
              { type: "button", className: "dsh-mtune-button dsh-mtune-button-primary", disabled: picked.size === 0, onClick: onConfirm },
              "添加所选",
            ),
          ),
        ),
      )
    }

    /**
     * The card itself: one provider row's per-model tuning surface.
     * @param props - the resolved route, its configuration form, and owner facts.
     * @returns the card, or `null` when this route is not a pi-ai profile.
     */
    function ModelTuningCard(props) {
      const { form, provider } = props
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
      // Importing is a draft edit, never a settings write: it has its own busy
      // flag and status line so it cannot be mistaken for a save. The candidate
      // list is `undefined` while the selection dialog is closed.
      const [importing, setImporting] = React.useState(false)
      const [importStatus, setImportStatus] = React.useState(undefined)
      const [candidates, setCandidates] = React.useState(undefined)
      const [pickerWarnings, setPickerWarnings] = React.useState([])
      // The Host's optional models.dev report for the current candidate list;
      // `undefined` on an older Host, which is also what keeps the dialog and the
      // status line exactly as they were.
      const [pickerModelsDev, setPickerModelsDev] = React.useState(undefined)
      const [picked, setPicked] = React.useState(() => new Set())
      const [candidateQuery, setCandidateQuery] = React.useState("")
      const [expandedRows, setExpandedRows] = React.useState(() => new Set())

      // Re-seed the draft whenever the stored section moves: an accepted write,
      // another tab, or a hand edit of settings.yaml. A pending selection belongs
      // to the draft that was current when it opened, so it closes too.
      React.useEffect(() => {
        setDraft({ mode: source.mode, entries: source.entries, defaultInput: sourceDefault, removed: [] })
        setNewId("")
        setStatus(undefined)
        setImportStatus(undefined)
        setCandidates(undefined)
        setPickerWarnings([])
        setPickerModelsDev(undefined)
        setPicked(new Set())
        setCandidateQuery("")
      }, [signature])

      // Escape closes the selection dialog. The dialog root also handles it for
      // synthetic events; the document listener covers the case where focus is
      // still on the button that opened the dialog.
      React.useEffect(() => {
        if (candidates === undefined) return undefined
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined
        const onKeyDown = (event) => {
          if (event.key !== "Escape") return
          setCandidates(undefined)
          setPickerWarnings([])
          setPickerModelsDev(undefined)
          setPicked(new Set())
          setCandidateQuery("")
        }
        document.addEventListener("keydown", onKeyDown)
        return () => {
          if (typeof document.removeEventListener === "function") document.removeEventListener("keydown", onKeyDown)
        }
      }, [candidates])

      if (settingsPath.length === 0 || provider?.settingsNs !== NS) return null

      const disabled = busy || importing || !snapshot.writable
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
        const removedId = draft.entries[index]?.id
        setDraft((current) => {
          const entry = current.entries[index]
          const removed =
            current.mode === "overrides" && current.removed.includes(entry.id) === false && source.entries.some((candidate) => candidate.id === entry.id)
              ? [...current.removed, entry.id]
              : current.removed
          return { ...current, entries: current.entries.filter((_, i) => i !== index), removed }
        })
        if (removedId !== undefined) {
          setExpandedRows((current) => {
            const next = new Set(current)
            next.delete(removedId)
            return next
          })
        }
        setStatus(undefined)
      }
      const addEntry = () => {
        const id = newId.trim()
        if (id.length === 0) return
        setDraft((current) => {
          if (current.entries.some((entry) => entry.id === id)) return current
          return {
            ...current,
            entries: [...current.entries, { id, label: id, input: undefined, effort: { kind: "inherit", levels: [], unknown: {} }, raw: {}, deleted: [] }],
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
      const toggleRow = (id) => {
        setExpandedRows((current) => {
          const next = new Set(current)
          if (!next.delete(id)) next.add(id)
          return next
        })
      }
      const closePicker = () => {
        setCandidates(undefined)
        setPickerWarnings([])
        setPickerModelsDev(undefined)
        setPicked(new Set())
        setCandidateQuery("")
      }

      /**
       * Ask the host for this provider's gateway listing.
       *
       * Nothing is written here and nothing is merged yet: a usable answer only
       * opens the selection dialog, whose confirmation is what edits the draft.
       * The busy flag disables the whole card while the host is fetching, keeping
       * the draft the merge will read stable.
       */
      const fetchCandidates = async () => {
        if (importing) return
        const providerId = typeof provider?.provider === "string" ? provider.provider : ""
        setImporting(true)
        setImportStatus(undefined)
        try {
          const answer = await requestGatewayModels(providerId)
          if (answer.models.length === 0) {
            setImportStatus(emptyImportStatus(answer.warnings))
            return
          }
          setCandidates(answer.models)
          setPickerWarnings(answer.warnings)
          setPickerModelsDev(answer.modelsDev)
          setPicked(new Set(answer.models.map((model) => idOf(model)).filter((id) => id !== undefined)))
          setCandidateQuery("")
        } catch (error) {
          setImportStatus({ kind: "fail", text: `导入失败：${error instanceof Error ? error.message : String(error)}` })
        } finally {
          setImporting(false)
        }
      }

      /** Merge the checked candidates into the draft only; 保存 is what writes. */
      const confirmImport = () => {
        if (candidates === undefined) return
        const selected = candidates.filter((candidate) => picked.has(candidate.id))
        const merged = mergeSelectedEntries(draft, selected)
        const completionCount = mergedCompletionCount(draft, selected, pickerModelsDev)
        setDraft((current) => ({ ...current, entries: merged.entries }))
        setImportStatus(importOutcomeStatus(merged, pickerWarnings, completionCount))
        closePicker()
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

      const header = React.createElement(
        "div",
        { className: "dsh-mtune-head" },
        React.createElement(
          "div",
          { className: "dsh-mtune-head-text" },
          React.createElement("span", { className: "dsh-mtune-title" }, "模型调优"),
          React.createElement("span", { className: "dsh-mtune-hint" }, "按模型配置推理等级与输入类型；可从网关获取模型列表。"),
        ),
        available
          ? React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-mtune-button dsh-mtune-button-secondary dsh-mtune-button-sm dsh-mtune-toggle",
                "aria-expanded": expanded,
                onClick: () => setExpanded((value) => !value),
              },
              expanded ? "收起" : "展开配置",
            )
          : null,
      )

      if (!available) {
        return React.createElement(
          "div",
          { className: "dsh-mtune" },
          header,
          React.createElement(
            "span",
            { className: "dsh-mtune-hint" },
            snapshot.writable === false && snapshot.status === "ready" ? "当前设置文档只读，无法修改。" : "正在读取设置…",
          ),
        )
      }

      const existingIds = new Set(draft.entries.map((entry) => entry.id))
      const importStatusNode =
        importStatus !== undefined
          ? React.createElement("span", { className: statusClass(importStatus), role: "status" }, importStatus.text)
          : null
      const saveStatusNode =
        status !== undefined
          ? React.createElement("span", { className: statusClass(status), role: "status" }, status.text)
          : dirty
            ? React.createElement("span", { className: "dsh-mtune-status dsh-mtune-warn" }, "有未保存的修改")
            : null

      return React.createElement(
        "div",
        { className: "dsh-mtune" },
        header,
        expanded
          ? React.createElement(
              "div",
              { className: "dsh-mtune-panel" },
              React.createElement(DefaultInputField, {
                value: draft.defaultInput,
                disabled,
                onToggle: toggleDefaultInput,
              }),
              React.createElement(
                "section",
                { className: "dsh-mtune-section dsh-mtune-group" },
                React.createElement("h3", { className: "dsh-mtune-section-title" }, "从网关导入"),
                React.createElement(
                  "p",
                  { className: "dsh-mtune-hint" },
                  "读取该供应商 /models 的 Magpie 扩展字段，选择要添加的模型；已存在的模型被选中时会覆盖其当前设置。",
                ),
                React.createElement(
                  "div",
                  { className: "dsh-mtune-actions" },
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dsh-mtune-button dsh-mtune-button-secondary dsh-mtune-button-sm",
                      disabled: disabled || importing,
                      onClick: fetchCandidates,
                    },
                    importing ? "正在询问提供商…" : "获取可用模型",
                  ),
                  importStatusNode,
                ),
              ),
              React.createElement(
                "section",
                { className: "dsh-mtune-section" },
                React.createElement(
                  "div",
                  { className: "dsh-mtune-section-head" },
                  React.createElement("h3", { className: "dsh-mtune-section-title" }, `模型（${String(draft.entries.length)}）`),
                ),
                draft.entries.length === 0
                  ? React.createElement(
                      "p",
                      { className: "dsh-mtune-empty" },
                      "该供应商没有显式模型条目，添加模型 ID 即可单独配置。",
                    )
                  : React.createElement(
                      "div",
                      { className: "dsh-mtune-model-list" },
                      draft.entries.map((entry, index) =>
                        React.createElement(ModelRow, {
                          key: `${entry.id}-${String(index)}`,
                          entry,
                          position: index + 1,
                          expanded: expandedRows.has(entry.id),
                          disabled,
                          onToggle: () => toggleRow(entry.id),
                          onRemove: () => removeEntry(index),
                          onChange: (next) => setEntry(index, next),
                        }),
                      ),
                    ),
                React.createElement(
                  "div",
                  { className: "dsh-mtune-add-row" },
                  React.createElement("input", {
                    className: "dsh-mtune-input",
                    type: "text",
                    value: newId,
                    disabled,
                    placeholder: "模型 ID",
                    "aria-label": "模型 ID",
                    onChange: (event) => setNewId(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        addEntry()
                      }
                    },
                  }),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "dsh-mtune-add-button",
                      disabled: disabled || newId.trim().length === 0,
                      onClick: addEntry,
                    },
                    icon(PLUS),
                    "添加模型",
                  ),
                ),
              ),
              React.createElement(
                "div",
                { className: "dsh-mtune-editor-actions" },
                saveStatusNode,
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsh-mtune-button dsh-mtune-button-secondary",
                    disabled: disabled || !dirty,
                    onClick: () => {
                      setDraft({ mode: source.mode, entries: source.entries, defaultInput: sourceDefault, removed: [] })
                      setStatus(undefined)
                      // The report belongs to the discarded draft.
                      setImportStatus(undefined)
                    },
                  },
                  "放弃修改",
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsh-mtune-button dsh-mtune-button-primary",
                    disabled: disabled || !dirty,
                    onClick: save,
                  },
                  busy ? "保存中…" : "保存",
                ),
              ),
            )
          : null,
        candidates !== undefined
          ? React.createElement(ImportDialog, {
              candidates,
              picked,
              query: candidateQuery,
              existingIds,
              modelsDev: pickerModelsDev,
              onToggle: (id) =>
                setPicked((current) => {
                  const next = new Set(current)
                  if (!next.delete(id)) next.add(id)
                  return next
                }),
              onToggleVisible: (visible) =>
                setPicked((current) => {
                  if (visible.every((candidate) => current.has(candidate.id))) return new Set()
                  const next = new Set(current)
                  for (const candidate of visible) next.add(candidate.id)
                  return next
                }),
              onQuery: (value) => setCandidateQuery(value),
              onClose: closePicker,
              onConfirm: confirmImport,
            })
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
