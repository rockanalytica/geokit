# geokit

The UI system, three.js viewer layers and desktop Environment manager that
RockAnalytica's apps share. Apache-2.0, © RockAnalytica.

The kit names no domain from any app that uses it: no app's words, no app's
brand. Code flows into an app from here, never back from an app's own code.
Anything two apps need is written here.

| Part                                 | What it is                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui` (`@geokit/ui`)         | `tokens.css`: the design tokens, light and dark, as Tailwind 4 theme variables, with brand slots (`--gk-brand-*`) each app fills; `cn()` for class names.                                                                                                                                                                                                     |
| `packages/viewer` (`@geokit/viewer`) | three.js layers, framework-free: a COPC-style point cloud under a point budget, a mesh with its section crossing, the shared value shader (colormap LUTs, filters, class masks, missing values), GPU id-buffer picking, section planes and directions. The Viewer that draws them stays in each app.                                                          |
| `crates/geokit-env`                  | The desktop core's Environment manager, with no Tauri dependency: the list of Environments with a default, the programs it may start (a Python in an Environment, WSL's distributions and GPU), the steps that install an app's own Environment from its `Recipe` with uv (natively, or in WSL with no root), the processes it starts, and the **GPU Lease**. |

## Using it

Pin a tag. The TypeScript packages export their sources (no build step); an
app's bundler compiles them.

```jsonc
// package.json
"@geokit/ui": "github:rockanalytica/geokit#v0.1.0&path:packages/ui",
"@geokit/viewer": "github:rockanalytica/geokit#v0.1.0&path:packages/viewer"
```

```toml
# Cargo.toml
geokit-env = { git = "https://github.com/rockanalytica/geokit", tag = "v0.1.0" }
```

### Brand slots

```css
@import "@geokit/ui/tokens.css";
:root {
  --gk-brand-ink: #14142b;
  --gk-brand-primary: #5d69ff;
  --gk-brand-primary-hover: #7580ff;
  --gk-brand-primary-deep: #4550e6;
  --gk-brand-secondary: #80c6ff;
  --gk-brand-tertiary: #ba8eff;
  --gk-brand-pale: #e4d4ff;
}
```

Colours that mean something only in one app stay in that app's own tokens.

### An Environment of the app's own

```rust
use geokit_env::programs::{install_steps, Own, Recipe};

let recipe = Recipe {
    name: "engine".into(),           // its folder
    app: "my-app".into(),            // ~/.local/share/my-app in WSL
    python: "3.12".into(),
    lockfile: Some(lock_path),       // synced first: exactly these versions
    packages: vec![],                // installed after it
    wheels: vec![app_wheel],         // the app's own, last, without dependencies
    check: "import my_app; print(my_app.__version__)".into(),
};
let steps = install_steps(&Own::Wsl { distro: "Ubuntu".into() }, &shipped, &recipe, false)?;
```

With `Shipped::uv_linux` set, the WSL install needs no root and no apt;
without it, the distribution's own Python makes a venv.

### The GPU Lease

At most one GPU Job holds the GPU. A Job that must have it waits, first come
first served, told its place in the queue; one that would rather run on the
CPU than wait asks with `try_hold`. Started with `start_holding`, a Job keeps
the Lease until its program has ended.

```rust
let held = lease.hold("stereo", || cancelled.load(Relaxed), |place| tell_page(place));
if let Some(held) = held {
    processes.start_holding(&program, sink, held)?;
}
// a single prediction: the GPU if it is free now, else the CPU
let gpu = lease.try_hold("predict one");
```

## Checks

```
pnpm install
pnpm check                 # lint, typecheck, tests, domain gate, licence gate
cargo test                 # the Rust crate
cargo test -- --ignored    # real installs: see the ignored tests for their variables
```

`pnpm domain-gate` fails on any app's name or domain word in the sources.
`pnpm licence-gate` fails on any dependency that is not permissive
([LICENSES.md](LICENSES.md)).

Where each file came from is in [docs/provenance.md](docs/provenance.md).
