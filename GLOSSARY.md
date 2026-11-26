# geokit glossary

The kit's own words. Many come from the apps that use it, worded here with
no app's domain: an app's glossary may say more about how it uses them.
Code, comments and docs use these words and avoid the ones listed under
_Avoid_.

## Running work

**Environment**:
Where a Python runs on this computer: the machine (Windows itself, a WSL
distribution, or a Linux or macOS machine) and the Python on it, by path,
conda environment or the machine's default `python`. It belongs to the
computer, not to any document the app opens.
_Avoid_: runtime, interpreter, venv, backend

**Environment list**:
The Environments the user may choose from, with at most one **default**,
kept in the app's data folder. One that cannot be read is kept aside and
reported, never written over. Entries are named by the Environment itself,
never by their place in the list.
_Avoid_: registry, settings

**Own Environment**:
An Environment the app installs itself from its Recipe, in its data folder
or, in WSL, under `~/.local/share/<app>`. On the list it is marked as the
app's own, with the version its check printed when it was installed.
_Avoid_: managed environment, bundled Python

**Recipe**:
What an Own Environment holds: the Python version, a lockfile synced first,
packages installed after it, the app's own wheels last, and a **check**, a
line of Python whose last printed line is the version recorded.
_Avoid_: spec, manifest, requirements

**Shipped**:
What the app brings for an install: its data folder, uv, and optionally uv
for Linux, with which a WSL install needs no root.

**Install**:
Making an Own Environment from its Recipe, step by step, telling each
**Step** (i of n) and every line, stopping at the first that fails or when
cancelled. Nothing is put on the Environment list until the check passes.
**Repair** is an Install from nothing; **Uninstall** removes the Own
Environment's folder, then its entry, and never touches a Python the app
did not make.
_Avoid_: setup, provisioning, bootstrap

**Health**:
What **Verify** finds by running the Recipe's check: **Healthy** (the version
recorded), **Stale** (another version: something changed it) or **Broken**
(it does not start, or its check fails, with the Problem).

**Detect**:
Finding what the computer offers as Environments: WSL's distributions,
conda's environments, the Pythons on the PATH. It proposes; the user adds.

**Program**:
One command the kit may start: the program, its arguments, its environment
variables and, in WSL, the script run in the distribution. A Program is a
whole tree of processes, started together and ended together.
_Avoid_: command line, process (one OS process of the tree)

**Spawner**:
What starts a Program. The system's own starts real processes, each tree in
a Windows Job Object or a Posix process group; the **scripted** one plays
back lines and exits, for tests.

**Exit**:
How a Program ended: **Ended** by itself (with its code), **Killed** by the
app, or **Lost** (it could not be watched to its end).

**Job**:
One long-running piece of work the user starts and can cancel.
_Avoid_: task, process, run

**GPU Job**:
A Job that wants the GPU.

**GPU Lease**:
The single right to use the GPU, held by at most one GPU Job at a time and
given back only once that Job's Program, tree and all, has ended. Others
wait first come, first served, told their place; one that would rather run
on the CPU than wait asks without waiting. **Held** is the Lease while a Job
has it.
_Avoid_: GPU lock, mutex, semaphore

**Problem**:
What went wrong, as a stable code the page words in its own language, the
English, and named parameters. The same shape in Rust and TypeScript.
_Avoid_: error message, error string

## Viewing

**Viewer**:
An app's own drawing of its 3D scene: camera, controls and render loop. The
kit has none; it gives the Viewer layers and a layer host.

**Viewport**:
One camera onto the scene. Several may be open at once, each choosing what
it draws.
_Avoid_: view, panel, canvas

**Layer**:
One kind of thing drawn — a Point Cloud, a Mesh, Blocks — with what a
Viewport draws of it, and optionally picking, cutting and clipping.
_Avoid_: renderer, actor, drawable

**Layer host**:
What owns what the layers have in common, for a Viewer: which layers there
are, the pick ids, the pick pass and its readback, and the Section.
_Avoid_: scene manager, engine

**Pick**:
Choosing what is under the cursor: a layer, an id and what it names — a
Mesh, a Block, a single point of a Point Cloud. A pick is drawn in an id
pass, never by casting rays.
_Avoid_: select (a Selection is what an app keeps of picks), hit test, raycast

**Lasso**:
A freehand loop drawn on the screen, and the points whose projection falls
inside it, hidden or not, never those behind the camera. It reaches through
what is in front, as a pick does not.
_Avoid_: select (as for Pick), brush

**Mark**:
Drawing chosen points of a Point Cloud in one colour over their own: what
a Lasso took, or what an edit would take. Marks are the app's to set and
clear; the layer only draws them.
_Avoid_: highlight (that is one Frustum shown apart), selection

**Frustum**:
Where a camera stood and what it saw, drawn as a wireframe pyramid from the
camera to a base `size` ahead, with a dot at the camera. Camera axes are x
right, y down, z forward. One Frustum may be **highlighted**; a pick names
a Frustum by its index.
_Avoid_: camera gizmo, pose (that is where a scene camera goes to see as a Frustum did)

**Point Cloud**:
A large set of points read node by node from a COPC-style octree, under a
**point budget**: only the nodes a Viewport needs are **resident**. A node
that fails to load is **failed** and asked for again only after a wait.
_Avoid_: scan, LAS, cloud (alone)

**Mesh**:
A triangulated surface, drawn whole or, under a Section, as its
**crossing**: the line where the Section's plane cuts it.
_Avoid_: wireframe, TIN

**Block**:
A box at a centre, of a size, coloured by its value; a **Block layer** draws
many at once.
_Avoid_: voxel, cell

**Value view**:
How a layer's values are coloured: the Colormap, its range, log placement,
steps, classes shown, and the colour of a **missing value** (no value, drawn
in its own colour or left out). Values at or below zero under log placement
take the lowest colour.
_Avoid_: style, colour settings

**Colormap**:
A mapping from values or classes to colours: **sequential**, **diverging**
(about a centre), **cyclic** (its ends meet) or **categorical**.
_Avoid_: palette, ramp, colour scale, LUT (the texture made from it)

**Legend**:
The key to a Value view: a colour bar with ticks at round values, or a
swatch per class.
_Avoid_: key, scale bar (that measures length)

**Section**:
A clipping geometry a Viewport may adopt: a plane in any direction, or a
**clip box**. A plane faces a direction, the way it is looked at, so it has
a **Front**, the side the viewer stands on, and a **Behind**: a Viewport
keeps one, the other, or a **band** about the plane. Its **step** is the
spacing to the next Section of a series. A clip box keeps what is inside
it, or what is outside.
_Avoid_: slice, cut, profile

**Measurement**:
A line of points through the scene whose legs' lengths and directions
(azimuth and plunge, Z up, Y north) are read out. Not kept.
_Avoid_: ruler, tape

## The kit itself

**Brand slot**:
A `--gk-brand-*` token each app fills with its own colours. Colours that
mean something in one app only stay in that app.

**Domain gate**:
The check that no source in the kit names an app or its domain.

**Licence gate**:
The check that every dependency is permissive.
