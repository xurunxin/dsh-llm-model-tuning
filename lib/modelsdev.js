/**
 * models.dev catalog matching and model-entry completion.
 *
 * A gateway's `/models` listing often leaves model detail out: the Magpie
 * mapping (`lib/magpie.js`) can only report the capacities, modalities and
 * reasoning levels the listing itself discloses. This module turns the public
 * https://models.dev/api.json catalog into a deterministic lookup that answers
 * the only question completion needs: "which catalog model is this gateway
 * model?".
 *
 * Gateway ids carry provider or category decorations (`xxx/gpt-6.1-sol`,
 * `cn:deepseek-flash`, `@cf/openai/gpt-oss-20b`), so matching is done on
 * progressive tails as well as on the whole id. `normalizeModelKey` folds case,
 * delimiters and dot/dash spellings together, and every catalog id,
 * `canonical_model_id`, display name and family is indexed as its normalized
 * self plus its tails after `/` or `:` delimiters. The resulting matches are
 * scored in fixed tiers:
 *
 * - 1000 — exact raw model id (case-insensitive);
 * - 950 — exact raw `canonical_model_id`;
 * - 900 — normalized model id equal;
 * - 850 — normalized canonical id equal;
 * - 800 — normalized display name equal;
 * - 760 / 720 / 680 — a normalized query key equals a catalog id / canonical
 *   id / display-name key (tails included);
 * - 500 — a normalized query key equals the catalog model's `family`;
 * - 400 — a normalized query key with one trailing local-disambiguation marker
 *   removed equals a catalog id key (tails included). A marker is exactly one
 *   trailing token: a single letter `a`–`z`, a single digit `0`–`9`, `ctrl`, or
 *   `exp`. WorkBuddy-style gateways decorate ids this way (`cn:kimi-k3-1` is
 *   the gateway's `kimi-k3`, `cn:hy4-preview-ctrl` its `hy4-preview`). This
 *   tier is reached only when no tier above matched the entry, and it is
 *   deliberately below the family floor.
 *
 * Two bonuses make the authoritative vendor win over resellers: +300 when the
 * catalog provider id matches a provider hint from the query id's leading
 * segments (or `query.providerHint`), and +200 when the catalog provider id
 * prefixes its own `canonical_model_id`. Both bonuses apply only to the normal
 * tiers: a local-alias match never receives them, so a 400-scored alias can
 * never overtake even a 500-scored family match. Ties prefer the authoritative
 * vendor, then the more complete catalog record (context, output, input
 * modalities, reasoning options), then the lexicographically smaller provider
 * id, then the smaller model id, so the result is deterministic.
 *
 * `enrichModelEntry` only fills fields the entry is missing; a gateway-disclosed
 * value always wins. It is deliberately pure: no Node builtins and no fetch, so
 * the Host half, the offline unit suite and a live catalog check all resolve ids
 * with the very same rules.
 *
 * @module dsh-llm-model-tuning/modelsdev
 */
import { THINKING_LEVELS } from "./magpie.js"

/** The public models.dev catalog endpoint. */
export const MODELS_DEV_URL = "https://models.dev/api.json"

/** The reasoning levels the `llm-pi-ai` schema accepts, in schema order. */
export { THINKING_LEVELS }

const THINKING_LEVEL_SET = new Set(THINKING_LEVELS)

/** Reasoning-effort names that all mean "the model can be told not to reason". */
const OFF_ALIASES = new Set(["off", "none"])

const TEXT_MODALITY = "text"
const IMAGE_MODALITY = "image"
const SUPPORTED_MODALITIES = new Set([TEXT_MODALITY, IMAGE_MODALITY])

/** Error text for a body that is not a models.dev catalog. */
const BAD_CATALOG_MESSAGE = "models.dev 目录格式无法识别"

/** The tiers, ordered from strongest to weakest, used by the score computation. */
const MATCH_TIERS = Object.freeze({
  EXACT_ID: 1000,
  EXACT_CANONICAL_ID: 950,
  NORMALIZED_ID: 900,
  NORMALIZED_CANONICAL_ID: 850,
  NORMALIZED_NAME: 800,
  CATALOG_ID_KEY: 760,
  CATALOG_CANONICAL_KEY: 720,
  CATALOG_NAME_KEY: 680,
  CATALOG_FAMILY_KEY: 500,
  ALIASED_ID_KEY: 400,
  PROVIDER_HINT_BONUS: 300,
  CANONICAL_PROVIDER_BONUS: 200,
})

/** The single trailing tokens a gateway uses to disambiguate a local alias. */
const LOCAL_MARKER_PATTERN = /^(?:[a-z0-9]|ctrl|exp)$/

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

/* -------------------------------------------------------------- normalizing -- */

/**
 * Normalize one model id fragment for comparison.
 *
 * Lowercases, turns every run of non-alphanumeric characters into a single
 * `-`, and trims leading/trailing separators. This makes `gpt-6.1-sol` and
 * `GPT_6_1_sol` compare equal and keeps dotted versions (`claude-haiku-5.5`)
 * equivalent to their dashed spelling.
 *
 * @param text - the model id, canonical id, name, or family fragment.
 * @returns the normalized key; an empty string for a non-string or blank input.
 */
export function normalizeModelKey(text) {
  if (typeof text !== "string") return ""
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Every progressive tail of a decorated id, after each `/` or `:` delimiter.
 *
 * `cn:deepseek-flash` yields `["deepseek-flash"]`; `a/b/c` yields
 * `["b/c", "c"]`. Delimiters other than `/` and `:` (notably `.` and `@`) are
 * left to `normalizeModelKey`.
 *
 * @param text - the decorated id.
 * @returns the non-empty tails, outermost decorator first.
 */
function progressiveTails(text) {
  const tails = []
  let rest = text
  for (;;) {
    const match = /[/:]/.exec(rest)
    if (match === null) break
    rest = rest.slice(match.index + 1)
    if (rest.length === 0) break
    tails.push(rest)
  }
  return tails
}

/**
 * Add every normalized comparison form of one fragment to a key set: the whole
 * fragment plus its progressive tails.
 * @param target - the set to grow.
 * @param text - candidate id/name/family fragment.
 */
function addKeyForms(target, text) {
  const normalized = normalizeModelKey(text)
  if (normalized.length === 0) return
  target.add(normalized)
  for (const tail of progressiveTails(text)) {
    const key = normalizeModelKey(tail)
    if (key.length > 0) target.add(key)
  }
}

/**
 * The normalized comparison keys of one id/name/family: the whole fragment plus
 * its progressive tails.
 * @param text - candidate fragment.
 * @returns the key set (empty for a blank or non-string input).
 */
function keyFormsOf(text) {
  const keys = new Set()
  if (typeof text !== "string") return keys
  addKeyForms(keys, text)
  return keys
}

/**
 * The local-alias keys of one query id: every normalized form of the id and of
 * its progressive tails with exactly one trailing local-disambiguation marker
 * removed.
 *
 * WorkBuddy-style gateways decorate a catalog id with a category prefix and a
 * short local suffix: `cn:kimi-k3-1` requests the gateway's `kimi-k3`,
 * `cn:hy3-b` its `hy3`, and `cn:hy4-preview-ctrl` its `hy4-preview`. Only a
 * single trailing token that is one letter, one digit, `ctrl`, or `exp` is
 * removed; a longer word (`turbo`, `split`, `lkeap`, `volc`) never becomes a
 * match by being stripped. Alias forms are derived from the id alone — a
 * display name already has its own matching tier.
 * @param text - the decorated id.
 * @returns the alias key set (empty when no form ends in such a marker).
 */
function localAliasKeysOf(text) {
  const keys = new Set()
  if (typeof text !== "string") return keys
  const addAlias = (normalized) => {
    if (normalized.length === 0) return
    const tokens = normalized.split("-")
    if (tokens.length < 2) return
    if (!LOCAL_MARKER_PATTERN.test(tokens[tokens.length - 1])) return
    const alias = tokens.slice(0, -1).join("-")
    if (alias.length > 0) keys.add(alias)
  }
  addAlias(normalizeModelKey(text))
  for (const tail of progressiveTails(text)) addAlias(normalizeModelKey(tail))
  return keys
}

/* ------------------------------------------------------------------- index -- */

/**
 * Build the deterministic models.dev lookup index from a parsed catalog body.
 *
 * The catalog body is `{ [providerId]: { id?, name?, api?, models: { [modelId]:
 * model } } }`, with each model carrying `id`, `name`, `canonical_model_id`,
 * `family`, `reasoning`, `reasoning_options`, `modalities.input` and
 * `limit.context`/`limit.output` among its fields. Every usable model becomes
 * one index entry with its normalized key sets and metadata-completeness score
 * pre-computed, so later matching is a single pass over the index.
 *
 * @param catalogBody - parsed JSON body of `https://models.dev/api.json`.
 * @returns the opaque index object accepted by `matchModelsDevModel`.
 * @throws {Error} `models.dev 目录格式无法识别` when the body is not a catalog
 *   (not an object, or no provider exposes a single usable model).
 */
export function buildModelsDevIndex(catalogBody) {
  if (!isRecord(catalogBody)) throw new Error(BAD_CATALOG_MESSAGE)

  const entries = []
  let providerCount = 0
  let modelCount = 0

  for (const [providerKey, providerValue] of Object.entries(catalogBody)) {
    if (!isRecord(providerValue)) continue
    const models = providerValue.models
    if (!isRecord(models)) continue
    const providerId = nonEmptyString(providerValue.id) ?? providerKey
    const providerName = nonEmptyString(providerValue.name)
    providerCount += 1

    for (const [modelKey, modelValue] of Object.entries(models)) {
      if (!isRecord(modelValue)) continue
      entries.push(buildIndexEntry(providerId, providerName, modelKey, modelValue))
      modelCount += 1
    }
  }

  if (entries.length === 0) throw new Error(BAD_CATALOG_MESSAGE)
  return { providerCount, modelCount, entries }
}

/**
 * The raw catalog model id: its own `id` when usable, else the map key. Both are
 * indexed, but this is the id reported as `modelId`.
 * @param modelKey - the property key under `provider.models`.
 * @param model - the raw catalog model object.
 * @returns the model id the catalog declares.
 */
function rawModelIdOf(modelKey, model) {
  return nonEmptyString(model.id) ?? modelKey
}

/**
 * Whether the catalog provider is the authoritative vendor of its own canonical
 * id, i.e. its provider id prefixes its `canonical_model_id`. Such a record
 * answers "provider openai, model gpt-6.1-sol" for `openai/gpt-6.1-sol` and is
 * preferred over the aggregator copies of the same model.
 * @param providerId - the catalog provider id.
 * @param canonicalModelId - the model's canonical id, when declared.
 * @returns true when this provider owns the canonical id.
 */
function isAuthoritativeVendor(providerId, canonicalModelId) {
  if (canonicalModelId === undefined) return false
  const match = /^([^/:]+)[/:]/.exec(canonicalModelId)
  if (match === null) return false
  return match[1].toLowerCase() === providerId.toLowerCase()
}

/**
 * How much of the metadata completion can use is present on one catalog model:
 * a context limit, an output limit, input modalities, and reasoning options.
 * Used only to break otherwise equal ties, so the more complete record wins.
 * @param model - the raw catalog model object.
 * @returns the number of usable metadata groups, 0 through 4.
 */
function metadataCompleteness(model) {
  let score = 0
  const limit = isRecord(model.limit) ? model.limit : {}
  if (positiveInteger(limit.context) !== undefined) score += 1
  if (positiveInteger(limit.output) !== undefined) score += 1
  if (isRecord(model.modalities) && Array.isArray(model.modalities.input) && model.modalities.input.length > 0) {
    score += 1
  }
  if (Array.isArray(model.reasoning_options) && model.reasoning_options.length > 0) score += 1
  return score
}

/**
 * One pre-computed index entry for a single catalog model.
 * @param providerId - the catalog provider id.
 * @param providerName - the catalog provider display name, when declared.
 * @param modelKey - the property key under `provider.models`.
 * @param model - the raw catalog model object.
 * @returns the index entry consumed by `matchModelsDevModel`.
 */
function buildIndexEntry(providerId, providerName, modelKey, model) {
  const modelId = rawModelIdOf(modelKey, model)
  const rawIdsLower = new Set()
  for (const candidate of [modelKey, nonEmptyString(model.id)]) {
    const raw = nonEmptyString(candidate)
    if (raw !== undefined) rawIdsLower.add(raw.toLowerCase())
  }

  const normalizedIds = new Set()
  const idKeys = new Set()
  for (const candidate of [modelKey, nonEmptyString(model.id)]) {
    const raw = nonEmptyString(candidate)
    if (raw === undefined) continue
    const normalized = normalizeModelKey(raw)
    if (normalized.length > 0) normalizedIds.add(normalized)
    addKeyForms(idKeys, raw)
  }

  const canonicalModelId = nonEmptyString(model.canonical_model_id)
  const rawCanonicalLower = canonicalModelId === undefined ? undefined : canonicalModelId.toLowerCase()
  const normalizedCanonicals = new Set()
  const canonicalKeys = new Set()
  if (canonicalModelId !== undefined) {
    const normalized = normalizeModelKey(canonicalModelId)
    if (normalized.length > 0) normalizedCanonicals.add(normalized)
    addKeyForms(canonicalKeys, canonicalModelId)
  }

  const name = nonEmptyString(model.name)
  const normalizedNames = new Set()
  const nameKeys = new Set()
  if (name !== undefined) {
    const normalized = normalizeModelKey(name)
    if (normalized.length > 0) normalizedNames.add(normalized)
    addKeyForms(nameKeys, name)
  }

  const family = nonEmptyString(model.family)
  const familyKeys = new Set()
  if (family !== undefined) addKeyForms(familyKeys, family)

  return {
    providerId,
    providerName,
    providerKey: normalizeModelKey(providerId),
    modelId,
    model,
    rawIdsLower,
    rawCanonicalLower,
    normalizedIds,
    idKeys,
    normalizedCanonicals,
    canonicalKeys,
    normalizedNames,
    nameKeys,
    familyKeys,
    completeness: metadataCompleteness(model),
    authoritative: isAuthoritativeVendor(providerId, canonicalModelId),
    canonicalModelId,
  }
}

/* ----------------------------------------------------------------- matching -- */

/**
 * Whether two sets share at least one value.
 * @param left - one set.
 * @param right - the other set.
 * @returns true when they intersect.
 */
function intersects(left, right) {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const value of small) {
    if (large.has(value)) return true
  }
  return false
}

/**
 * Every provider hint a query id implies: the normalized leading segments
 * (before the final segment) of its `/`/`:` split, their progressive prefixes,
 * and `query.providerHint` itself. Used for the +300 provider bonus and for
 * provider-qualified canonical forms.
 * @param id - the query's model id.
 * @param explicitHint - the caller-supplied provider hint, when any.
 * @returns the normalized hint set (empty for an undecorated id).
 */
function providerHintsOf(id, explicitHint) {
  const hints = new Set()
  const add = (value) => {
    const normalized = normalizeModelKey(value)
    if (normalized.length > 0) hints.add(normalized)
  }
  add(explicitHint)
  const segments = id
    .split(/[/:]+/)
    .map((segment) => nonEmptyString(segment))
    .filter((segment) => segment !== undefined)
  const leading = segments.slice(0, -1)
  let prefix
  for (const segment of leading) {
    add(segment)
    prefix = prefix === undefined ? segment : `${prefix}/${segment}`
    add(prefix)
  }
  return hints
}

/**
 * Pre-compute the comparison keys of one match query.
 * @param query - `{ id, name?, providerHint? }`.
 * @returns the normalized query, or `undefined` for a missing/blank id.
 */
function buildMatchQuery(query) {
  const id = nonEmptyString(query?.id)
  if (id === undefined) return undefined
  const normalizedId = normalizeModelKey(id)
  if (normalizedId.length === 0) return undefined

  const name = nonEmptyString(query?.name)
  const hints = providerHintsOf(id, query?.providerHint)
  const idKeys = keyFormsOf(id)
  const nameKeys = name === undefined ? new Set() : keyFormsOf(name)

  // A query's canonical forms: the id itself plus every provider-qualified
  // spelling, so `{ id: "gpt-6.1-sol", providerHint: "openai" }` can match
  // `openai/gpt-6.1-sol` on the canonical-id tiers.
  const canonicalKeys = new Set(idKeys)
  for (const hint of hints) {
    for (const key of idKeys) canonicalKeys.add(`${hint}-${key}`)
  }

  const allKeys = new Set([...idKeys, ...nameKeys, ...canonicalKeys])
  return {
    rawIdLower: id.toLowerCase(),
    normalizedId,
    normalizedName: name === undefined ? undefined : normalizeModelKey(name),
    hints,
    idKeys,
    canonicalKeys,
    nameKeys,
    allKeys,
    aliasKeys: localAliasKeysOf(id),
  }
}

/**
 * The tier score of one catalog entry for one query, before bonuses.
 * @param matchQuery - the pre-computed query.
 * @param entry - one index entry.
 * @returns the tier score, or `undefined` when the entry does not match at all.
 */
function baseScoreOf(matchQuery, entry) {
  if (entry.rawIdsLower.has(matchQuery.rawIdLower)) return MATCH_TIERS.EXACT_ID
  if (entry.rawCanonicalLower !== undefined && entry.rawCanonicalLower === matchQuery.rawIdLower) {
    return MATCH_TIERS.EXACT_CANONICAL_ID
  }
  if (entry.normalizedIds.has(matchQuery.normalizedId)) return MATCH_TIERS.NORMALIZED_ID
  if (
    entry.normalizedCanonicals.has(matchQuery.normalizedId) ||
    intersects(matchQuery.canonicalKeys, entry.normalizedCanonicals)
  ) {
    return MATCH_TIERS.NORMALIZED_CANONICAL_ID
  }
  if (matchQuery.normalizedName !== undefined && entry.normalizedNames.has(matchQuery.normalizedName)) {
    return MATCH_TIERS.NORMALIZED_NAME
  }
  if (intersects(matchQuery.allKeys, entry.idKeys)) return MATCH_TIERS.CATALOG_ID_KEY
  if (intersects(matchQuery.allKeys, entry.canonicalKeys)) return MATCH_TIERS.CATALOG_CANONICAL_KEY
  if (intersects(matchQuery.allKeys, entry.nameKeys)) return MATCH_TIERS.CATALOG_NAME_KEY
  if (intersects(matchQuery.allKeys, entry.familyKeys)) return MATCH_TIERS.CATALOG_FAMILY_KEY
  return undefined
}

/**
 * Whether one candidate beats another: higher score, then the authoritative
 * vendor, then the more complete metadata, then the lexicographically smaller
 * provider id and model id. The authoritative preference sits before metadata
 * completeness so a local-alias match prefers e.g. `moonshotai/kimi-k3` over a
 * more complete reseller copy deterministically.
 * @param entry - the candidate entry.
 * @param score - the candidate's score.
 * @param best - the current best entry.
 * @param bestScore - the current best score.
 * @returns true when the candidate should replace the current best.
 */
function isBetter(entry, score, best, bestScore) {
  if (score !== bestScore) return score > bestScore
  if (entry.authoritative !== best.authoritative) return entry.authoritative
  if (entry.completeness !== best.completeness) return entry.completeness > best.completeness
  if (entry.providerId !== best.providerId) return entry.providerId < best.providerId
  return entry.modelId < best.modelId
}

/**
 * Match one gateway model against the models.dev index.
 *
 * The match is deterministic: the highest-scoring catalog record wins, with the
 * documented bonus and tie-break rules of this module. Every matching tier
 * applies before any bonus, so the returned `score` can be used in diagnostics
 * and tests. A local-alias match (the lowest tier) earns no bonus at all.
 *
 * @param index - an index returned by `buildModelsDevIndex`.
 * @param query - `{ id, name?, providerHint? }`; `id` is the gateway model id,
 *   `name` its disclosed display name, `providerHint` an optional provider id
 *   when the caller knows which vendor the model belongs to.
 * @returns the matched catalog record
 *   `{ providerId, providerName?, modelId, canonicalModelId?, model, score }`,
 *   or `undefined` when no catalog model plausibly matches.
 */
export function matchModelsDevModel(index, query) {
  const matchQuery = buildMatchQuery(query)
  if (matchQuery === undefined) return undefined
  if (!isRecord(index) || !Array.isArray(index.entries)) return undefined

  let best
  let bestScore
  for (const entry of index.entries) {
    const baseScore = baseScoreOf(matchQuery, entry)
    const aliased = baseScore === undefined && intersects(matchQuery.aliasKeys, entry.idKeys)
    if (baseScore === undefined && !aliased) continue
    let score = aliased ? MATCH_TIERS.ALIASED_ID_KEY : baseScore
    if (!aliased) {
      if (entry.providerKey.length > 0 && matchQuery.hints.has(entry.providerKey)) {
        score += MATCH_TIERS.PROVIDER_HINT_BONUS
      }
      if (entry.authoritative) score += MATCH_TIERS.CANONICAL_PROVIDER_BONUS
    }
    if (best === undefined || isBetter(entry, score, best, bestScore)) {
      best = entry
      bestScore = score
    }
  }
  if (best === undefined) return undefined

  const match = { providerId: best.providerId, modelId: best.modelId, model: best.model, score: bestScore }
  if (best.providerName !== undefined) match.providerName = best.providerName
  if (best.canonicalModelId !== undefined) match.canonicalModelId = best.canonicalModelId
  return match
}

/* ---------------------------------------------------------------- enriching -- */

/**
 * The input modalities completion can use, in canonical order.
 * Text is the floor: any usable catalog modality list implies text, because
 * every DSH protocol carries it. Unsupported names (`pdf`, `audio`, `video`) are
 * dropped silently, and a list with no usable name yields `undefined`.
 * @param catalogModel - the raw catalog model object.
 * @returns `["text"]`, `["text", "image"]`, or `undefined`.
 */
function catalogInputOf(catalogModel) {
  const modalities = isRecord(catalogModel.modalities) ? catalogModel.modalities : undefined
  const declared = modalities === undefined ? undefined : modalities.input
  if (!Array.isArray(declared)) return undefined

  const known = new Set()
  for (const candidate of declared) {
    const name = nonEmptyString(candidate)?.toLowerCase()
    if (name === undefined) continue
    if (SUPPORTED_MODALITIES.has(name)) known.add(name)
  }
  if (known.size === 0) return undefined
  return known.has(IMAGE_MODALITY) ? [TEXT_MODALITY, IMAGE_MODALITY] : [TEXT_MODALITY]
}

/**
 * The `reasoningEfforts` value models.dev implies for one catalog model.
 *
 * `reasoning: false` is authoritative and becomes `false`. Otherwise the
 * `reasoning_options` list is read: `effort` values in the seven
 * `THINKING_LEVELS` are kept (`none`/`off` become key `off` with wire spelling
 * `null`), unknown values are skipped, a `toggle` option means off is
 * supported, and `budget_tokens` options are ignored. The result is emitted only
 * when at least one non-off level exists.
 *
 * @param catalogModel - the raw catalog model object.
 * @returns the efforts object (`false` for a non-reasoning model), or
 *   `undefined` when models.dev discloses nothing usable.
 */
function catalogReasoningEffortsOf(catalogModel) {
  if (catalogModel.reasoning === false) return false
  if (!Array.isArray(catalogModel.reasoning_options)) return undefined

  const levels = new Set()
  let supportsToggle = false
  for (const option of catalogModel.reasoning_options) {
    if (!isRecord(option)) continue
    if (option.type === "toggle") {
      supportsToggle = true
      continue
    }
    if (option.type !== "effort" || !Array.isArray(option.values)) continue
    for (const candidate of option.values) {
      const name = nonEmptyString(candidate)?.toLowerCase()
      if (name === undefined) continue
      if (OFF_ALIASES.has(name)) {
        levels.add("off")
        continue
      }
      if (THINKING_LEVEL_SET.has(name)) levels.add(name)
    }
  }

  const hasNonOffLevel = THINKING_LEVELS.some((level) => level !== "off" && levels.has(level))
  if (!hasNonOffLevel) return undefined
  if (supportsToggle) levels.add("off")

  const efforts = {}
  for (const level of THINKING_LEVELS) {
    if (!levels.has(level)) continue
    efforts[level] = level === "off" ? null : level
  }
  return efforts
}

/**
 * Whether the entry already carries a reasoning disclosure, so completion must
 * leave it alone (`false` and empty objects are disclosures, not gaps).
 * @param entry - the model entry being completed.
 * @returns true when `reasoningEfforts` is present.
 */
function hasReasoningDisclosure(entry) {
  return entry.reasoningEfforts !== undefined && entry.reasoningEfforts !== null
}

/**
 * Whether the entry already carries a usable input-modality list.
 * @param entry - the model entry being completed.
 * @returns true when `input` is a non-empty array.
 */
function hasInputDisclosure(entry) {
  return Array.isArray(entry.input) && entry.input.length > 0
}

/**
 * The display name completion may use, or `undefined` when the catalog does not
 * disclose a genuine one.
 *
 * A catalog `name` that merely echoes the model id (`gpt-5.1` -> "gpt-5.1") is
 * not a display name: writing it would let an overwrite import replace a stored
 * display name with the raw id, which is exactly what the gateway mapping
 * (`lib/magpie.js`) avoids. Such an echo is treated as absent, the same way the
 * card labels an unnamed model with its id.
 * @param catalogModel - the raw catalog model object.
 * @param id - the gateway model id being completed.
 * @returns the catalog name, or `undefined` when absent or an id echo.
 */
function catalogNameOf(catalogModel, id) {
  const name = nonEmptyString(catalogModel.name)
  if (name === undefined) return undefined
  return name === id ? undefined : name
}

/**
 * Fill the `llm-pi-ai` settings of one model entry from one catalog model.
 *
 * Only absent fields are filled, in this order: `name`, `contextWindow`,
 * `maxTokens`, `input`, `reasoningEfforts`. A gateway-disclosed value is never
 * overwritten — including `reasoningEfforts: false` — so completion can only add
 * detail. The input entry is shallow-copied and never mutated.
 *
 * @param entry - the mapped model entry (`{ id, name?, contextWindow?, ... }`).
 * @param catalogModel - the raw catalog model object to copy detail from.
 * @returns `{ entry, fields }`: the completed copy and the names of the fields
 *   that were actually filled, in fill order.
 */
export function enrichModelEntry(entry, catalogModel) {
  if (!isRecord(entry)) return { entry, fields: [] }
  if (!isRecord(catalogModel)) return { entry: { ...entry }, fields: [] }

  const enriched = { ...entry }
  const fields = []

  if (nonEmptyString(entry.name) === undefined) {
    const name = catalogNameOf(catalogModel, nonEmptyString(entry.id))
    if (name !== undefined) {
      enriched.name = name
      fields.push("name")
    }
  }

  if (entry.contextWindow === undefined || entry.contextWindow === null) {
    const limit = isRecord(catalogModel.limit) ? catalogModel.limit : {}
    const contextWindow = positiveInteger(limit.context)
    if (contextWindow !== undefined) {
      enriched.contextWindow = contextWindow
      fields.push("contextWindow")
    }
  }

  if (entry.maxTokens === undefined || entry.maxTokens === null) {
    const limit = isRecord(catalogModel.limit) ? catalogModel.limit : {}
    const maxTokens = positiveInteger(limit.output)
    if (maxTokens !== undefined) {
      enriched.maxTokens = maxTokens
      fields.push("maxTokens")
    }
  }

  if (!hasInputDisclosure(entry)) {
    const input = catalogInputOf(catalogModel)
    if (input !== undefined) {
      enriched.input = input
      fields.push("input")
    }
  }

  if (!hasReasoningDisclosure(entry)) {
    const reasoningEfforts = catalogReasoningEffortsOf(catalogModel)
    if (reasoningEfforts !== undefined) {
      enriched.reasoningEfforts = reasoningEfforts
      fields.push("reasoningEfforts")
    }
  }

  return { entry: enriched, fields }
}

/**
 * Complete a whole mapped model list from a models.dev catalog body.
 *
 * Every entry is matched independently and completed with `enrichModelEntry`.
 * The returned `modelsDev` summary reports the completion attempt:
 * `matched` counts entries that found a catalog record (whether or not it filled
 * anything), `enriched` lists the ids that were actually filled together with
 * the field names, and `unmatched` lists the ids with no catalog record.
 *
 * @param models - the mapped model entries, in listing order.
 * @param catalogBody - parsed JSON body of `https://models.dev/api.json`.
 * @param index - optional prebuilt index for the same body (the Host half
 *   caches one; tests can omit it).
 * @returns `{ models, modelsDev }`: completed copies of the entries and the
 *   completion summary. Never mutates the inputs.
 * @throws {Error} when the catalog body is not a models.dev catalog.
 */
export function enrichModels(models, catalogBody, index = buildModelsDevIndex(catalogBody)) {
  const entries = Array.isArray(models) ? models : []
  const enrichedModels = []
  const enriched = []
  const unmatched = []
  let matched = 0

  for (const entry of entries) {
    if (!isRecord(entry)) {
      enrichedModels.push(entry)
      continue
    }
    const id = nonEmptyString(entry.id)
    if (id === undefined) {
      enrichedModels.push({ ...entry })
      continue
    }
    const match = matchModelsDevModel(index, { id, name: nonEmptyString(entry.name) })
    if (match === undefined) {
      unmatched.push(id)
      enrichedModels.push({ ...entry })
      continue
    }
    matched += 1
    const result = enrichModelEntry(entry, match.model)
    enrichedModels.push(result.entry)
    if (result.fields.length > 0) enriched.push({ id, fields: result.fields })
  }

  return {
    models: enrichedModels,
    modelsDev: { source: "models.dev", available: true, matched, enriched, unmatched },
  }
}
