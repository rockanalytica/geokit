# geokit

The UI system, three.js viewer layers and desktop Environment manager that
RockAnalytica's apps share. Apache-2.0, © RockAnalytica. Its words are in
[GLOSSARY.md](GLOSSARY.md); what changed between versions, in
[CHANGELOG.md](CHANGELOG.md).

The kit names no domain from any app that uses it: no app's words, no app's
brand. Code flows into an app from here, never back from an app's own code.
Anything two apps need is written here.

| Part                                 | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui` (`@geokit/ui`)         | `tokens.css`: the design tokens, light and dark, as Tailwind 4 theme variables, with brand slots (`--gk-brand-*`) each app fills; `cn()` for class names.                                                                                                                                                                                                                                                                                                                        |
| `packages/viewer` (`@geokit/viewer`) | three.js layers, framework-free: a COPC-style Point Cloud under a point budget (pickable to one point), a Mesh with its crossing under a Section, instanced Blocks, the shared value shader (colormap LUTs, filters, class masks, missing values), and the layer host, which owns the pick pass and the Section (planes, bands, clip boxes) for an app's own Viewer. Also colormaps, legends and measurement. The Viewer that draws them stays in each app.                      |
| `crates/geokit-env`                  | The desktop core's Environment manager, with no Tauri dependency: the Environment list with a default, finding what the computer offers, the programs it may start (a Python in an Environment, questions to WSL), installing, verifying, repairing and uninstalling an app's own Environment from its `Recipe` with uv (natively, or in WSL with no root), the processes it starts (each ended with its whole tree), and the **GPU Lease**. Errors are a `Problem` with a code. |

## Using it

Pin a tag. The TypeScript packages export their sources (no build step); an
app's bundler compiles them.

```jsonc
// package.json
"@geokit/ui": "github:rockanalytica/geokit#v0.3.0&path:packages/ui",
"@geokit/viewer": "github:rockanalytica/geokit#v0.3.0&path:packages/viewer"
```

```toml
# Cargo.toml
geokit-env = { git = "https://github.com/rockanalytica/geokit", tag = "v0.3.0" }
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
use geokit_env::install::{install, verify, Health, Request};
use geokit_env::programs::{Own, Recipe};

let recipe = Recipe {
    name: "engine".into(),           // its folder
    app: "my-app".into(),            // ~/.local/share/my-app in WSL
    python: "3.12".into(),
    lockfile: Some(lock_path),       // synced first: exactly these versions
    packages: vec![],                // installed after it
    wheels: vec![app_wheel],         // the app's own, last, without dependencies
    check: "import my_app; print(my_app.__version__)".into(),
};
let own = Own::Wsl { distro: "Ubuntu".into() };
let req = Request { own: &own, shipped: &shipped, recipe: &recipe, fresh: false };
// every step in order, each told with its lines; stops at the first that
// fails, or kills the running one when cancelled; then on the list as default
let kept = install(&req, &processes, &environments, tell_page, &|| cancelled.load(Relaxed))?;
if let Health::Broken { problem } = verify(&kept, &recipe, &processes, timeout) {
    // repair(&req, ...) makes it again from nothing
}
```

With `Shipped::uv_linux` set, the WSL install needs no root and no apt;
without it, the distribution's own Python makes a venv. `uninstall` removes
the folder and then the entry; `detect::detect` lists WSL's distributions,
conda's environments and the Pythons on the PATH for the page to offer.
Tests start no real process: `Processes::new(Arc::new(Scripted::...))`
plays back lines and exits (`process::scripted`).

### The GPU Lease

At most one GPU Job holds the GPU. A Job that must have it waits, first come
first served, told its place in the queue; one that would rather run on the
CPU than wait asks with `try_hold`. Started with `start_holding`, a Job keeps
the Lease until its program, with every process it started, has ended.

```rust
let held = lease.hold("stereo", || cancelled.load(Relaxed), |place| tell_page(place));
if let Some(held) = held {
    processes.start_holding(&program, sink, held)?;
}
// a single prediction: the GPU if it is free now, else the CPU
let gpu = lease.try_hold("predict one");
```

### The layer host

```ts
import { clipBox, LayerHost, PointCloudLayer, sectionSpec } from "@geokit/viewer";

const host = new LayerHost(renderer, scene); // the app's Viewer keeps camera and loop
const cloud = host.add(new PointCloudLayer(source, host.ids));
host.setSection(sectionSpec(geometry, "behind")); // or clipBox(bounds, "inside"), or null
// each frame, for each Viewport: cloud.apply(view, camera, heightPx, viewportKey)
const hit = host.pickAt(x, y, camera); // { layer, id, target } or null
```

`pnpm --filter @geokit/viewer playground` serves a page with a synthetic
Point Cloud, Mesh, Blocks, a Section and a legend: the first place the
shaders run.

## Checks

```
pnpm install
pnpm check                 # lint, typecheck, tests, domain gate, licence gate
cargo test                 # the Rust crate
cargo test -- --ignored    # real installs and WSL: see the ignored tests for their variables
```

`GEOKIT_BROWSER` set to a Chrome or Edge executable also compiles the
shaders in a real WebGL2 (`packages/viewer/src/shaders.gl.test.ts`).

`pnpm domain-gate` fails on any app's name or domain word in the sources.
`pnpm licence-gate` fails on any dependency that is not permissive
([LICENSES.md](LICENSES.md)).

Where each file came from is in [docs/provenance.md](docs/provenance.md).
