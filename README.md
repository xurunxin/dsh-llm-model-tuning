# dsh-llm-model-tuning

[![CI](https://github.com/xurunxin/dsh-llm-model-tuning/actions/workflows/ci.yml/badge.svg)](https://github.com/xurunxin/dsh-llm-model-tuning/actions/workflows/ci.yml)

Adds a per-model **reasoning-effort** and **multimodal input** editor to every custom provider card on the DeepSeek Harness **Settings → Models** page, rendered in the same visual language as the shipped page, plus a **Magpie gateway import** that can pull a provider's `/models` listing, translate its Magpie extension fields into `llm-pi-ai` model entries, and let you pick which of them to import from a searchable selection dialog before filing them into the card's draft.

> **Requires dsh 0.1.7 or newer.** This card writes settings through the `configForms` service; the older `settingsScope` service was removed in 0.1.7. The gateway import additionally uses the Connection exact Fetch-route registry (`ctx.connection.fetch.register`). See [Requirements](#requirements).

Reasoning effort is a *per-model* capability — the models under one provider disagree about it, so a provider-scoped control could only be set to a value some of them reject. This plugin keeps a per-model editor with its own granularity (including the wire spelling each level sends) and adds the gateway import that the shipped editor does not perform: it lists the route's own model entries, lets you choose which gateway models to add or overwrite, and edits two fields on each:

| Field | Meaning |
| --- | --- |
| `reasoningEfforts` | Which effort levels the model offers, and the wire spelling each one sends. `false` declares a non-reasoning model; absent inherits the installed catalog. |
| `input` | Which request modalities the model accepts (`text`, `image`). Absent inherits the installed catalog. |

It also edits the route-level `defaultInput` fallback, which is what makes a gateway serving vision models the catalog does not describe usable.

Both fields are written into the `llm-pi-ai` settings section, so a change reaches the next request with no restart — the adapter resolves profiles per request.

## 从网关导入模型 — Magpie import with model selection

Expand a custom provider card and click **获取可用模型** (the button reads `正在询问提供商…` and is disabled while the request runs). The card stays a thin client: the Host half resolves the provider's profile and credential, fetches `GET {baseURL}/models`, maps the Magpie extensions to storable `llm-pi-ai` entries, and answers the page.

A listing with at least one importable model opens the **选择要添加的模型** dialog (an empty listing reports the warn status `网关没有返回可导入的模型。` instead):

- the search input `搜索模型` filters the candidates as you type; no match shows `没有匹配的模型。`;
- every candidate is checked by default — new and existing ids alike; `全选` / `取消全选` toggles all *visible* candidates;
- each candidate carries a `新增` badge, or a `覆盖` badge when its id already exists in the card's draft;
- `取消` closes the dialog without importing; `添加所选` is disabled while nothing is selected.

Nothing is imported until you confirm with **添加所选**. **The import only edits the draft** — nothing is written until you click **保存** (or **放弃修改** discards it). A failed fetch keeps the dialog closed and reports `导入失败：<message>` in the card.

The gateway answer may be an OpenAI-style `{"data":[…]}` array or a `{"models":{…}}` map. Each entry's Magpie extension fields map as follows:

| Gateway field | Written `llm-pi-ai` field | Rule |
| --- | --- | --- |
| `id` | `id` | The model id. For a `{"models":{…}}` map the key is used when the value has no `id`; an entry without any usable id is skipped with a warning. |
| `display_name` (then `name` / `displayName`) | `name` | Only a genuinely disclosed name is written; with none, the entry omits `name` and the card's label falls back to the id. |
| `context_window`, `context_length`, `max_input_tokens`, `contextWindow` | `contextWindow` | The first positive integer in that order. |
| `max_output_tokens`, `maxTokens`, `max_tokens` | `maxTokens` | The first positive integer in that order. |
| `modalities.input` (then `input_modalities`, then `input`) | `input` | Lowercased; only `text` and `image` survive. `text` is the floor (added whenever a list is disclosed); other names such as `pdf` are skipped with a warning. No disclosed modalities ⇒ field omitted. |
| `reasoning: false` | `reasoningEfforts: false` | Declares a non-reasoning model. |
| `supported_reasoning_levels[].effort` (then `reasoning_levels` strings) | `reasoningEfforts` | Normalized to lower case; the allowed levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `off`/`none` become `off: null`; every other level becomes `{ "<level>": "<level>" }` — the wire spelling is the disclosed effort name. Levels outside that set (e.g. `ultra`) are skipped with a warning. |
| `reasoning: true` but no disclosed levels (or only unsupported ones) | — | Field omitted with a warning; the installed catalog's capability answers for the model. |
| no `reasoning` flag and no levels | — | Field omitted (unknown is not guessed). |
| `magpie_label`, `service_tiers`, `owned_by`, `type`, `pricing`, … | — | Ignored; only the fields above are translated. |

Per-model notes (skipped `ultra` levels, skipped `pdf` modalities, a reasoning model without disclosed levels, an entry without an id) are collected by the Host and shown after the import line as `网关提示：…`.

Confirming the dialog merges **only the selected** candidates:

- **New id + selected + `models` mode** — appended in gateway order (badge `新增`), keeping the existing entries' order.
- **Existing id + selected** — its **managed fields are overwritten** (badge `覆盖`): `name`, `contextWindow`, `maxTokens`, `input`, and `reasoningEfforts`. Each managed field takes the mapped value when the candidate discloses it and is **deleted** when it does not, so a gateway that stops reporting a model's reasoning levels or modalities clears the old values (the model falls back to the installed catalog). `id` and unmanaged raw fields (e.g. `compat`) are preserved. The editable controls are rebuilt from the mapped values.
- **Existing id + not selected** and **entries the gateway does not return** — untouched, byte for byte.
- **`modelOverrides` mode** — a selected existing id is overwritten as above. A selected *new* id is skipped with `跳过 S 个新模型：当前是 modelOverrides 模式，不能新增模型条目。`, because an override cannot introduce a catalog-unknown model.
- Re-importing the same listing with everything selected is **idempotent**: no duplicates, stable model order, and the draft ends up unchanged — the saved section stays identical without needing another save.

A successful attempt reports `已导入 N 个模型（新增 X、覆盖 Y）`, where `N` counts the selected candidates that produced an entry; the Host's per-model notes follow as `网关提示：…`. A gateway that returns nothing importable reports a warning instead.

## How it is put together

**Client card.** It renders the same visual language as the shipped Models page: a collapsed header (`模型调优` / `展开配置`), then the provider-level `默认输入类型` fallback, the `从网关导入` group, the `模型（N）` list whose entries expand through `模型选项` into `输入类型` checkboxes and a `推理能力` select (inherit / off / custom level rows with `添加档位` / `删除档位`), an add-model row, and `保存` / `放弃修改` actions. The import opens the selection dialog described above.

It registers on the `settings.models.provider-card` seat under the `llm-pi-ai` namespace, keyed by the provider row's own settings namespace. Because every configurable pi-ai route declares `settingsNs: 'llm-pi-ai'`, a single registration under that key receives every custom-provider card — saved rows and the add-provider draft alike — without the Models section knowing anything about this plugin. The card follows the namespace through `configForms.whileServed`, so a deployment without that adapter shows no trace of it, and it reads/writes the namespace through a `configForms` form (`getSnapshot`/`subscribe`/`mutate`).

**Host half.** The entry is no longer empty: it injects `settings`, `credentials`, and `connection` and registers one exact Connection Fetch route. The page only calls this route; the API key never reaches the browser.

```
POST /api/dsh-llm-model-tuning/models
content-type: application/json
{ "provider": "<route id>", "settingsNs": "llm-pi-ai" }   // settingsNs optional, defaults llm-pi-ai
```

Success — HTTP 200:

```json
{ "ok": true, "models": [ /* storable llm-pi-ai model entries */ ], "warnings": ["group/never-stuck：跳过 DSH 不支持的推理档位 ultra"] }
```

Failure — HTTP 400 (bad request / unknown provider / unsupported protocol / unusable profile) or 502 (gateway unreachable, auth refused, non-JSON listing, missing credential):

```json
{ "ok": false, "message": "给用户看的中文说明" }
```

Host behaviour:

1. Reads the live `llm-pi-ai` descriptor from `ctx.settings.describe({ redactSecrets: true })` and takes `value.providers[<route>]` — the resolved profile, so a route declared only in the composition base/`cordis.patch.yml` is found too. A missing namespace or route answers 400.
2. Chooses the listing endpoint from `profile.api` (default `openai-completions`):
   - `openai-completions` / `openai-responses`: `GET {baseURL without a trailing slash}/models`
   - `anthropic-messages`: strips a trailing `/v1` from `baseURL`, then `GET {root}/v1/models?limit=1000` with `x-api-key` and `anthropic-version: 2023-06-01`
   - anything else answers 400 `该协议不支持自动拉取模型列表`.
3. Starts from the profile's `headers` (string values only), sets `accept: application/json`, and adds the auth header. If `profile.apiKeyEnv` is set, `await ctx.credentials.resolve(ref)` supplies the key; a missing credential answers 502 naming the reference. With no `apiKeyEnv` the listing is fetched unauthenticated.
4. Fetches with a 20 s timeout, answers 502 `网关返回 HTTP <status>` on a non-2xx response (401/403 adds a check-the-key hint), and maps a non-JSON body to 502 as well.
5. Returns the storable entries plus the per-model mapping warnings.

The route is registered with `ctx.effect(() => ctx.connection.fetch.register({ path, methods: ["POST"], requestBody: "buffered", fetch }))`, so it is disposed with the plugin's fiber. The `/api` prefix authenticates the browser session before any exact route is dispatched; the handler only ever sees the authenticated same-origin page.

## Install

Install the bundle with the plugin manager, pointing it at this directory:

```
plugin_manager  action: install_bundle  target: <absolute path to this package>
```

That performs the package installation and bundle selection itself — it adds the
dependency, links it into the active profile's `node_modules`, and appends the
package to `dsh.profile.bundles` because it declares `dsh.bundle.patch`. Do not
hand-edit the profile's `package.json` or `cordis.patch.yml`, and do not run a
package manager in the profile directory.

The install is a **symlink** to this directory, so later edits here are picked up
without reinstalling. A freshly installed bundle can activate through HMR; a
replaced one needs a profile restart to load a fresh JavaScript module
generation.

## Requirements

- **dsh 0.1.7 or newer.** The card reads and writes settings through the
  `configForms` service (the older `settingsScope` service was removed in 0.1.7,
  and a card still injecting it never activates — the row simply waits forever;
  `test/bundle-contract.mjs` guards against that regression). The gateway import
  additionally needs the Connection exact Fetch-route registry
  (`ctx.connection.fetch.register`), which the same runtime provides.
- The `llm-pi-ai` adapter must be composed, since it owns the settings namespace
  this card edits and the provider profiles the import route reads. The card
  follows it with `configForms.whileServed`, so a deployment without that
  adapter shows no trace of this card rather than a dead panel.
- The Host half needs the `settings`, `credentials`, and `connection` services
  (declared via its `inject`), which the standard web and desktop profiles
  compose. The credential named by a provider's `apiKeyEnv` must be resolvable
  through the credentials service for an authenticated gateway.

## What the card does with your document

- **Edit surface.** The card reads and writes the *user* layer of the `llm-pi-ai` section. A route declared only in the composition base is read from the resolved value so it can still be tuned; writing it is what materializes it in the user layer.
- **Path-addressed writes.** Every hand edit travels as `settings.mutate` path ops against the stored section, so fields the card never rendered cannot be deleted. The one deliberate exception is the gateway import: for a model you select in the dialog it rebuilds the five managed fields in the draft, which is what makes an overwrite able to clear a value the gateway no longer discloses. `id` and unmanaged fields are kept. The namespace revision fences a stale card against a concurrent change.
- **`models` vs `modelOverrides`.** A `models` list *replaces* the installed catalog, while `modelOverrides` reshapes it. The adapter refuses both together, so the card edits whichever the profile already uses and offers to add `modelOverrides` entries when neither is present. A `models` list is an array — and the settings path-op walker refuses to descend through arrays — so that array is written as one value; a `modelOverrides` dict is addressed field by field.
- **Text is held on.** `input` and `defaultInput` replace a modality list rather than extending it, so declaring images alone would quietly drop text and leave a model the harness can no longer talk to. Text is therefore always kept, and clearing the last optional modality removes the field so the adapter's own default answers instead.
- **Refusals are named locally.** `ConfigFormController.mutate` reports whether the Host *accepted* a write, not which field it rejected. The card therefore reproduces the adapter's own `reasoningEfforts` rules (every level needs a wire spelling; only `off` may be empty; at least one level beyond `off`) so a refusal names the field, and it still reports a Host rejection as a failure rather than success.

## Tests

```sh
npm test
```

Six suites, all offline, no dependencies to install:

| Suite | What it proves |
| --- | --- |
| `test/harness.mjs` | The card's own behaviour, driven through its real controls against a faithful settings-op simulator. Includes the selection dialog (default-all-checked, `新增`/`覆盖` badges, search, 全选/取消全选, cancel/Escape), selected-only importing, managed-field overwrite *and* clearing, idempotent re-import, `modelOverrides` skip behaviour, the failure/no-write paths, and a rejection-never-reported-as-success case. |
| `test/magpie.mjs` | The mapping module against the saved live 28-model Magpie listing: capacities, modalities, reasoning levels, `ultra`/`pdf` skips, both envelopes, malformed input. |
| `test/host-harness.mjs` | The Host route handler with a stubbed `ctx` and stubbed `fetch`: success shape, 400 unknown provider, 502 upstream failure, authorization header, route path/methods/body mode. |
| `test/integration.mjs` | The **exact section the card wrote** is accepted by the **real** `llm-pi-ai` `Config` schema — including a section written after an import confirmed through the selection dialog, an idempotent second import, a managed-field overwrite that clears a no-longer-disclosed value, and an imported `modelOverrides` update. |
| `test/conformance.mjs` | Document shapes, and the refusals the card reproduces, checked against that same real schema. |
| `test/bundle-contract.mjs` | The bundle satisfies the loader's registration protocol and requires nothing outside the module baseline. |

The schema-checked suites need an installed `@deepseek-ai/dsh-llm-pi-ai` to
compare against. `test/dsh-adapter.mjs` locates one from `DSH_PROFILE_DIR`,
`DSH_HOME`, or the usual `~/.dsh/profiles` layout; when none is reachable they
print a labelled `SKIP` and exit 0 instead of failing, so a contributor without
a DSH installation still gets a green run. Set `DSH_PI_AI_DIR` to point at an
unusual layout.

The last assertions in `conformance.mjs` are informative on purpose: the real schema **accepts** an empty wire value for a thinking level, because only the adapter's resolution step rejects it. That confirms the card's own validation is load-bearing rather than redundant.

## Limitations

- The card edits only `reasoningEfforts`, `input`, and `defaultInput`; the gateway import additionally writes each model's disclosed `name`, `contextWindow`, and `maxTokens` into the entry (showing the two capacities on the expanded row), but those capacities are not hand-editable here. Compat switches, edits to other model fields, and credentials stay with the shipped editor and `settings.yaml`.
- **Gateway import overwrites what you select.** For an existing model, every selected import replaces all five managed fields and clears any of them the gateway no longer discloses — that is the point of the overwrite, not a bug. Unselected rows and models the gateway does not return are never touched.
- Levels beyond the seven the schema accepts (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) are preserved on write but not offered for editing.
- Settings are stored in the user's `settings.yaml`; the card holds no state of its own.
- **Gateway import:** supports the `{"data":[…]}` and `{"models":{…}}` envelopes only, one listing page per attempt (no pagination), and only the `openai-completions`, `openai-responses`, and `anthropic-messages` protocols; anything else fails with a user-facing message.
- **Gateway import:** only the fields in the mapping table are translated. Magpie-only fields (service tiers, labels, pricing, `owned_by`, …) are ignored, and unsupported reasoning levels or modalities are skipped with warnings rather than approximated.
- **Gateway import:** in `modelOverrides` mode a gateway-only id cannot be imported (an override cannot introduce a catalog-unknown model); only already-shown ids are updated, and the status line counts the skipped new models.
- **Gateway import** never saves by itself and never writes settings from the Host route: the user confirms the selection, reviews the merged draft, and clicks 保存, after which the normal `configForms` transport validates it against the adapter.
- The API key stays on the Host: it is resolved from `apiKeyEnv` through the credentials service, used for one request header, and never returned, logged, or shown in an error message.
