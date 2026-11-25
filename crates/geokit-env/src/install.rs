// Making the app's own Environment from its `Recipe`, and keeping it well:
// one call to install it, one to check it, one to take it away. An app does
// not sequence programs itself. `install` plans the steps, runs them in
// order, tells each one and every line it says, stops at the first that
// fails, ends the running one when it is cancelled, clears the folder first
// when it is to be made afresh (the same on every system), and puts the
// Environment on the list only once its check has passed, with the version
// that check printed. Repairing one is installing it afresh.
//
// The steps run through `Processes`, so tests give it a scripted Spawner.

use crate::envs::{Environment, Environments, Kept, List, Python};
use crate::problem::Problem;
use crate::process::{Exit, Processes, Said, Sink};
use crate::programs::{
    distro_ok, own_environment, own_folder, program, python, sh, wsl, wsl_cache, wsl_path,
    wsl_share, Os, Own, Program, Recipe, Shipped, PY_FLAGS,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What one step does.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Run(Program),
    /// A folder removed, with all in it; one that is not there is fine.
    RemoveFolder(String),
}

/// One step of an install, and what it is for, as a code the page words:
/// `remove`, `python`, `venv`, `lockfile`, `packages`, `wheels`, `check`, or
/// `wsl` for the one script that does it all in WSL.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub what: &'static str,
    pub action: Action,
}

fn run(what: &'static str, p: Program) -> Step {
    Step {
        what,
        action: Action::Run(p),
    }
}

/// What an install, or an uninstall, tells as it goes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Progress {
    /// Step `i` of `n` (from 1) begins.
    Step {
        i: usize,
        n: usize,
        what: String,
    },
    Out {
        line: String,
    },
    Err {
        line: String,
    },
}

/// Where progress goes. It answers whether anyone still hears.
pub type Events = Arc<dyn Fn(Progress) -> bool + Send + Sync>;

/// What is installed, where, and whether it starts from nothing.
#[derive(Clone, Copy)]
pub struct Request<'a> {
    pub own: &'a Own,
    pub shipped: &'a Shipped,
    pub recipe: &'a Recipe,
    /// Made again from nothing, rather than upgraded in place.
    pub fresh: bool,
}

/// The steps that install the app's own Environment, in order, for this
/// computer's system: see `plan_on`.
pub fn plan(req: &Request) -> Result<Vec<Step>, Problem> {
    plan_on(Os::this(), req)
}

/// The steps that install the app's own Environment on a computer of kind
/// `os`, in order. Natively, uv makes it all — its own Python in the app's
/// data folder, a venv, the lockfile, the packages, the wheels — then the
/// check runs. In WSL it is one script: with uv for Linux shipped, the same
/// steps with no root or apt; without it, the distribution's own Python makes
/// a venv and pip fills it. Run on one made before, they upgrade it in
/// place; `fresh`, its folder is removed first (natively a step of its own,
/// in WSL a line of the script). Nothing is run here, so this can be built,
/// and tested, on any system.
pub fn plan_on(os: Os, req: &Request) -> Result<Vec<Step>, Problem> {
    let Request {
        own,
        shipped: s,
        recipe: r,
        fresh,
    } = *req;
    if let Some(why) = r.problem() {
        return Err(why);
    }
    own.supported_on(os)?;
    if own.native() && s.data.trim().is_empty() {
        return Err(Problem::new(
            "install.data",
            "The app's data folder is not named.",
        ));
    }
    let dir = own_folder(own, &s.data, r);
    let v = r.python.as_str();
    match own {
        Own::Windows | Own::Posix => {
            let win = *own == Own::Windows;
            let at = |name: &str| {
                if win {
                    format!(r"{}\{name}", s.data)
                } else {
                    format!("{}/{name}", s.data)
                }
            };
            let mut env = HashMap::new();
            env.insert("UV_PYTHON_INSTALL_DIR".to_string(), at("python"));
            env.insert("UV_CACHE_DIR".to_string(), at("cache"));
            // the user's own uv settings have no say in what the app makes
            env.insert("UV_NO_CONFIG".to_string(), "1".into());
            env.insert("PYTHONIOENCODING".to_string(), "utf-8".into());
            let py = match own_environment(own, &s.data, r).python {
                Python::Path { path } => path,
                _ => unreachable!("the app's own is a Python by path"),
            };
            let uv = |args: &[&str]| Program {
                env: env.clone(),
                ..program(&s.uv, args)
            };
            // the app's own Python: put on no PATH, registered nowhere in Windows
            let mut python_install = vec!["python", "install", v, "--no-bin"];
            if win {
                python_install.push("--no-registry");
            }
            let mut steps = vec![];
            if fresh {
                steps.push(Step {
                    what: "remove",
                    action: Action::RemoveFolder(dir.clone()),
                });
            }
            steps.push(run("python", uv(&python_install)));
            steps.push(run(
                "venv",
                uv(&[
                    "venv",
                    &dir,
                    "--python",
                    v,
                    "--python-preference",
                    "only-managed",
                    "--allow-existing",
                ]),
            ));
            if let Some(lock) = &r.lockfile {
                steps.push(run("lockfile", uv(&["pip", "sync", "--python", &py, lock])));
            }
            if !r.packages.is_empty() {
                let mut a = vec!["pip", "install", "--python", &py];
                a.extend(r.packages.iter().map(String::as_str));
                steps.push(run("packages", uv(&a)));
            }
            if !r.wheels.is_empty() {
                let mut a = vec![
                    "pip",
                    "install",
                    "--python",
                    &py,
                    "--reinstall",
                    "--no-deps",
                ];
                a.extend(r.wheels.iter().map(String::as_str));
                steps.push(run("wheels", uv(&a)));
            }
            let mut check = program(
                &py,
                &[PY_FLAGS[0], PY_FLAGS[1], PY_FLAGS[2], "-c", &r.check],
            );
            check.env.insert("PYTHONIOENCODING".into(), "utf-8".into());
            steps.push(run("check", check));
            Ok(steps)
        }
        Own::Wsl { distro } => {
            distro_ok(distro)?;
            let lock = r
                .lockfile
                .as_deref()
                .map(|l| wsl_path(l, distro))
                .transpose()?;
            let wheels = r
                .wheels
                .iter()
                .map(|w| wsl_path(w, distro).map(|p| sh(&p)))
                .collect::<Result<Vec<_>, _>>()?
                .join(" ");
            let packages = r
                .packages
                .iter()
                .map(|p| sh(p))
                .collect::<Vec<_>>()
                .join(" ");
            let share = wsl_share(&r.app, "$HOME");
            let py = "\"$D/bin/python\"";
            let mut script = vec![
                "set -u".to_string(),
                r#"fail() { echo "$1" >&2; exit 1; }"#.to_string(),
                format!(r#"D="{share}/{}""#, r.name),
                if fresh {
                    r#"rm -rf "$D""#.to_string()
                } else {
                    ":".to_string()
                },
            ];
            match &s.uv_linux {
                Some(uv) => {
                    script.extend([
                        format!(r#"UV={}"#, sh(&wsl_path(uv, distro)?)),
                        format!(r#"export UV_PYTHON_INSTALL_DIR="{share}/python""#),
                        format!(r#"export UV_CACHE_DIR="{}""#, wsl_cache(&r.app, "$HOME")),
                        "export UV_NO_CONFIG=1".to_string(),
                        format!(r#""$UV" python install {v} --no-bin || fail "Python {v} could not be installed.""#),
                        format!(r#""$UV" venv "$D" --python {v} --python-preference only-managed --allow-existing || fail "The venv could not be made.""#),
                    ]);
                    if let Some(lock) = &lock {
                        script.push(format!(r#""$UV" pip sync --python {py} {} || fail "The locked packages could not be installed.""#, sh(lock)));
                    }
                    if !packages.is_empty() {
                        script.push(format!(r#""$UV" pip install --python {py} {packages} || fail "The packages could not be installed.""#));
                    }
                    if !wheels.is_empty() {
                        script.push(format!(r#""$UV" pip install --python {py} --reinstall --no-deps {wheels} || fail "The app's own wheels could not be installed.""#));
                    }
                }
                None => {
                    script.extend([
                        format!(r#"PY="$(command -v python{v} || true)""#),
                        format!(r#"[ -n "$PY" ] || fail "No Python {v} in this distribution. On Ubuntu: sudo apt install python{v} python{v}-venv""#),
                        // made before, it is kept; half made by a run that stopped, it is made again
                        format!(r#""$D/bin/python" -m pip --version >/dev/null 2>&1 || {{ rm -rf "$D"; mkdir -p "$(dirname "$D")"; "$PY" -m venv "$D"; }} || fail "The venv could not be made. On Ubuntu: sudo apt install python{v}-venv""#),
                        format!(r#"{py} -m pip install --upgrade pip || fail "pip could not be updated.""#),
                    ]);
                    if let Some(lock) = &lock {
                        script.push(format!(r#"{py} -m pip install -r {} || fail "The locked packages could not be installed.""#, sh(lock)));
                    }
                    if !packages.is_empty() {
                        script.push(format!(r#"{py} -m pip install {packages} || fail "The packages could not be installed.""#));
                    }
                    if !wheels.is_empty() {
                        script.push(format!(r#"{py} -m pip install --force-reinstall --no-deps {wheels} || fail "The app's own wheels could not be installed.""#));
                    }
                }
            }
            script.push(format!(
                r#"{py} -I -X utf8 -c {} || fail "The Environment is not what the app needs.""#,
                sh(&r.check)
            ));
            let mut p = wsl(distro, &script.join("\n"));
            p.env.insert("PYTHONIOENCODING".into(), "utf-8".into());
            Ok(vec![run("wsl", p)])
        }
    }
}

/// How often a running step is asked whether it has been cancelled.
const LOOK: Duration = Duration::from_millis(50);

/// What a step said and what became of it.
struct Done {
    out: Vec<String>,
}

fn tail(lines: &[String]) -> String {
    let from = lines.len().saturating_sub(5);
    lines[from..].join("\n")
}

/// `steps` run in order. Stops at the first that fails or when `cancel` says
/// so (the running step is killed, with its tree); the lines of the last step
/// are what it returns.
fn run_steps(
    steps: &[Step],
    procs: &Processes,
    events: &Events,
    cancel: &dyn Fn() -> bool,
) -> Result<Done, Problem> {
    let n = steps.len();
    let mut last = Done { out: vec![] };
    for (i, step) in steps.iter().enumerate() {
        let cancelled = || Problem::new("install.cancelled", "The install was cancelled.");
        if cancel() {
            return Err(cancelled());
        }
        log::info!("install step {} of {n}: {}", i + 1, step.what);
        events(Progress::Step {
            i: i + 1,
            n,
            what: step.what.into(),
        });
        let failed = |why: Problem| {
            why.with("step", i + 1)
                .with("steps", n)
                .with("what", step.what)
        };
        let p = match &step.action {
            Action::RemoveFolder(dir) => {
                match std::fs::remove_dir_all(dir) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(failed(
                            Problem::new("install.remove", "A folder could not be removed.")
                                .with("path", dir.clone())
                                .because(e),
                        ))
                    }
                }
                last = Done { out: vec![] };
                continue;
            }
            Action::Run(p) => p,
        };
        #[derive(Default)]
        struct Heard {
            out: Vec<String>,
            err: Vec<String>,
        }
        let heard = Arc::new(Mutex::new(Heard::default()));
        let (h, ev) = (heard.clone(), events.clone());
        let sink: Sink = Arc::new(move |said| {
            let mut h = crate::locked(&h);
            match said {
                Said::Out { line } => {
                    h.out.push(line.clone());
                    ev(Progress::Out { line });
                }
                Said::Err { line } => {
                    h.err.push(line.clone());
                    ev(Progress::Err { line });
                }
                Said::Exit { .. } => {}
            }
            true
        });
        let (id, ended) = procs.start(p, sink).map_err(failed)?;
        let exit: Exit = loop {
            match ended.recv_timeout(LOOK) {
                Ok(e) => break e,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if cancel() {
                        procs.kill(id);
                        let _ = ended.recv_timeout(Duration::from_secs(30));
                        return Err(cancelled());
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(failed(Problem::new(
                        "install.lost",
                        "A step of the install was lost.",
                    )))
                }
            }
        };
        let h = crate::locked(&heard);
        if !exit.success() {
            let said = if h.err.is_empty() { &h.out } else { &h.err };
            return Err(failed(
                Problem::new("install.step_failed", "A step of the install failed.")
                    .with("code", exit.code.map_or(-1, i64::from))
                    .with("output", tail(said)),
            ));
        }
        last = Done { out: h.out.clone() };
    }
    Ok(last)
}

/// The last line a check printed: the version it names.
fn version_of(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .rev()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(str::to_owned)
}

/// The app's own Environment installed from the Recipe, and put on the list
/// as the default (in place of the one it made before on that machine, whose
/// folder is left) with the version its check printed. The check's last line
/// of output is that version.
///
/// Tells each step and every line to `events`; stops at the first step that
/// fails, with a Problem naming it; stops, killing the running step and its
/// tree, when `cancel` says so (`install.cancelled`). Nothing is put on the
/// list unless every step, the check last, has passed.
pub fn install(
    req: &Request,
    procs: &Processes,
    envs: &Environments,
    events: Events,
    cancel: &dyn Fn() -> bool,
) -> Result<Kept, Problem> {
    install_on(Os::this(), req, procs, envs, events, cancel)
}

pub(crate) fn install_on(
    os: Os,
    req: &Request,
    procs: &Processes,
    envs: &Environments,
    events: Events,
    cancel: &dyn Fn() -> bool,
) -> Result<Kept, Problem> {
    let steps = plan_on(os, req)?;
    let done = run_steps(&steps, procs, &events, cancel)?;
    let version = version_of(&done.out).ok_or_else(|| {
        Problem::new(
            "install.no_version",
            "The check printed nothing, so there is no version to record.",
        )
    })?;
    let env = own_environment(req.own, &req.shipped.data, req.recipe);
    envs.add_own(&env, &version)?;
    envs.get(&env)
        .ok_or_else(|| Problem::new("env.not_listed", "That Environment is not on the list."))
}

/// An install made again from nothing: what to do with one that is `Broken`.
pub fn repair(
    req: &Request,
    procs: &Processes,
    envs: &Environments,
    events: Events,
    cancel: &dyn Fn() -> bool,
) -> Result<Kept, Problem> {
    install(
        &Request {
            fresh: true,
            ..*req
        },
        procs,
        envs,
        events,
        cancel,
    )
}

/// The app's own Environment taken away: its folder removed (natively), or
/// its directory in WSL (by a step run in the distribution), and then its
/// entry on the list. Only one the app made (`own` on the list, or not on the
/// list at all) is removed: the user's own Pythons are never touched.
pub fn uninstall(
    own: &Own,
    data: &str,
    recipe: &Recipe,
    procs: &Processes,
    envs: &Environments,
    events: Events,
    cancel: &dyn Fn() -> bool,
) -> Result<List, Problem> {
    uninstall_on(Os::this(), own, data, recipe, procs, envs, events, cancel)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn uninstall_on(
    os: Os,
    own: &Own,
    data: &str,
    recipe: &Recipe,
    procs: &Processes,
    envs: &Environments,
    events: Events,
    cancel: &dyn Fn() -> bool,
) -> Result<List, Problem> {
    if let Some(why) = recipe.problem() {
        return Err(why);
    }
    own.supported_on(os)?;
    let env: Environment = own_environment(own, data, recipe);
    if envs.get(&env).is_some_and(|k| !k.own) {
        return Err(Problem::new(
            "install.not_own",
            "That Environment was not made by the app, so the app does not remove it.",
        ));
    }
    let step = match own {
        Own::Wsl { distro } => {
            distro_ok(distro)?;
            let script = format!(
                r#"rm -rf "{}/{}""#,
                wsl_share(&recipe.app, "$HOME"),
                recipe.name
            );
            run("remove", wsl(distro, &script))
        }
        _ => {
            if data.trim().is_empty() {
                return Err(Problem::new(
                    "install.data",
                    "The app's data folder is not named.",
                ));
            }
            Step {
                what: "remove",
                action: Action::RemoveFolder(own_folder(own, data, recipe)),
            }
        }
    };
    run_steps(&[step], procs, &events, cancel)?;
    match envs.remove(&env) {
        Ok(l) => Ok(l),
        // the folder was there, the entry not: nothing more to forget
        Err(e) if e.code == "env.not_listed" => Ok(envs.list()),
        Err(e) => Err(e),
    }
}

/// How an Environment is.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Health {
    /// Its check passes and prints the version that was recorded.
    Healthy,
    /// Its check passes, and prints another version than the one recorded:
    /// something changed it since the app installed it.
    Stale,
    /// It cannot be started, or its check fails or takes too long.
    Broken { problem: Problem },
}

/// Runs the Recipe's check in `kept`'s Python and compares what it printed
/// (its last line) with the version recorded on `kept`. A repair is
/// `repair`.
pub fn verify(kept: &Kept, recipe: &Recipe, procs: &Processes, timeout: Duration) -> Health {
    let broken = |problem: Problem| Health::Broken { problem };
    if let Some(why) = recipe.problem() {
        return broken(why);
    }
    let p = match python(&kept.environment, &["-c", &recipe.check]) {
        Ok(p) => p,
        Err(e) => return broken(e),
    };
    let c = match procs.output(&p, timeout) {
        Ok(c) => c,
        Err(e) => return broken(e),
    };
    if !c.success() {
        let said = if c.stderr.is_empty() {
            &c.lines
        } else {
            &c.stderr
        };
        return broken(
            Problem::new("install.check_failed", "The Environment's check failed.")
                .with("code", c.exit.code.map_or(-1, i64::from))
                .with("output", tail(said)),
        );
    }
    match (version_of(&c.lines), kept.installed.as_deref()) {
        (Some(now), Some(then)) if now != then => Health::Stale,
        _ => Health::Healthy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envs::Machine;
    use crate::process::scripted::{Script, Scripted};
    use crate::process::Processes;
    use crate::programs::tests::recipe;
    #[cfg(windows)]
    use crate::programs::DEFAULT_PYTHON;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn shipped() -> Shipped {
        Shipped {
            data: r"C:\Users\Ítalo\AppData\Local\com.example.app".into(),
            uv: r"C:\Program Files\App\uv\uv.exe".into(),
            uv_linux: None,
        }
    }

    fn req<'a>(own: &'a Own, s: &'a Shipped, r: &'a Recipe, fresh: bool) -> Request<'a> {
        Request {
            own,
            shipped: s,
            recipe: r,
            fresh,
        }
    }

    fn events() -> (Events, Arc<Mutex<Vec<Progress>>>) {
        let all = Arc::new(Mutex::new(vec![]));
        let a = all.clone();
        let ev: Events = Arc::new(move |p| {
            crate::locked(&a).push(p);
            true
        });
        (ev, all)
    }

    fn never() -> bool {
        false
    }

    fn programs(steps: &[Step]) -> Vec<&Program> {
        steps
            .iter()
            .filter_map(|s| match &s.action {
                Action::Run(p) => Some(p),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_install_steps_on_windows() {
        let (r, s) = (recipe(), shipped());
        let steps = plan_on(Os::Windows, &req(&Own::Windows, &s, &r, false)).unwrap();
        let what: Vec<_> = steps.iter().map(|s| s.what).collect();
        assert_eq!(
            what,
            ["python", "venv", "lockfile", "packages", "wheels", "check"]
        );
        let ps = programs(&steps);
        assert!(ps[..5]
            .iter()
            .all(|p| p.program == s.uv && p.env["UV_NO_CONFIG"] == "1"));
        assert_eq!(
            ps[0].args,
            ["python", "install", "3.12", "--no-bin", "--no-registry"]
        );
        let dir = r"C:\Users\Ítalo\AppData\Local\com.example.app\environments\engine";
        assert_eq!(ps[1].args[1], dir);
        let py = format!(r"{dir}\Scripts\python.exe");
        assert_eq!(
            ps[2].args,
            [
                "pip",
                "sync",
                "--python",
                &py,
                r"C:\Program Files\App\env\pylock.txt"
            ]
        );
        assert_eq!(ps[3].args.last().unwrap(), "numpy>=2");
        assert_eq!(&ps[4].args[4..6], ["--reinstall", "--no-deps"]);
        assert_eq!(ps[5].program, py);
        assert_eq!(ps[5].args.last().unwrap(), &r.check);
        // only what a Recipe asks for
        let bare = Recipe {
            lockfile: None,
            packages: vec![],
            wheels: vec![],
            ..r.clone()
        };
        assert_eq!(
            plan_on(Os::Windows, &req(&Own::Windows, &s, &bare, false))
                .unwrap()
                .len(),
            3
        );
        let bad = Recipe {
            python: "x".into(),
            ..r
        };
        assert!(plan_on(Os::Windows, &req(&Own::Windows, &s, &bad, false)).is_err());
    }

    #[test]
    fn fresh_is_a_step_of_its_own_natively() {
        let (r, s) = (recipe(), shipped());
        let steps = plan_on(Os::Windows, &req(&Own::Windows, &s, &r, true)).unwrap();
        assert_eq!(steps[0].what, "remove");
        assert_eq!(
            steps[0].action,
            Action::RemoveFolder(
                r"C:\Users\Ítalo\AppData\Local\com.example.app\environments\engine".into()
            )
        );
        assert_eq!(steps.len(), 7);
        // and nothing is removed when it is not asked for
        let steps = plan_on(Os::Windows, &req(&Own::Windows, &s, &r, false)).unwrap();
        assert!(steps.iter().all(|s| s.what != "remove"));
        let none = Shipped {
            data: " ".into(),
            ..shipped()
        };
        let e = plan_on(Os::Windows, &req(&Own::Windows, &none, &r, true)).unwrap_err();
        assert_eq!(e.code, "install.data");
    }

    #[test]
    fn the_install_steps_on_macos_and_linux() {
        let s = Shipped {
            data: "/home/u/.local/share/com.example.app".into(),
            uv: "/opt/App/uv/uv".into(),
            uv_linux: None,
        };
        let r = Recipe {
            lockfile: Some("/opt/App/env/pylock.txt".into()),
            wheels: vec!["/opt/App/wheels/app-1.0-py3-none-any.whl".into()],
            ..recipe()
        };
        let steps = plan_on(Os::Posix, &req(&Own::Posix, &s, &r, false)).unwrap();
        let ps = programs(&steps);
        assert_eq!(ps.len(), 6);
        assert_eq!(ps[0].args, ["python", "install", "3.12", "--no-bin"]);
        let dir = "/home/u/.local/share/com.example.app/environments/engine";
        assert_eq!(ps[1].args[1], dir);
        assert_eq!(
            ps[0].env["UV_PYTHON_INSTALL_DIR"],
            "/home/u/.local/share/com.example.app/python"
        );
        assert_eq!(ps[5].program, format!("{dir}/bin/python"));
        assert_eq!(
            own_environment(&Own::Posix, &s.data, &r).machine,
            Machine::Posix
        );
        // not a system that can have it
        assert!(plan_on(Os::Windows, &req(&Own::Posix, &s, &r, false)).is_err());
        assert!(plan_on(Os::Posix, &req(&Own::Windows, &s, &r, false)).is_err());
    }

    fn wsl_own() -> Own {
        Own::Wsl {
            distro: "Ubuntu".into(),
        }
    }

    fn wsl_script(s: &Shipped, r: &Recipe, fresh: bool) -> String {
        let own = wsl_own();
        let steps = plan_on(Os::Windows, &req(&own, s, r, fresh)).unwrap();
        assert_eq!(steps.len(), 1);
        programs(&steps)[0].linux.clone().unwrap().script
    }

    #[test]
    fn the_install_in_wsl_with_uv_needs_no_root() {
        let own = wsl_own();
        let s = Shipped {
            uv_linux: Some(r"C:\Program Files\App\uv\linux\uv".into()),
            ..shipped()
        };
        let steps = plan_on(Os::Windows, &req(&own, &s, &recipe(), false)).unwrap();
        let p = programs(&steps)[0].clone();
        assert_eq!(&p.args[..2], ["-d", "Ubuntu"]);
        let script = &p.args[5];
        assert!(script.contains(r#"D="$HOME/.local/share/example-app/engine""#));
        assert!(script.contains(r#"UV_PYTHON_INSTALL_DIR="$HOME/.local/share/example-app/python""#));
        assert!(script.contains(r#"UV_CACHE_DIR="$HOME/.cache/example-app/uv""#));
        assert!(script.contains("UV='/mnt/c/Program Files/App/uv/linux/uv'"));
        assert!(script.contains(r#""$UV" python install 3.12 --no-bin"#));
        assert!(script.contains(
            r#""$UV" pip sync --python "$D/bin/python" '/mnt/c/Program Files/App/env/pylock.txt'"#
        ));
        assert!(script.contains("'numpy>=2'"));
        assert!(script.contains("'/mnt/c/Program Files/App/wheels/app-1.0-py3-none-any.whl'"));
        assert!(!script.contains("sudo") && !script.contains("apt "));
        assert!(script.ends_with(r#"|| fail "The Environment is not what the app needs.""#));
        // one venv, upgraded in place; fresh, made again
        assert!(!script.contains("\nrm -rf \"$D\"\n"));
        assert!(wsl_script(&s, &recipe(), true).contains("\nrm -rf \"$D\"\n"));
        assert_eq!(
            own_environment(&own, &s.data, &recipe()).python,
            Python::Path {
                path: "~/.local/share/example-app/engine/bin/python".into()
            }
        );
        let bad = Own::Wsl {
            distro: "a b".into(),
        };
        assert!(plan_on(Os::Windows, &req(&bad, &s, &recipe(), false)).is_err());
    }

    #[test]
    fn the_install_in_wsl_without_uv_uses_the_distributions_python() {
        let script = wsl_script(&shipped(), &recipe(), false);
        assert!(script.contains(r#"PY="$(command -v python3.12 || true)""#));
        assert!(script.contains(
            r#""$D/bin/python" -m pip install -r '/mnt/c/Program Files/App/env/pylock.txt'"#
        ));
        assert!(script.contains("--force-reinstall --no-deps"));
        assert!(!script.contains("$UV"));
    }

    #[test]
    fn a_file_in_another_distribution_is_not_given_to_wsl() {
        let r = Recipe {
            lockfile: Some(r"\\wsl.localhost\Debian\home\me\pylock.txt".into()),
            ..recipe()
        };
        let own = wsl_own();
        let e = plan_on(Os::Windows, &req(&own, &shipped(), &r, false)).unwrap_err();
        assert_eq!(e.code, "wsl.other_distro");
    }

    #[test]
    fn the_generated_wsl_scripts_are_valid_bash() {
        // bash reads the script from its input, not from an argument, so a
        // launcher in between cannot change its quoting
        use std::io::Write;
        use std::process::{Command, Stdio};
        if !matches!(
            Command::new("bash")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
            Ok(s) if s.success()
        ) {
            return; // no bash here
        }
        let with_uv = Shipped {
            uv_linux: Some(r"C:\Program Files\App\uv\linux\uv".into()),
            ..shipped()
        };
        let bare = Recipe {
            lockfile: None,
            packages: vec![],
            wheels: vec![],
            check: "print('it\\'s')".into(),
            ..recipe()
        };
        let mut scripts = vec![];
        for s in [&shipped(), &with_uv] {
            for r in [&recipe(), &bare] {
                for fresh in [false, true] {
                    scripts.push(wsl_script(s, r, fresh));
                }
            }
        }
        scripts.push(
            python(
                &Environment {
                    machine: Machine::Wsl,
                    distro: "Ubuntu".into(),
                    python: Python::Conda {
                        name: "tools".into(),
                    },
                },
                &["-c", "print('x')"],
            )
            .unwrap()
            .linux
            .unwrap()
            .script,
        );
        for script in scripts {
            let mut child = Command::new("bash")
                .arg("-n")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(script.as_bytes())
                .unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(
                out.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&out.stderr),
                script
            );
        }
    }

    // What an install is run on in these tests: this system's own kind, so
    // that a folder removed is a real one.
    fn here_own() -> Own {
        if cfg!(windows) {
            Own::Windows
        } else {
            Own::Posix
        }
    }

    fn setup(
        script: impl Fn(&Program) -> Script + Send + Sync + 'static,
    ) -> (Processes, Arc<Scripted>) {
        let sp = Arc::new(Scripted::new(script));
        (Processes::new(sp.clone()), sp)
    }

    fn data_in(dir: &tempfile::TempDir) -> Shipped {
        Shipped {
            data: dir.path().to_string_lossy().into_owned(),
            uv: "uv".into(),
            uv_linux: None,
        }
    }

    #[test]
    fn installs_in_order_tells_every_step_and_records_the_version() {
        let dir = tempfile::tempdir().unwrap();
        let (s, r, own) = (data_in(&dir), recipe(), here_own());
        let (ps, sp) = setup(|_| Script::ok().says("working").says("1.17.0"));
        let envs = Environments::in_memory();
        let (ev, all) = events();
        let kept = install_on(
            Os::this(),
            &req(&own, &s, &r, false),
            &ps,
            &envs,
            ev,
            &never,
        )
        .unwrap();
        let planned = plan_on(Os::this(), &req(&own, &s, &r, false)).unwrap();
        let want: Vec<Program> = programs(&planned).into_iter().cloned().collect();
        assert_eq!(sp.spawned(), want);
        assert_eq!(kept.installed.as_deref(), Some("1.17.0"));
        assert!(kept.own);
        assert_eq!(kept.environment, own_environment(&own, &s.data, &r));
        assert_eq!(envs.default_environment(), Some(kept.environment.clone()));
        let all = crate::locked(&all);
        let steps: Vec<_> = all
            .iter()
            .filter_map(|p| match p {
                Progress::Step { i, n, what } => Some((*i, *n, what.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(steps.len(), 6);
        assert_eq!(steps[0], (1, 6, "python"));
        assert_eq!(steps[5], (6, 6, "check"));
        assert_eq!(
            all.iter()
                .filter(|p| matches!(p, Progress::Out { line } if line == "working"))
                .count(),
            6
        );
    }

    #[test]
    fn stops_at_the_first_step_that_fails_and_records_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (s, r, own) = (data_in(&dir), recipe(), here_own());
        let sp = Arc::new(Scripted::queue(vec![
            Script::ok(),
            Script::ok().says("fine"),
            Script::ok().complains("no matching version").exits(2),
        ]));
        let ps = Processes::new(sp.clone());
        let envs = Environments::in_memory();
        let (ev, all) = events();
        let e = install_on(
            Os::this(),
            &req(&own, &s, &r, false),
            &ps,
            &envs,
            ev,
            &never,
        )
        .unwrap_err();
        assert_eq!(e.code, "install.step_failed");
        assert_eq!(e.params["step"], 3.into());
        assert_eq!(e.params["what"], "lockfile".into());
        assert_eq!(e.params["code"], 2.into());
        assert_eq!(e.params["output"], "no matching version".into());
        assert_eq!(sp.spawned().len(), 3, "the steps after it never started");
        assert!(envs.list().environments.is_empty());
        assert!(crate::locked(&all)
            .iter()
            .any(|p| matches!(p, Progress::Err { line } if line == "no matching version")));
    }

    #[test]
    fn a_step_that_cannot_start_is_a_failed_install() {
        let dir = tempfile::tempdir().unwrap();
        let (s, r, own) = (data_in(&dir), recipe(), here_own());
        let sp = Arc::new(Scripted::always(Script::cannot_start(Problem::new(
            "process.spawn",
            "no uv",
        ))));
        let ps = Processes::new(sp);
        let (ev, _) = events();
        let e = install_on(
            Os::this(),
            &req(&own, &s, &r, false),
            &ps,
            &Environments::in_memory(),
            ev,
            &never,
        )
        .unwrap_err();
        assert_eq!(e.code, "process.spawn");
        assert_eq!(e.params["step"], 1.into());
    }

    #[test]
    fn cancelled_it_kills_the_running_step_and_goes_no_further() {
        let dir = tempfile::tempdir().unwrap();
        let (s, r, own) = (data_in(&dir), recipe(), here_own());
        // the first step never ends by itself
        let (ps, sp) = setup(|_| Script::ok().until_killed());
        let stop = Arc::new(AtomicBool::new(false));
        let (st, (ev, _)) = (stop.clone(), events());
        let ev: Events = Arc::new(move |p| {
            if matches!(p, Progress::Step { .. }) {
                let st = st.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(150));
                    st.store(true, Ordering::SeqCst);
                });
            }
            ev(p)
        });
        let envs = Environments::in_memory();
        let e = install_on(
            Os::this(),
            &req(&own, &s, &r, false),
            &ps,
            &envs,
            ev,
            &|| stop.load(Ordering::SeqCst),
        )
        .unwrap_err();
        assert_eq!(e.code, "install.cancelled");
        assert_eq!(sp.killed().len(), 1);
        assert_eq!(sp.spawned().len(), 1);
        assert!(envs.list().environments.is_empty());
    }

    #[test]
    fn fresh_removes_the_folder_on_every_system_and_otherwise_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let (s, r, own) = (data_in(&dir), recipe(), here_own());
        let folder = std::path::PathBuf::from(own_folder(&own, &s.data, &r));
        let old = folder.join("lib").join("old.txt");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"x").unwrap();
        let (ps, _) = setup(|_| Script::ok().says("1.0"));
        let envs = Environments::in_memory();
        let (ev, _) = events();
        install_on(
            Os::this(),
            &req(&own, &s, &r, false),
            &ps,
            &envs,
            ev.clone(),
            &never,
        )
        .unwrap();
        assert!(old.exists(), "upgraded in place");
        install_on(
            Os::this(),
            &req(&own, &s, &r, true),
            &ps,
            &envs,
            ev.clone(),
            &never,
        )
        .unwrap();
        assert!(!folder.exists(), "made again from nothing");
        // a folder that is not there is no failure
        repair(&req(&own, &s, &r, false), &ps, &envs, ev, &never).unwrap();
    }

    #[test]
    fn an_install_that_prints_no_version_is_not_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let (s, r, own) = (data_in(&dir), recipe(), here_own());
        let (ps, _) = setup(|_| Script::ok());
        let envs = Environments::in_memory();
        let (ev, _) = events();
        let e = install_on(
            Os::this(),
            &req(&own, &s, &r, false),
            &ps,
            &envs,
            ev,
            &never,
        )
        .unwrap_err();
        assert_eq!(e.code, "install.no_version");
        assert!(envs.list().environments.is_empty());
    }

    #[test]
    fn uninstalls_the_folder_and_the_entry_and_only_the_apps_own() {
        let dir = tempfile::tempdir().unwrap();
        let (s, r, own) = (data_in(&dir), recipe(), here_own());
        let folder = std::path::PathBuf::from(own_folder(&own, &s.data, &r));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("f"), b"x").unwrap();
        let env = own_environment(&own, &s.data, &r);
        let envs = Environments::in_memory();
        let (ps, sp) = setup(|_| Script::ok());
        let (ev, all) = events();
        // one the user added is not the app's to remove
        envs.add(&env, false).unwrap();
        let e = uninstall_on(
            Os::this(),
            &own,
            &s.data,
            &r,
            &ps,
            &envs,
            ev.clone(),
            &never,
        )
        .unwrap_err();
        assert_eq!(e.code, "install.not_own");
        assert!(folder.exists() && envs.has(&env));
        envs.add_own(&env, "1.0").unwrap();
        let l = uninstall_on(Os::this(), &own, &s.data, &r, &ps, &envs, ev, &never).unwrap();
        assert!(l.environments.is_empty() && !folder.exists());
        assert!(sp.spawned().is_empty(), "natively no program is needed");
        assert!(matches!(
            crate::locked(&all)[0],
            Progress::Step { i: 1, n: 1, .. }
        ));
    }

    #[test]
    fn uninstalls_in_wsl_by_a_step_in_the_distribution() {
        let own = wsl_own();
        let r = recipe();
        let envs = Environments::in_memory();
        let env = own_environment(&own, "", &r);
        envs.add_own(&env, "1.0").unwrap();
        let (ps, sp) = setup(|_| Script::ok());
        let (ev, _) = events();
        let l = uninstall_on(Os::Windows, &own, "", &r, &ps, &envs, ev, &never).unwrap();
        assert!(l.environments.is_empty());
        let p = &sp.spawned()[0];
        assert_eq!(&p.args[..2], ["-d", "Ubuntu"]);
        assert_eq!(
            p.args[5],
            r#"rm -rf "$HOME/.local/share/example-app/engine""#
        );
    }

    fn kept(installed: Option<&str>) -> Kept {
        Kept {
            environment: Environment {
                machine: Machine::Windows,
                distro: String::new(),
                python: Python::Path {
                    path: r"C:\e\Scripts\python.exe".into(),
                },
            },
            own: true,
            installed: installed.map(str::to_owned),
        }
    }

    #[test]
    fn verify_tells_healthy_stale_and_broken() {
        let t = Duration::from_secs(5);
        let r = recipe();
        let (ps, sp) = setup(|_| Script::ok().says("noise").says("1.2.0"));
        assert_eq!(verify(&kept(Some("1.2.0")), &r, &ps, t), Health::Healthy);
        assert_eq!(verify(&kept(Some("1.1.0")), &r, &ps, t), Health::Stale);
        // nothing recorded to differ from
        assert_eq!(verify(&kept(None), &r, &ps, t), Health::Healthy);
        // the check is run in the Environment's own Python, isolated
        let p = &sp.spawned()[0];
        assert_eq!(p.program, r"C:\e\Scripts\python.exe");
        assert_eq!(p.args.last().unwrap(), &r.check);

        let (ps, _) = setup(|_| Script::ok().complains("ImportError").exits(1));
        let Health::Broken { problem } = verify(&kept(Some("1.2.0")), &r, &ps, t) else {
            panic!("the check failed")
        };
        assert_eq!(problem.code, "install.check_failed");
        assert_eq!(problem.params["output"], "ImportError".into());

        let (ps, _) = setup(|_| Script::cannot_start(Problem::new("process.spawn", "gone")));
        assert!(matches!(
            verify(&kept(Some("1")), &r, &ps, t),
            Health::Broken { .. }
        ));
        let (ps, _) = setup(|_| Script::ok().until_killed());
        let Health::Broken { problem } =
            verify(&kept(Some("1")), &r, &ps, Duration::from_millis(100))
        else {
            panic!("timed out")
        };
        assert_eq!(problem.code, "process.timeout");
        assert_eq!(
            serde_json::to_string(&Health::Stale).unwrap(),
            r#"{"state":"stale"}"#
        );
    }

    /// What a real install puts in: a lockfile with one small package, and a
    /// second package on top, so both the sync and the install are run.
    #[cfg(windows)]
    fn real_recipe(data: &str) -> Recipe {
        let lock = if cfg!(windows) {
            format!(r"{data}\pylock.txt")
        } else {
            format!("{data}/pylock.txt")
        };
        std::fs::create_dir_all(data).unwrap();
        std::fs::write(&lock, "six==1.17.0\n").unwrap();
        Recipe {
            name: "probe".into(),
            app: "geokit-test".into(),
            python: DEFAULT_PYTHON.into(),
            lockfile: Some(lock),
            packages: vec!["idna==3.10".into()],
            wheels: vec![],
            check: "import idna, six, sys; print(six.__version__); sys.exit(six.__version__ != '1.17.0')"
                .into(),
        }
    }

    #[cfg(windows)]
    fn no_events() -> Events {
        Arc::new(|_| true)
    }

    /// An Environment installed for real from a Recipe on Windows, then its
    /// Python started: set GEOKIT_UV to a uv.exe and GEOKIT_OWN_INSTALL to
    /// an empty folder for the app's data, and run with `cargo test --
    /// --ignored`. It downloads Python and two small packages.
    #[cfg(windows)]
    #[test]
    #[ignore = "downloads Python (GEOKIT_UV, GEOKIT_OWN_INSTALL)"]
    fn installs_for_real_and_its_python_starts() {
        let (Ok(uv), Ok(data)) = (
            std::env::var("GEOKIT_UV"),
            std::env::var("GEOKIT_OWN_INSTALL"),
        ) else {
            return;
        };
        let s = Shipped {
            data: data.clone(),
            uv,
            uv_linux: None,
        };
        let r = real_recipe(&data);
        let ps = Processes::default();
        let envs = Environments::in_memory();
        let own = Own::Windows;
        let kept = install(&req(&own, &s, &r, false), &ps, &envs, no_events(), &never).unwrap();
        assert_eq!(kept.installed.as_deref(), Some("1.17.0"));
        // again, on the one made before: upgraded in place, not refused
        let kept = install(&req(&own, &s, &r, false), &ps, &envs, no_events(), &never).unwrap();
        assert_eq!(envs.list().environments.len(), 1);
        assert_eq!(
            verify(&kept, &r, &ps, Duration::from_secs(60)),
            Health::Healthy
        );
        let p = python(
            &kept.environment,
            &["-c", "import sys; print(sys.version_info[:2])"],
        )
        .unwrap();
        let c = ps.output(&p, Duration::from_secs(60)).unwrap();
        assert_eq!(c.lines[0].trim(), "(3, 12)");
        // made again from nothing, then taken away
        repair(&req(&own, &s, &r, false), &ps, &envs, no_events(), &never).unwrap();
        uninstall(&own, &data, &r, &ps, &envs, no_events(), &never).unwrap();
        assert!(!std::path::Path::new(&own_folder(&own, &data, &r)).exists());
        assert!(envs.list().environments.is_empty());
    }

    /// The same in WSL with uv for Linux, so no root and no apt: set
    /// GEOKIT_WSL_DISTRO, GEOKIT_UV_LINUX to a Linux uv as Windows sees it
    /// (`\\wsl.localhost\Ubuntu\home\me\.local\bin\uv` will do) and
    /// GEOKIT_OWN_INSTALL as above. Its Environment is made fresh under
    /// `~/.local/share/geokit-test` in that distribution, and removed again.
    #[cfg(windows)]
    #[test]
    #[ignore = "downloads Python in WSL (GEOKIT_WSL_DISTRO, GEOKIT_UV_LINUX, GEOKIT_OWN_INSTALL)"]
    fn installs_in_wsl_for_real_and_its_python_starts() {
        let (Ok(distro), Ok(uv_linux), Ok(data)) = (
            std::env::var("GEOKIT_WSL_DISTRO"),
            std::env::var("GEOKIT_UV_LINUX"),
            std::env::var("GEOKIT_OWN_INSTALL"),
        ) else {
            return;
        };
        let s = Shipped {
            data: data.clone(),
            uv: String::new(),
            uv_linux: Some(uv_linux),
        };
        let r = real_recipe(&data);
        let own = Own::Wsl {
            distro: distro.clone(),
        };
        let ps = Processes::default();
        let envs = Environments::in_memory();
        let kept = install(&req(&own, &s, &r, true), &ps, &envs, no_events(), &never).unwrap();
        assert_eq!(kept.installed.as_deref(), Some("1.17.0"));
        let p = python(
            &kept.environment,
            &[
                "-c",
                "import sys; print(sys.platform, sys.version_info[:2])",
            ],
        )
        .unwrap();
        let c = ps.output(&p, Duration::from_secs(120)).unwrap();
        assert_eq!(c.lines[0].trim(), "linux (3, 12)");
        // the GPU probe, where the distribution reaches one
        let probe = crate::programs::wsl_gpu_probe(&distro).unwrap();
        let c = ps.output(&probe, Duration::from_secs(120)).unwrap();
        if let Some(gpu) = crate::programs::gpu_found(&c.lines) {
            assert!(gpu.starts_with("GPU 0"));
        }
        uninstall(&own, &data, &r, &ps, &envs, no_events(), &never).unwrap();
    }
}
