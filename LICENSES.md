# Dependency licences

geokit is Apache-2.0. An app that uses it may be closed and commercial, and
may accept only permissive dependencies, so the kit takes only permissive
ones: no GPL, LGPL, AGPL or MPL, in production or development.

`pnpm licence-gate` enforces it for the pnpm workspace and the Cargo
workspace. The allowed SPDX identifiers are in
`tools/licence-gate/allowlist.json`. A dependency that fails the gate is a
decision for the maintainer: it is pinned in
`tools/licence-gate/exceptions.json`, by exact `name@version` and with a
reason, only on their yes. The allowlist is never widened to let one through.

Third-party notices for what an app ships are written by that app, which
knows what it bundles.
