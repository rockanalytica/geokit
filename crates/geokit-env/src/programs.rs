// What an app's core starts, each as a program and its arguments, built
// here rather than by the page: a Python in an Environment, the steps that
// install the app's own Environment, and the questions put to WSL. The page
// names an Environment, a distribution; what is started from them is fixed
// here, every value checked first and passed as one argument, never as code.
// What the app installs is its own `Recipe`; nothing here names a package.

use crate::envs::{word, Environment, Machine, Python};
use std::collections::HashMap;

/// The Python an Environment is made with when a Recipe names no other.
pub const DEFAULT_PYTHON: &str = "3.12";

/// A program to start: what, with which arguments, and with what added to its environment.
#[derive(Debug, Clone, PartialEq)]
pub struct Program {
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// `p` with `args`, nothing added to its environment.
pub fn program(p: &str, args: &[&str]) -> Program {
    Program {
        program: p.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: HashMap::new(),
    }
}

/// Isolated (`-I`), so no PYTHON* variable reaches it, and UTF-8 asked for.
pub const PY_FLAGS: [&str; 3] = ["-I", "-X", "utf8"];

/// What the app ships and keeps, by path.
pub struct Shipped {
    /// The app's own data folder, where its Environments are kept.
    pub data: String,
    /// uv for this computer's system.
    pub uv: String,
    /// uv for Linux, as the Windows side sees it, to make an Environment in
    /// WSL with no root and no apt. Without it, WSL's own Python is used.
    pub uv_linux: Option<String>,
}

/// What an app installs in an Environment of its own.
#[derive(Debug, Clone, PartialEq)]
pub struct Recipe {
    /// The Environment's folder, in the app's data folder (a word).
    pub name: String,
    /// The app's own folder in WSL, under `~/.local/share` (a word).
    pub app: String,
    /// The Python it is made with (`3.12`).
    pub python: String,
    /// A pinned requirements file the Environment is synced to first: what
    /// is not in it is removed, what is in it is installed at its version.
    pub lockfile: Option<String>,
    /// Requirement specifiers installed after the lockfile, in one go.
    pub packages: Vec<String>,
    /// Local wheels installed last, over what is there, without their dependencies.
    pub wheels: Vec<String>,
    /// Python code run last: it prints what it found and exits non-zero when
    /// the Environment is not what the app needs.
    pub check: String,
}

/// Where the app installs an Environment of its own.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(tag = "machine", rename_all = "lowercase")]
pub enum Own {
    Windows,
    Wsl {
        distro: String,
    },
    /// On macOS or Linux, natively.
    Posix,
}

impl Own {
    /// Whether this computer can have it: Windows and WSL on Windows, Posix elsewhere.
    pub fn here(&self) -> Result<(), String> {
        let ok = match self {
            Own::Windows | Own::Wsl { .. } => cfg!(windows),
            Own::Posix => !cfg!(windows),
        };
        if ok {
            Ok(())
        } else {
            Err("refused install: not on this computer's system".into())
        }
    }

    /// Whether it lives in the app's own data folder, rather than in WSL.
    pub fn native(&self) -> bool {
        !matches!(self, Own::Wsl { .. })
    }
}

/// A word for a POSIX shell: quoted whole, a quote in it closed and reopened.
pub fn sh(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A path for a POSIX shell: `~/` left to the shell as `$HOME`, the rest quoted.
pub fn sh_path(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"{}", sh(&format!("/{rest}"))),
        None => sh(p),
    }
}

/// A Windows path as WSL sees it: a drive under /mnt, a WSL folder as its own.
pub fn wsl_path(windows: &str) -> Result<String, String> {
    let lower = windows.to_ascii_lowercase();
    for pre in [r"\\wsl.localhost\", r"\\wsl$\"] {
        if lower.starts_with(pre) {
            let rest = &windows[pre.len()..];
            let own = rest.find('\\').map(|i| &rest[i..]).unwrap_or(r"\");
            return Ok(own.replace('\\', "/"));
        }
    }
    let b = windows.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        let rest = windows[2..]
            .trim_start_matches(['\\', '/'])
            .replace('\\', "/");
        let rest = rest.trim_end_matches('/');
        let drive = (b[0] as char).to_ascii_lowercase();
        return Ok(if rest.is_empty() {
            format!("/mnt/{drive}")
        } else {
            format!("/mnt/{drive}/{rest}")
        });
    }
    Err(format!("{windows} is not a path WSL can reach"))
}

/// A WSL distribution's name as `wsl.exe -d` takes it; empty is WSL's default.
pub fn distro_ok(d: &str) -> Result<(), String> {
    if word(d) {
        Ok(())
    } else {
        Err(format!("{d:?} is not a WSL distribution's name"))
    }
}

/// `script` run by bash in `distro` (WSL's default where it is empty), as a login shell.
pub fn wsl(distro: &str, script: &str) -> Program {
    let mut args: Vec<&str> = vec![];
    if !distro.is_empty() {
        args.extend(["-d", distro]);
    }
    args.extend(["--exec", "bash", "-lc", script]);
    program("wsl.exe", &args)
}

/// `env`'s Python started with `args` after the isolating flags, each one
/// argument (quoted for the shell, in WSL). What the app's core starts its
/// own Python side with.
pub fn python(env: &Environment, args: &[&str]) -> Result<Program, String> {
    let env = env.trimmed();
    if let Some(why) = env.problem() {
        return Err(format!("refused Environment: {why}"));
    }
    let mut tail: Vec<String> = PY_FLAGS.iter().map(|s| s.to_string()).collect();
    tail.extend(args.iter().map(|a| a.to_string()));
    let mut p = match env.machine {
        Machine::Windows | Machine::Posix => {
            let default = if env.machine == Machine::Windows {
                "python"
            } else {
                "python3"
            };
            match &env.python {
                Python::Conda { name } => {
                    let mut a: Vec<String> = ["run", "-n", name, "--no-capture-output", "python"]
                        .iter()
                        .map(|s| s.to_string())
                        .collect();
                    a.extend(tail);
                    Program {
                        program: if env.machine == Machine::Windows {
                            "conda.exe".into()
                        } else {
                            "conda".into()
                        },
                        args: a,
                        env: HashMap::new(),
                    }
                }
                Python::Path { path } => Program {
                    program: path.clone(),
                    args: tail,
                    env: HashMap::new(),
                },
                Python::Default => Program {
                    program: default.into(),
                    args: tail,
                    env: HashMap::new(),
                },
            }
        }
        Machine::Wsl => {
            distro_ok(&env.distro)?;
            let quoted: Vec<String> = tail.iter().map(|a| sh(a)).collect();
            let rest = quoted.join(" ");
            let script = match &env.python {
                Python::Conda { name } => format!(
                    "eval \"$(conda shell.bash hook 2>/dev/null || ~/miniconda3/bin/conda shell.bash hook)\" && conda activate {} && exec python {rest}",
                    sh(name)
                ),
                Python::Path { path } => format!("exec {} {rest}", sh_path(path)),
                Python::Default => format!("exec python{DEFAULT_PYTHON} {rest}"),
            };
            wsl(&env.distro, &script)
        }
    };
    p.env.insert("PYTHONIOENCODING".into(), "utf-8".into());
    Ok(p)
}

/// A version as `uv python install` and a Recipe take it: digits and dots.
fn version_ok(v: &str) -> Result<(), String> {
    let ok = !v.is_empty()
        && v.split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if ok {
        Ok(())
    } else {
        Err(format!("{v} is not a Python version"))
    }
}

impl Recipe {
    /// Why it cannot be installed, or None: every value it puts on a command line checked.
    pub fn problem(&self) -> Option<String> {
        if self.name.is_empty() || !word(&self.name) {
            return Some(format!(
                "{:?} is not an Environment's folder name",
                self.name
            ));
        }
        if self.app.is_empty() || !word(&self.app) {
            return Some(format!("{:?} is not an app's folder name", self.app));
        }
        if let Err(e) = version_ok(&self.python) {
            return Some(e);
        }
        let values = self
            .packages
            .iter()
            .chain(&self.wheels)
            .chain(self.lockfile.iter());
        for v in values {
            if v.trim().is_empty() || v.starts_with('-') {
                return Some(format!("{v:?} is not a requirement or a file"));
            }
            if v.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
                return Some(format!("{v:?} holds a control character"));
            }
        }
        if self.check.trim().is_empty() {
            return Some("a Recipe needs a check".into());
        }
        None
    }
}

/// Where the Environment the app makes lives: one venv, upgraded in place.
pub fn own_folder(own: &Own, data: &str, r: &Recipe) -> String {
    match own {
        Own::Windows => format!(r"{data}\environments\{}", r.name),
        Own::Wsl { .. } => format!("~/.local/share/{}/{}", r.app, r.name),
        Own::Posix => format!("{data}/environments/{}", r.name),
    }
}

/// The Environment the app made: what its Python side is then started in.
pub fn own_environment(own: &Own, data: &str, r: &Recipe) -> Environment {
    let dir = own_folder(own, data, r);
    match own {
        Own::Windows => Environment {
            machine: Machine::Windows,
            distro: String::new(),
            python: Python::Path {
                path: format!(r"{dir}\Scripts\python.exe"),
            },
        },
        Own::Wsl { distro } => Environment {
            machine: Machine::Wsl,
            distro: distro.clone(),
            python: Python::Path {
                path: format!("{dir}/bin/python"),
            },
        },
        Own::Posix => Environment {
            machine: Machine::Posix,
            distro: String::new(),
            python: Python::Path {
                path: format!("{dir}/bin/python"),
            },
        },
    }
}

/// The steps that install the app's own Environment, in order. On Windows,
/// macOS and Linux uv makes it all — its own Python in the app's data
/// folder, a venv, the lockfile, the packages, the wheels — then the check
/// runs. In WSL it is one script: with uv for Linux shipped, the same steps
/// with no root or apt; without it, the distribution's own Python makes a
/// venv and pip fills it. Run on one made before, they upgrade it in place;
/// `fresh`, the WSL one is made again from nothing (on Windows the caller
/// removes the folder).
pub fn install_steps(
    own: &Own,
    s: &Shipped,
    r: &Recipe,
    fresh: bool,
) -> Result<Vec<Program>, String> {
    if let Some(why) = r.problem() {
        return Err(format!("refused Recipe: {why}"));
    }
    own.here()?;
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
            let python = match own_environment(own, &s.data, r).python {
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
            let mut steps = vec![
                uv(&python_install),
                uv(&[
                    "venv",
                    &dir,
                    "--python",
                    v,
                    "--python-preference",
                    "only-managed",
                    "--allow-existing",
                ]),
            ];
            if let Some(lock) = &r.lockfile {
                steps.push(uv(&["pip", "sync", "--python", &python, lock]));
            }
            if !r.packages.is_empty() {
                let mut a = vec!["pip", "install", "--python", &python];
                a.extend(r.packages.iter().map(String::as_str));
                steps.push(uv(&a));
            }
            if !r.wheels.is_empty() {
                let mut a = vec![
                    "pip",
                    "install",
                    "--python",
                    &python,
                    "--reinstall",
                    "--no-deps",
                ];
                a.extend(r.wheels.iter().map(String::as_str));
                steps.push(uv(&a));
            }
            let mut check = program(
                &python,
                &[PY_FLAGS[0], PY_FLAGS[1], PY_FLAGS[2], "-c", &r.check],
            );
            check.env.insert("PYTHONIOENCODING".into(), "utf-8".into());
            steps.push(check);
            Ok(steps)
        }
        Own::Wsl { distro } => {
            distro_ok(distro)?;
            let lock = r.lockfile.as_deref().map(wsl_path).transpose()?;
            let wheels = r
                .wheels
                .iter()
                .map(|w| wsl_path(w).map(|p| sh(&p)))
                .collect::<Result<Vec<_>, _>>()?
                .join(" ");
            let packages = r
                .packages
                .iter()
                .map(|p| sh(p))
                .collect::<Vec<_>>()
                .join(" ");
            let py = "\"$D/bin/python\"";
            let mut script = vec![
                "set -u".to_string(),
                r#"fail() { echo "$1" >&2; exit 1; }"#.to_string(),
                format!(r#"D="$HOME/.local/share/{}/{}""#, r.app, r.name),
                if fresh {
                    r#"rm -rf "$D""#.to_string()
                } else {
                    ":".to_string()
                },
            ];
            match &s.uv_linux {
                Some(uv) => {
                    script.extend([
                        format!(r#"UV={}"#, sh(&wsl_path(uv)?)),
                        format!(r#"export UV_PYTHON_INSTALL_DIR="$HOME/.local/share/{}/python""#, r.app),
                        format!(r#"export UV_CACHE_DIR="$HOME/.cache/{}/uv""#, r.app),
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
            Ok(vec![p])
        }
    }
}

/// The distributions WSL has, one per line, in UTF-8 rather than its UTF-16.
pub fn wsl_list() -> Program {
    let mut p = program("wsl.exe", &["--list", "--quiet"]);
    p.env.insert("WSL_UTF8".into(), "1".into());
    p
}

/// What one distribution runs to say whether its GPU is reachable: a `GPU`
/// line naming it, or nothing. Fixed text: nothing in it comes from the user.
pub const GPU_PROBE: &str = r#"command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | head -n 1 | sed "s/^/GPU\t/"
true"#;

/// The GPU probe run in `distro`.
pub fn wsl_gpu_probe(distro: &str) -> Result<Program, String> {
    distro_ok(distro)?;
    if distro.is_empty() {
        return Err("no distribution named".into());
    }
    Ok(wsl(distro, GPU_PROBE))
}

/// The GPU a probe's output names, if it found one (`GPU 0: NVIDIA …`).
pub fn gpu_found(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .find_map(|l| l.strip_prefix("GPU\t"))
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shipped() -> Shipped {
        Shipped {
            data: r"C:\Users\Ítalo\AppData\Local\com.example.app".into(),
            uv: r"C:\Program Files\App\uv\uv.exe".into(),
            uv_linux: None,
        }
    }

    fn recipe() -> Recipe {
        Recipe {
            name: "engine".into(),
            app: "example-app".into(),
            python: DEFAULT_PYTHON.into(),
            lockfile: Some(r"C:\Program Files\App\env\pylock.txt".into()),
            packages: vec!["numpy>=2".into()],
            wheels: vec![r"C:\Program Files\App\wheels\app-1.0-py3-none-any.whl".into()],
            check: "import numpy; print(numpy.__version__)".into(),
        }
    }

    #[test]
    fn a_windows_path_as_wsl_sees_it() {
        assert_eq!(
            wsl_path(r"C:\Users\Ítalo\P").unwrap(),
            "/mnt/c/Users/Ítalo/P"
        );
        assert_eq!(wsl_path(r"D:\").unwrap(), "/mnt/d");
        assert_eq!(
            wsl_path(r"\\wsl.localhost\Ubuntu\home\me\p").unwrap(),
            "/home/me/p"
        );
        assert!(wsl_path("relative").is_err());
    }

    #[test]
    fn a_word_quoted_for_the_shell() {
        assert_eq!(sh("it's"), r"'it'\''s'");
        assert_eq!(sh_path("~/a b/python"), r#""$HOME"'/a b/python'"#);
        assert_eq!(sh_path("/usr/bin/python3"), "'/usr/bin/python3'");
    }

    #[test]
    fn python_on_windows_takes_each_value_as_one_argument() {
        let env = Environment {
            machine: Machine::Windows,
            distro: String::new(),
            python: Python::Path {
                path: r"C:\py & x\python.exe".into(),
            },
        };
        // a character cmd reads as its own is refused, though no shell is used
        assert!(python(&env, &["-m", "app"]).is_err());
        let env = Environment {
            python: Python::Path {
                path: r"C:\py\python.exe".into(),
            },
            ..env
        };
        let p = python(&env, &["-m", "app.engine", r"C:\My P"]).unwrap();
        assert_eq!(p.program, r"C:\py\python.exe");
        assert_eq!(p.args, ["-I", "-X", "utf8", "-m", "app.engine", r"C:\My P"]);
        assert_eq!(p.env["PYTHONIOENCODING"], "utf-8");
    }

    #[test]
    fn python_in_wsl_quotes_every_value() {
        let env = Environment {
            machine: Machine::Wsl,
            distro: "Ubuntu".into(),
            python: Python::Path {
                path: "~/.venvs/a'b/bin/python".into(),
            },
        };
        let p = python(&env, &["-m", "app", "/mnt/c/it's"]).unwrap();
        assert_eq!(p.program, "wsl.exe");
        assert_eq!(&p.args[..5], ["-d", "Ubuntu", "--exec", "bash", "-lc"]);
        assert_eq!(
            p.args[5],
            r#"exec "$HOME"'/.venvs/a'\''b/bin/python' '-I' '-X' 'utf8' '-m' 'app' '/mnt/c/it'\''s'"#
        );
        let conda = Environment {
            python: Python::Conda {
                name: "tools".into(),
            },
            ..env
        };
        assert!(python(&conda, &["-V"]).unwrap().args[5]
            .contains("conda activate 'tools' && exec python '-I'"));
    }

    #[test]
    fn a_conda_environment_through_conda() {
        let env = Environment {
            machine: Machine::Windows,
            distro: String::new(),
            python: Python::Conda {
                name: "tools".into(),
            },
        };
        let p = python(&env, &["-V"]).unwrap();
        assert_eq!(p.program, "conda.exe");
        assert_eq!(
            &p.args[..6],
            ["run", "-n", "tools", "--no-capture-output", "python", "-I"]
        );
    }

    #[test]
    fn a_recipe_is_checked_before_anything_is_built() {
        assert_eq!(recipe().problem(), None);
        let bad = |f: fn(&mut Recipe)| {
            let mut r = recipe();
            f(&mut r);
            r.problem().is_some()
        };
        assert!(bad(|r| r.name = "a b".into()));
        assert!(bad(|r| r.name = String::new()));
        assert!(bad(|r| r.app = "../x".into()));
        assert!(bad(|r| r.python = "3.12; rm".into()));
        assert!(bad(|r| r.packages.push("--index-url=http://x".into())));
        assert!(bad(|r| r.wheels.push("a\nb".into())));
        assert!(bad(|r| r.lockfile = Some(" ".into())));
        assert!(bad(|r| r.check = String::new()));
    }

    #[cfg(windows)]
    #[test]
    fn the_install_steps_on_windows() {
        let r = recipe();
        let steps = install_steps(&Own::Windows, &shipped(), &r, false).unwrap();
        // python, venv, sync, packages, wheels, check
        assert_eq!(steps.len(), 6);
        assert!(steps[..5]
            .iter()
            .all(|s| s.program == shipped().uv && s.env["UV_NO_CONFIG"] == "1"));
        assert_eq!(
            steps[0].args,
            ["python", "install", "3.12", "--no-bin", "--no-registry"]
        );
        let dir = r"C:\Users\Ítalo\AppData\Local\com.example.app\environments\engine";
        assert_eq!(steps[1].args[1], dir);
        let py = format!(r"{dir}\Scripts\python.exe");
        assert_eq!(
            steps[2].args,
            [
                "pip",
                "sync",
                "--python",
                &py,
                r"C:\Program Files\App\env\pylock.txt"
            ]
        );
        assert_eq!(steps[3].args.last().unwrap(), "numpy>=2");
        assert_eq!(&steps[4].args[4..6], ["--reinstall", "--no-deps"]);
        assert_eq!(steps[5].program, py);
        assert_eq!(steps[5].args.last().unwrap(), &r.check);
        // only what a Recipe asks for
        let bare = Recipe {
            lockfile: None,
            packages: vec![],
            wheels: vec![],
            ..r.clone()
        };
        assert_eq!(
            install_steps(&Own::Windows, &shipped(), &bare, false)
                .unwrap()
                .len(),
            3
        );
        let bad = Recipe {
            python: "x".into(),
            ..r
        };
        assert!(install_steps(&Own::Windows, &shipped(), &bad, false).is_err());
    }

    #[cfg(unix)]
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
        let steps = install_steps(&Own::Posix, &s, &r, false).unwrap();
        assert_eq!(steps.len(), 6);
        assert_eq!(steps[0].args, ["python", "install", "3.12", "--no-bin"]);
        let dir = "/home/u/.local/share/com.example.app/environments/engine";
        assert_eq!(steps[1].args[1], dir);
        assert_eq!(
            steps[0].env["UV_PYTHON_INSTALL_DIR"],
            "/home/u/.local/share/com.example.app/python"
        );
        assert_eq!(steps[5].program, format!("{dir}/bin/python"));
        assert_eq!(
            own_environment(&Own::Posix, &s.data, &r).machine,
            Machine::Posix
        );
    }

    #[test]
    fn installs_only_what_this_computer_can_have() {
        assert_eq!(Own::Posix.here().is_ok(), !cfg!(windows));
        assert_eq!(Own::Windows.here().is_ok(), cfg!(windows));
        assert!(Own::Posix.native() && Own::Windows.native());
        assert!(!Own::Wsl { distro: "U".into() }.native());
    }

    #[cfg(windows)]
    #[test]
    fn the_install_in_wsl_with_uv_needs_no_root() {
        let own = Own::Wsl {
            distro: "Ubuntu".into(),
        };
        let s = Shipped {
            uv_linux: Some(r"C:\Program Files\App\uv\linux\uv".into()),
            ..shipped()
        };
        let steps = install_steps(&own, &s, &recipe(), false).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(&steps[0].args[..2], ["-d", "Ubuntu"]);
        let script = &steps[0].args[5];
        assert!(script.contains(r#"D="$HOME/.local/share/example-app/engine""#));
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
        let fresh = install_steps(&own, &s, &recipe(), true).unwrap();
        assert!(fresh[0].args[5].contains("\nrm -rf \"$D\"\n"));
        assert_eq!(
            own_environment(&own, &s.data, &recipe()).python,
            Python::Path {
                path: "~/.local/share/example-app/engine/bin/python".into()
            }
        );
        assert!(install_steps(
            &Own::Wsl {
                distro: "a b".into()
            },
            &s,
            &recipe(),
            false
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn the_install_in_wsl_without_uv_uses_the_distributions_python() {
        let own = Own::Wsl {
            distro: "Ubuntu".into(),
        };
        let steps = install_steps(&own, &shipped(), &recipe(), false).unwrap();
        let script = &steps[0].args[5];
        assert!(script.contains(r#"PY="$(command -v python3.12 || true)""#));
        assert!(script.contains(
            r#""$D/bin/python" -m pip install -r '/mnt/c/Program Files/App/env/pylock.txt'"#
        ));
        assert!(script.contains("--force-reinstall --no-deps"));
        assert!(!script.contains("$UV"));
    }

    #[test]
    fn the_gpu_probe_names_what_it_found() {
        assert!(wsl_gpu_probe("").is_err() && wsl_gpu_probe("a;b").is_err());
        let p = wsl_gpu_probe("Ubuntu").unwrap();
        assert_eq!(p.args[5], GPU_PROBE);
        let found = gpu_found(&["GPU\tGPU 0: NVIDIA GeForce RTX 4060 Ti (UUID: GPU-1)".into()]);
        assert_eq!(
            found.as_deref(),
            Some("GPU 0: NVIDIA GeForce RTX 4060 Ti (UUID: GPU-1)")
        );
        assert_eq!(gpu_found(&[]), None);
        assert_eq!(gpu_found(&["GPU\t  ".into()]), None);
    }

    /// What a real install puts in: a lockfile with one small package, and a
    /// second package on top, so both the sync and the install are run.
    #[cfg(windows)]
    fn real_recipe(data: &str) -> Recipe {
        let lock = format!(r"{data}\pylock.txt");
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
    fn run(p: &Program) -> String {
        let out = std::process::Command::new(&p.program)
            .args(&p.args)
            .envs(&p.env)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{} {:?}\n{}\n{}",
            p.program,
            p.args,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
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
        let mut last = String::new();
        for step in install_steps(&Own::Windows, &s, &r, false).unwrap() {
            last = run(&step);
        }
        assert_eq!(last.trim(), "1.17.0");
        // again, on the one made before: upgraded in place, not refused
        for step in install_steps(&Own::Windows, &s, &r, false).unwrap() {
            last = run(&step);
        }
        assert_eq!(last.trim(), "1.17.0");
        let env = own_environment(&Own::Windows, &data, &r);
        let p = python(&env, &["-c", "import sys; print(sys.version_info[:2])"]).unwrap();
        assert_eq!(run(&p).trim(), "(3, 12)");
    }

    /// The same in WSL with uv for Linux, so no root and no apt: set
    /// GEOKIT_WSL_DISTRO, GEOKIT_UV_LINUX to a Linux uv as Windows sees it
    /// (`\\wsl.localhost\Ubuntu\home\me\.local\bin\uv` will do) and
    /// GEOKIT_OWN_INSTALL as above. Its Environment is made fresh under
    /// `~/.local/share/geokit-test` in that distribution.
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
        let steps = install_steps(&own, &s, &r, true).unwrap();
        assert_eq!(run(&steps[0]).trim().lines().last(), Some("1.17.0"));
        let env = own_environment(&own, &data, &r);
        let p = python(
            &env,
            &[
                "-c",
                "import sys; print(sys.platform, sys.version_info[:2])",
            ],
        )
        .unwrap();
        assert_eq!(run(&p).trim(), "linux (3, 12)");
        // the GPU probe, where the distribution reaches one
        let probe = wsl_gpu_probe(&distro).unwrap();
        let lines: Vec<String> = run(&probe).lines().map(str::to_owned).collect();
        if let Some(gpu) = gpu_found(&lines) {
            assert!(gpu.starts_with("GPU 0"));
        }
    }
}
