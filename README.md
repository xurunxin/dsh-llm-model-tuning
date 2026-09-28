# dsh-llm-model-tuning

[![CI](https://github.com/xurunxin/dsh-llm-model-tuning/actions/workflows/ci.yml/badge.svg)](https://github.com/xurunxin/dsh-llm-model-tuning/actions/workflows/ci.yml)

Adds a per-model **reasoning-effort** and **multimodal input** editor to every custom provider card on the DeepSeek Harness **Settings → Models** page.

> **Requires dsh 0.1.7 or newer.** This card writes settings through the `configForms` service; the older `settingsScope` service was removed in 0.1.7. See [Requirements](#requirements).

The shipped provider editor deliberately ships no reasoning control: effort is a *per-model* capability, and the models under one provider disagree about it, so a provider-scoped control could only be set to a value some of them reject. This plugin takes the per-model granularity instead — it lists the route's own model entries and edits two fields on each:

| Field | Meaning |
| --- | --- |
| `reasoningEfforts` | Which effort levels the model offers, and the wire spelling each one sends. `false` declares a non-reasoning model; absent inherits the installed catalog. |
| `input` | Which request modalities the model accepts (`text`, `image`). Absent inherits the installed catalog. |

It also edits the route-level `defaultInput` fallback, which is what makes a gateway serving vision models the catalog does not describe usable.

Both fields are written into the `llm-pi-ai` settings section, so a change reaches the next request with no restart — the adapter resolves profiles per request.

## Why this is a client-side plugin

The whole contribution is one card on the `settings.models.provider-card` seat, keyed by the provider row's own settings namespace. Because every configurable pi-ai route declares `settingsNs: 'llm-pi-ai'`, a single registration under that key receives every custom-provider card — saved rows and the add-provider draft alike — without the Models section knowing anything about this plugin.

The host half is intentionally empty. It exists only so the profile row resolves to a real package, which is what makes `@deepseek-ai/dsh-client-modules` scan the `dsh.client` declaration and serve `lib/client.js` into the browser boot graph.

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

- **dsh 0.1.7 or newer.** This card reads and writes settings through the
  `configForms` service. The older `settingsScope` service was removed in 0.1.7,
  and a card still injecting it never activates — the row simply waits forever.
  `test/bundle-contract.mjs` guards against that regression.
- The `llm-pi-ai` adapter must be composed, since it owns the settings namespace
  this card edits. The card follows it with `configForms.whileServed`, so a
  deployment without that adapter shows no trace of this card rather than a dead
  panel.

## What the card does with your document

- **Edit surface.** The card reads and writes the *user* layer of the `llm-pi-ai` section. A route declared only in the composition base is read from the resolved value so it can still be tuned; writing it is what materializes it in the user layer.
- **Path-addressed writes.** Every edit travels as `settings.mutate` path ops against the stored section, so fields the card never rendered cannot be deleted. The namespace revision fences a stale card against a concurrent change.
- **`models` vs `modelOverrides`.** A `models` list *replaces* the installed catalog, while `modelOverrides` reshapes it. The adapter refuses both together, so the card edits whichever the profile already uses and offers to add `modelOverrides` entries when neither is present. A `models` list is an array — and the settings path-op walker refuses to descend through arrays — so that array is written as one value; a `modelOverrides` dict is addressed field by field.
- **Text is held on.** `input` and `defaultInput` replace a modality list rather than extending it, so declaring images alone would quietly drop text and leave a model the harness can no longer talk to. Text is therefore always kept, and clearing the last optional modality removes the field so the adapter's own default answers instead.
- **Refusals are named locally.** `ConfigFormController.mutate` reports whether the Host *accepted* a write, not which field it rejected. The card therefore reproduces the adapter's own `reasoningEfforts` rules (every level needs a wire spelling; only `off` may be empty; at least one level beyond `off`) so a refusal names the field, and it still reports a Host rejection as a failure rather than success.

## Tests

```sh
npm test
```

Four suites, all offline, no dependencies to install:

| Suite | What it proves |
| --- | --- |
| `test/harness.mjs` | The card's own behaviour, driven through its real inputs against a faithful settings-op simulator. Includes a rejection-never-reported-as-success case, and one proving nothing registers when the Host does not serve the namespace. |
| `test/integration.mjs` | The **exact section the card wrote** is accepted by the **real** `llm-pi-ai` `Config` schema. |
| `test/conformance.mjs` | Document shapes, and the refusals the card reproduces, checked against that same real schema. |
| `test/bundle-contract.mjs` | The bundle satisfies the loader's registration protocol and requires nothing outside the module baseline. |

The two schema-checked suites need an installed `@deepseek-ai/dsh-llm-pi-ai` to
compare against. `test/dsh-adapter.mjs` locates one from `DSH_PROFILE_DIR`,
`DSH_HOME`, or the usual `~/.dsh/profiles` layout; when none is reachable they
print a labelled `SKIP` and exit 0 instead of failing, so a contributor without
a DSH installation still gets a green run. Set `DSH_PI_AI_DIR` to point at an
unusual layout.

The last assertions in `conformance.mjs` are informative on purpose: the real schema **accepts** an empty wire value for a thinking level, because only the adapter's resolution step rejects it. That confirms the card's own validation is load-bearing rather than redundant.

## Limitations

- The card edits only `reasoningEfforts`, `input`, and `defaultInput`. Capacities, compat switches, and credentials stay with the shipped editor and `settings.yaml`.
- Levels beyond the seven the schema accepts (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) are preserved on write but not offered for editing.
- Settings are stored in the user's `settings.yaml`; the card holds no state of its own.
