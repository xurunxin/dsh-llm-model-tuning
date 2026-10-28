/**
 * Magpie gateway model-listing mapping.
 *
 * A Magpie gateway answers `GET {baseURL}/models` with the ordinary OpenAI
 * listing envelope (`{ data: [...] }`), and every entry carries extension
 * fields pi-ai does not read: `display_name`, `context_window`,
 * `max_output_tokens`, `modalities.input`, `reasoning_levels`,
 * `supported_reasoning_levels`, and so on. This module is the one place that
 * turns those extensions into the storable `llm-pi-ai` model-entry shape
 * (`{ id, name, contextWindow, maxTokens, input, reasoningEfforts }`).
 *
 * WorkBuddy-style gateways disclose the same details with different
 * spellings — `attachments` / `supports_images`, `reasoning_supported_efforts`
 * (or its alias `supported_reasoning_efforts`), and the `only_reasoning` /
 * `supports_reasoning` flags. Those are accepted as lower-precedence sources,
 * so a gateway import still carries modalities and reasoning even when the
 * models.dev catalog is unreachable; the Magpie spellings always win when an
 * entry discloses both.
 *
 * It is deliberately pure: no Node builtins and no DSH service imports, so the
 * Host half, the offline test suites, and the live check all map the very same
 * bytes with the very same rules.
 *
 * Mapping rules (see `.team/contract.md`):
 * - an entry without a usable id is skipped with a warning rather than failing
 *   the whole listing;
 * - unset fields are omitted, never emitted as empty arrays or objects;
 * - names DSH/pi-ai does not know (`ultra` reasoning levels, `pdf`/`audio`
 *   modalities) are skipped and reported as a warning naming the model;
 * - `supports_attachments` is too generic to mean "takes images", so it is
 *   not used; `reasoning_default_effort` is a single default rather than a
 *   level list, so it is not mapped either.
 *
 * @module dsh-llm-model-tuning/magpie
 */

/** The reasoning levels the `llm-pi-ai` schema accepts, in schema order. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

const THINKING_LEVEL_SET = new Set(THINKING_LEVELS)

/** Wire names that all mean "the model can be told not to reason". */
const OFF_ALIASES = new Set(["off", "none"])

const TEXT_MODALITY = "text"
const IMAGE_MODALITY = "image"
const SUPPORTED_MODALITIES = new Set([TEXT_MODALITY, IMAGE_MODALITY])

/** Warning clauses are joined to a model id with this colon in every message. */
const WARNING_COLON = "："

/* ----------------------------------------------------------------- helpers -- */

/**
 * Whether a value is a plain data object (not null, array, or class instance).
 * @param value - candidate value.
 * @returns true for an object-shaped JSON value.
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * A trimmed, non-empty string, or `undefined`.
 * @param value - candidate value.
 * @returns the trimmed string when usable.
 */
function nonEmptyString(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * A positive safe integer, or `undefined`; capacities of `0`, negatives,
 * fractions, and numeric strings are unusable rather than coerced.
 * @param value - candidate value.
 * @returns the integer when usable.
 */
function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * The first usable capacity from a precedence list.
 * @param values - candidates in descending precedence.
 * @returns the first positive integer.
 */
function firstPositiveInteger(...values) {
  for (const value of values) {
    const capacity = positiveInteger(value)
    if (capacity !== undefined) return capacity
  }
  return undefined
}

/* ----------------------------------------------------------------- listing -- */

/**
 * Normalize a gateway listing response into the raw entries to map.
 *
 * Two envelopes are accepted, mirroring the shipped pi-ai discovery parser:
 * - `{ data: [...] }` — the standard OpenAI listing;
 * - `{ models: { ... } }` — an enriched map some gateways expose, where the
 *   property key is the request-facing model id. A map entry without its own
 *   usable `id` is mapped with the key as its id.
 *
 * A `data` array wins when both shapes are present.
 *
 * @param body - parsed JSON body of the gateway's listing response.
 * @returns the raw entries in listing order, plus parse-level warnings.
 * @throws Error when the body is neither envelope.
 */
export function parseModelListing(body) {
  if (!isRecord(body)) throw new Error("模型列表响应不是 JSON 对象")

  if (Array.isArray(body.data)) return { entries: body.data, warnings: [] }

  const models = body.models
  if (!isRecord(models)) {
    throw new Error('模型列表响应格式无法识别：缺少 "data" 数组或 "models" 对象')
  }

  const entries = []
  for (const [key, raw] of Object.entries(models)) {
    // Primitive properties of a models map are directory metadata, not models.
    if (!isRecord(raw)) continue
    entries.push(nonEmptyString(raw.id) === undefined ? { ...raw, id: key } : raw)
  }
  return { entries, warnings: [] }
}

/* ---------------------------------------------------------------- mapping -- */

/**
 * The modality list the entry discloses, in contract precedence order.
 * The Magpie spellings (`modalities.input` → `input_modalities` → `input`)
 * come first; a WorkBuddy-style `attachments` array is accepted next, and the
 * boolean `supports_images === true` hint is the last resort — it discloses
 * that images are accepted, i.e. the two-modality list. An empty list is still
 * a disclosure of "no usable modalities".
 * @param raw - one raw listing entry.
 * @returns the disclosed array (possibly empty), or undefined when absent.
 */
function disclosedModalities(raw) {
  if (isRecord(raw.modalities) && Array.isArray(raw.modalities.input)) return raw.modalities.input
  if (Array.isArray(raw.input_modalities)) return raw.input_modalities
  if (Array.isArray(raw.input)) return raw.input
  if (Array.isArray(raw.attachments)) return raw.attachments
  if (raw.supports_images === true) return [IMAGE_MODALITY]
  return undefined
}

/**
 * Map Magpie modalities onto the two pi-ai modalities. Text is the floor: a
 * gateway that discloses a modality list is asserting it takes requests at
 * all, and every protocol carries text. Unknown names warn and are dropped.
 * @param raw - one raw listing entry.
 * @param id - model id used to name warnings.
 * @returns the mapped input list (when disclosed), or undefined, plus warnings.
 */
function mapInput(raw, id) {
  const warnings = []
  const disclosed = disclosedModalities(raw)
  if (disclosed === undefined || disclosed.length === 0) return { value: undefined, warnings }

  const known = new Set()
  const unsupported = new Set()
  for (const candidate of disclosed) {
    const name = nonEmptyString(candidate)?.toLowerCase()
    if (name === undefined) continue
    if (SUPPORTED_MODALITIES.has(name)) known.add(name)
    else unsupported.add(name)
  }
  for (const name of unsupported) {
    warnings.push(`${id}${WARNING_COLON}跳过不支持的输入模态 ${name}`)
  }

  // Canonical order, text first; text is present whenever a list was disclosed.
  return { value: known.has(IMAGE_MODALITY) ? [TEXT_MODALITY, IMAGE_MODALITY] : [TEXT_MODALITY], warnings }
}

/**
 * The usable names of a plain-string level list, in listing order.
 * @param value - candidate level list.
 * @returns the non-empty trimmed names; empty for a non-list or blank entries.
 */
function plainLevelNames(value) {
  if (!Array.isArray(value)) return []
  const names = []
  for (const entry of value) {
    const name = nonEmptyString(entry)
    if (name !== undefined) names.push(name)
  }
  return names
}

/**
 * The reasoning level names the entry discloses, in contract precedence order:
 * `supported_reasoning_levels` (`{ effort }` objects or plain strings) first,
 * then the plain-string lists `reasoning_levels`, `reasoning_supported_efforts`
 * (the WorkBuddy spelling), and its alias `supported_reasoning_efforts`. An
 * empty disclosure falls through to the next source because a gateway can emit
 * both keys and fill only one.
 * @param raw - one raw listing entry.
 * @returns the disclosed level names, or undefined when none are disclosed.
 */
function disclosedReasoningLevels(raw) {
  const supported = raw.supported_reasoning_levels
  if (Array.isArray(supported)) {
    const names = []
    for (const entry of supported) {
      if (typeof entry === "string") {
        const name = nonEmptyString(entry)
        if (name !== undefined) names.push(name)
      } else if (isRecord(entry)) {
        const name = nonEmptyString(entry.effort)
        if (name !== undefined) names.push(name)
      }
    }
    if (names.length > 0) return names
  }

  for (const candidate of [
    raw.reasoning_levels,
    raw.reasoning_supported_efforts,
    raw.supported_reasoning_efforts,
  ]) {
    const names = plainLevelNames(candidate)
    if (names.length > 0) return names
  }

  return undefined
}

/**
 * Whether the entry declares reasoning support under any accepted spelling:
 * Magpie's `reasoning: true`, or the WorkBuddy-style `only_reasoning: true` /
 * `supports_reasoning: true` flags.
 * @param raw - one raw listing entry.
 * @returns true when the entry says the model reasons.
 */
function declaresReasoning(raw) {
  return raw.reasoning === true || raw.only_reasoning === true || raw.supports_reasoning === true
}

/**
 * Map the gateway's reasoning extensions onto `reasoningEfforts`.
 *
 * `reasoning: false` is authoritative and becomes `false`. Otherwise every
 * disclosed level is normalized to a `THINKING_LEVELS` key; `off`/`none` map to
 * key `off` with wire spelling `null`, every other level keeps its disclosed
 * spelling as the wire value. Unknown levels (`ultra`) are skipped with a
 * warning. A reasoning declaration (`reasoning: true`, or a WorkBuddy-style
 * `only_reasoning`/`supports_reasoning` `true`) with nothing usable warns and
 * omits the field; an explicit `supports_reasoning: false` with no declared
 * flag and no levels becomes `false`; no flag and no levels means unknown,
 * which omits silently.
 * @param raw - one raw listing entry.
 * @param id - model id used to name warnings.
 * @returns the mapped reasoningEfforts (object or `false`), or undefined, plus warnings.
 */
function mapReasoning(raw, id) {
  const warnings = []
  if (raw.reasoning === false) return { value: false, warnings }

  const disclosed = disclosedReasoningLevels(raw)
  if (disclosed === undefined) {
    if (declaresReasoning(raw)) {
      warnings.push(`${id}${WARNING_COLON}网关声明支持推理，但未提供推理档位`)
    } else if (raw.reasoning === undefined && raw.supports_reasoning === false) {
      return { value: false, warnings }
    }
    return { value: undefined, warnings }
  }

  const efforts = {}
  const unsupported = new Set()
  for (const candidate of disclosed) {
    const name = candidate.trim().toLowerCase()
    const key = OFF_ALIASES.has(name) ? "off" : name
    if (!THINKING_LEVEL_SET.has(key)) {
      unsupported.add(name)
      continue
    }
    if (!Object.hasOwn(efforts, key)) efforts[key] = key === "off" ? null : key
  }
  for (const name of unsupported) {
    warnings.push(`${id}${WARNING_COLON}跳过 DSH 不支持的推理档位 ${name}`)
  }
  if (Object.keys(efforts).length === 0) {
    if (declaresReasoning(raw)) {
      warnings.push(`${id}${WARNING_COLON}没有 DSH 支持的推理档位，已省略`)
    }
    return { value: undefined, warnings }
  }
  return { value: efforts, warnings }
}

/**
 * The label used for warnings about an entry that has no usable id. There is
 * no model name to quote, so an index keeps the warning locatable.
 * @param options - caller-provided `label`/`index`.
 * @returns the warning prefix.
 */
function anonymousEntryLabel(options) {
  const label = nonEmptyString(options?.label)
  if (label !== undefined) return label
  if (Number.isInteger(options?.index) && options.index >= 0) return `第 ${String(options.index + 1)} 个条目`
  return "未知模型"
}

/**
 * Map one raw Magpie listing entry to the storable `llm-pi-ai` entry shape.
 *
 * Only meaningful keys are emitted: `name` only when the listing discloses a
 * genuine display name (never as an id echo — the card's merge would overwrite
 * a stored display name with it, and the card already labels an unnamed model
 * with its id), then `contextWindow`/`maxTokens` when a positive integer was
 * disclosed, `input` when modalities were disclosed, `reasoningEfforts` when
 * reasoning was disclosed. Everything else in the raw entry is ignored.
 *
 * @param raw - one raw listing entry.
 * @param options - optional `{ id?, label?, index? }`: `id` is the fallback id
 *   for map envelopes, `label`/`index` name warnings for entries without one.
 * @returns `{ entry, warnings }`; `entry` is `null` when the raw entry has no
 *   usable id, in which case it is skipped with a warning.
 */
export function mapModelEntry(raw, options = {}) {
  const warnings = []
  const source = isRecord(raw) ? raw : undefined
  const id = nonEmptyString(source?.id) ?? nonEmptyString(options?.id)

  if (id === undefined) {
    warnings.push(`${anonymousEntryLabel(options)}${WARNING_COLON}缺少模型 id，已跳过`)
    return { entry: null, warnings }
  }

  const fields = source ?? {}
  // No id fallback: the card merges by id and keeps a stored display name when
  // the mapped entry does not declare one, so echoing the id here would
  // overwrite it on save.
  const name =
    nonEmptyString(fields.display_name) ??
    nonEmptyString(fields.name) ??
    nonEmptyString(fields.displayName)

  const entry = name === undefined ? { id } : { id, name }

  const contextWindow = firstPositiveInteger(
    fields.context_window,
    fields.context_length,
    fields.max_input_tokens,
    fields.contextWindow,
  )
  if (contextWindow !== undefined) entry.contextWindow = contextWindow

  const maxTokens = firstPositiveInteger(fields.max_output_tokens, fields.maxTokens, fields.max_tokens)
  if (maxTokens !== undefined) entry.maxTokens = maxTokens

  const input = mapInput(fields, id)
  warnings.push(...input.warnings)
  if (input.value !== undefined) entry.input = input.value

  const reasoning = mapReasoning(fields, id)
  warnings.push(...reasoning.warnings)
  if (reasoning.value !== undefined) entry.reasoningEfforts = reasoning.value

  return { entry, warnings }
}

/**
 * Map a whole gateway listing response to storable entries.
 *
 * Entries without a usable id are skipped (with a warning) rather than failing
 * the import; every other entry maps in listing order, and per-model notes are
 * aggregated after any parse note.
 *
 * @param body - parsed JSON body of the gateway's listing response.
 * @returns `{ models, warnings }` — storable entries and Chinese mapping notes.
 * @throws Error when the body is neither listing envelope.
 */
export function mapModelListing(body) {
  const parsed = parseModelListing(body)
  const warnings = [...parsed.warnings]
  const models = []
  parsed.entries.forEach((raw, index) => {
    const mapped = mapModelEntry(raw, { index })
    warnings.push(...mapped.warnings)
    if (mapped.entry !== null) models.push(mapped.entry)
  })
  return { models, warnings }
}
