# geokit — instructions for Claude

Shared, public, Apache-2.0 code for RockAnalytica's apps (GeoScape, which is
closed, and CloudLabeller, which is GPL-3). Read README.md first.

## Rules

- **No app's domain.** Nothing here names an app or its domain words
  (`pnpm domain-gate` lists them). Word comments and names generically.
- **One-way flow.** Code comes into the kit from GeoScape, by its copyright
  holder, or is written here. Never copy code into the kit from an app's own
  code that is not already published under a permissive licence — in
  particular nothing from CloudLabeller, which is GPL-3.
- **Permissive dependencies only** (LICENSES.md). A dependency that fails
  `pnpm licence-gate` is the maintainer's decision: pinned in
  `exceptions.json`, or its licence added to the allowlist. Never change
  either without the maintainer's yes for that licence or package.
- **Framework-free viewer.** `packages/viewer` imports no React.
- **No Tauri in the crate.** The app wraps `geokit-env` in its own commands.
- Keep `docs/provenance.md` current when something is taken from an app.

## Locked code and notes

The apps' conventions hold here too: never edit between `=== LOCKED ===`
markers or in a file marked `LOCKED FILE`; propose instead. `CLAUDE:`
comments are notes to Claude, handled and removed when resolved (kept when
they end with `(keep)`).

## Build / test

- `pnpm install`, then `pnpm check` (Biome, tsc, vitest, domain gate,
  licence gate). Windows host, PowerShell 5.1: no `&&`.
- `cargo test`; `cargo clippy --all-targets -- -D warnings`; `cargo fmt`.
- The ignored tests install real Environments: see their doc comments.
