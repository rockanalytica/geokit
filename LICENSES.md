# Dependency licences

geokit is Apache-2.0. An app that uses it may be closed and commercial, and
may accept only permissive dependencies, so the kit takes only permissive
ones: no GPL, LGPL, AGPL or MPL, in production or development.

`pnpm licence-gate` enforces it for the pnpm workspace and the Cargo
workspace. The allowed SPDX identifiers are in
`tools/licence-gate/allowlist.json`. A dependency that fails the gate is a
decision for the maintainer, who either pins it in
`tools/licence-gate/exceptions.json`, by exact `name@version` and with a
reason, or adds its licence to the allowlist. Only a permissive licence is
added, and only on the maintainer's yes; from then on it admits every
dependency under it, so it is a decision about the licence, not about one
package.

A licence on the allowlist may still ask for its notice to go with every
copy (Unicode-3.0, BSD, MIT): an app that compiles such a dependency into
what it ships keeps the notice in its own third-party notices.

Third-party notices for what an app ships are written by that app, which
knows what it bundles.
