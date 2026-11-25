# Changelog

## Unreleased (0.2.0)

### geokit-env

New:

- `install`: `install`, `repair`, `uninstall` and `verify` (`Health`:
  Healthy, Stale, Broken). One call plans, runs, tells each `Progress::Step`,
  cancels, and records the Own Environment on the list.
- `detect`: WSL's distributions, conda's environments, the Pythons on the
  PATH. `wsl_distros` tells a failed `wsl --list` from an empty one.
- `process::Spawner`, with the system's own (`OsSpawner`: a Windows Job
  Object or a Posix process group per program, and the WSL side ended too)
  and `process::scripted::Scripted` for tests.
- `Problem { code, english, params }`, the one error.
- Logging through the `log` facade.

Breaking, with the migration:

- `programs::install_steps` is gone: call `install::install(&Request { .. }, ..)`.
  The version recorded is the last line the Recipe's check prints.
- Every `Result<_, String>` is `Result<_, Problem>`: match on `.code`.
- `Environment::problem()` returns `Option<Problem>` (codes `env.quote`,
  `env.cmd`, …), not a `&'static str`.
- `Environments::set_default` and `remove` take `&Environment`, not an index.
- An unreadable `environments.json` is moved to `environments.json.bad`
  (then `.bad.1`, …) and reported by `load_problem()`; a failed write rolls
  the list back.
- `Processes::kill` returns `()`. `start` and `start_holding` return
  `Receiver<Exit>`; `Said::Exit` has `how` (Ended, Killed, Lost).
- `process::output(p)` takes a timeout and returns `Captured` with the exit
  and stderr; a non-zero exit is no longer ignored.
- `wsl_path(path)` is `wsl_path(path, distro)`: a path in another
  distribution, or a drive-relative one, is refused.
- `wsl_gpu_probe("")` means WSL's default distribution, as `wsl("")` does.
- `Own::here()` returns `Result<(), Problem>`; `supported_on(Os)` is the
  pure check.
- `Program` has a field `linux`: build with `program()` or add `linux: None`.
- A `Recipe`'s `name` and `app` may not start with `.`.

### @geokit/viewer

New:

- `LayerHost`: the pick pass, its readback (`PickRead`, a seam for tests)
  and the Section for every layer; one `Layer` interface.
- `PointCloudLayer` is pickable to one point (`PickTarget` kind `point`:
  node, index, position) and clipped like the others.
- `BlockLayer`: instanced boxes, value-coloured, pickable, clipped.
- `clipBox`, `boxPlanes`, `sectionSpec`, `keeps`.
- `chooseNodes`: the Point Cloud's choice of nodes, pure.
- Colormaps `VIRIDIS`, `BLUE_ORANGE` (diverging), `CYCLE` (cyclic, its LUT
  wraps); `sampleColormap`, `symmetricRange`.
- `legend.ts`: `legendModel`, ticks, `gradientCss`, `buildLegend`.
- `measure.ts`: `measure`, `nearestVertex`, `MeasureLine`.
- `pickMaterial`, `encodePick` and the clipping chunks shared by all layers.
- Value shader limits as constants (`MAX_BREAKS`, `NO_CLASS_ABOVE`,
  `CONTINUOUS_LUT_SIZE`) and a TypeScript mirror of its rules
  (`valueColour`, `valueHidden`, `isMissing`).
- A playground (`pnpm --filter @geokit/viewer playground`) and an opt-in
  WebGL2 test of the shaders (`GEOKIT_BROWSER`).

Breaking, with the migration:

- `sectionDirection` and `directionAngles` are no longer exported from
  `@geokit/viewer/section`: import them from the root or `/direction`.
- `Pickable.enterPick(pass?)` and `resolvePick(id, detail?)`; `PickTarget`
  has a `point` kind: a `switch` on `kind` needs its case.
- `new PointCloudLayer(source, pickIds?, now?)`. `resident` counts decoded
  points. A node that fails is asked for again after 1 s, doubling to 30 s,
  and told to `onError`; one whose arrays do not match its count fails.
  Eviction keeps each Viewport's latest choice: pass a Viewport key to
  `apply` and call `forget` when a Viewport closes.
- `applyValue` and `valueUniforms` use the typed `ValueUniforms`.
- `Luts` finds colour arrays by identity first: pass a new array to change
  colours rather than changing one in place.
- `MeshLayer.setClip`; keeping what is outside a clip box needs
  `renderer.localClippingEnabled`, which `LayerHost.setSection` sets.
- `Vec3` and `dot` live in `types.ts` and `vec.ts`; `section.ts` still
  re-exports them.
- `directionAngles` gives a plunge of `0`, not `-0`, for a level direction.

### Tools

- The licence gate reads SPDX expressions as SPDX does (AND before OR,
  parentheses, `WITH`).
- The domain gate also reads `.html`, `.glsl` and `.md` files.
- The `notices` script, whose generator stayed with the apps, is removed.
