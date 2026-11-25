// What an app's core starts, each as a program and its arguments, built
// here rather than by the page: a Python in an Environment and the questions
// put to WSL. (The steps that install the app's own Environment are in
// `install.rs`.) The page names an Environment, a distribution; what is
// started from them is fixed here, every value checked first and passed as
// one argument, never as code. What the app installs is its own `Recipe`;
// nothing here names a package.

use crate::envs::{word, Environment, Machine, Python};
use crate::problem::Problem;
use std::collections::HashMap;

/// The Python an Environment is made with when a Recipe names no other.
pub const DEFAULT_PYTHON: &str = "3.12";

/// What runs on the Linux side of a program that is started in WSL: the
/// distribution (WSL's default where empty) and the bash script. A Spawner
/// that can end the Linux side with the program uses it; the program's own
/// `program` and `args` are the plain command line that runs the same.
#[derive(Debug, Clone, PartialEq)]
pub struct Linux {
    pub distro: String,
    pub script: String,
}

/// A program to start: what, with which arguments, and with what added to its environment.
#[derive(Debug, Clone, PartialEq)]
pub struct Program {
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// Set for a program that runs in WSL.
    pub linux: Option<Linux>,
}

/// `p` with `args`, nothing added to its environment.
pub fn program(p: &str, args: &[&str]) -> Program {
    Program {
        program: p.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: HashMap::new(),
        linux: None,
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
    /// The Environment's folder, in the app's data folder (a word, not starting with a dot).
    pub name: String,
    /// The app's own folder in WSL, under `~/.local/share` (a word, not starting with a dot).
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
    /// Python code run last: it prints what it found (its last line is the
    /// version the app records) and exits non-zero when the Environment is
    /// not what the app needs.
    pub check: String,
}

/// The kind of system a program is built for, which says where the app's own
/// Environment can be: the plans are built for either, on any host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    /// macOS or Linux.
    Posix,
}

impl Os {
    /// The system this is running on.
    pub fn this() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else {
            Os::Posix
        }
    }
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
    /// Whether a computer of kind `os` can have it: Windows and WSL on
    /// Windows, Posix elsewhere.
    pub fn supported_on(&self, os: Os) -> Result<(), Problem> {
        let ok = match self {
            Own::Windows | Own::Wsl { .. } => os == Os::Windows,
            Own::Posix => os == Os::Posix,
        };
        if ok {
            Ok(())
        } else {
            Err(Problem::new(
                "install.not_here",
                "That Environment cannot be made on this computer's system.",
            ))
        }
    }

    /// Whether this computer can have it.
    pub fn here(&self) -> Result<(), Problem> {
        self.supported_on(Os::this())
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

/// The app's own folder in WSL, `home` being `~` or `$HOME`: the one place
/// that names `.local/share`.
pub fn wsl_share(app: &str, home: &str) -> String {
    format!("{home}/.local/share/{app}")
}

/// Where uv keeps its downloads for the app in WSL.
pub fn wsl_cache(app: &str, home: &str) -> String {
    format!("{home}/.cache/{app}/uv")
}

/// A Windows path as WSL sees it in `distro` (WSL's default where empty): a
/// drive under /mnt, a folder of that same distribution as its own path. A
/// folder of another distribution, or a path relative to a drive (`C:foo`),
/// is not one WSL can be given.
pub fn wsl_path(windows: &str, distro: &str) -> Result<String, Problem> {
    let no = |code: &str, english: &str| Problem::new(code, english).with("path", windows);
    let lower = windows.to_ascii_lowercase();
    for pre in [r"\\wsl.localhost\", r"\\wsl$\"] {
        if lower.starts_with(pre) {
            let rest = &windows[pre.len()..];
            let (name, own) = match rest.find('\\') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, r"\"),
            };
            if !distro.is_empty() && !name.eq_ignore_ascii_case(distro) {
                return Err(no(
                    "wsl.other_distro",
                    "That path is in another WSL distribution.",
                )
                .with("distro", name));
            }
            return Ok(own.replace('\\', "/"));
        }
    }
    let b = windows.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        let after = &windows[2..];
        if !after.starts_with(['\\', '/']) {
            return Err(no(
                "wsl.drive_relative",
                "That path is relative to a drive's current folder.",
            ));
        }
        let rest = after.trim_start_matches(['\\', '/']).replace('\\', "/");
        let rest = rest.trim_end_matches('/');
        let drive = (b[0] as char).to_ascii_lowercase();
        return Ok(if rest.is_empty() {
            format!("/mnt/{drive}")
        } else {
            format!("/mnt/{drive}/{rest}")
        });
    }
    Err(no("wsl.path", "That is not a path WSL can reach."))
}

/// A WSL distribution's name as `wsl.exe -d` takes it; empty is WSL's default.
pub fn distro_ok(d: &str) -> Result<(), Problem> {
    if word(d) {
        Ok(())
    } else {
        Err(Problem::new("wsl.distro", "That is not a WSL distribution's name.").with("distro", d))
    }
}

/// `script` run by bash in `distro` (WSL's default where it is empty), as a login shell.
pub fn wsl(distro: &str, script: &str) -> Program {
    let mut args: Vec<&str> = vec![];
    if !distro.is_empty() {
        args.extend(["-d", distro]);
    }
    args.extend(["--exec", "bash", "-lc", script]);
    Program {
        linux: Some(Linux {
            distro: distro.into(),
            script: script.into(),
        }),
        ..program("wsl.exe", &args)
    }
}

/// `env`'s Python started with `args` after the isolating flags, each one
/// argument (quoted for the shell, in WSL). What the app's core starts its
/// own Python side with.
pub fn python(env: &Environment, args: &[&str]) -> Result<Program, Problem> {
    let env = env.trimmed();
    if let Some(why) = env.problem() {
        return Err(why);
    }
    let mut tail: Vec<String> = PY_FLAGS.iter().map(|s| s.to_string()).collect();
    tail.extend(args.iter().map(|a| a.to_string()));
    let mut p = match env.machine {
        Machine::Windows | Machine::Posix => {
            let (exe, args) = match &env.python {
                Python::Conda { name } => {
                    let mut a: Vec<String> = ["run", "-n", name, "--no-capture-output", "python"]
                        .iter()
                        .map(|s| s.to_string())
                        .collect();
                    a.extend(tail);
                    (env.machine.conda().to_string(), a)
                }
                Python::Path { path } => (path.clone(), tail),
                Python::Default => (env.machine.default_python(), tail),
            };
            Program {
                program: exe,
                args,
                env: HashMap::new(),
                linux: None,
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
                Python::Default => format!("exec {} {rest}", env.machine.default_python()),
            };
            wsl(&env.distro, &script)
        }
    };
    p.env.insert("PYTHONIOENCODING".into(), "utf-8".into());
    Ok(p)
}

/// A version as `uv python install` and a Recipe take it: digits and dots.
fn version_ok(v: &str) -> Result<(), Problem> {
    let ok = !v.is_empty()
        && v.split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if ok {
        Ok(())
    } else {
        Err(Problem::new("recipe.python", "That is not a Python version.").with("python", v))
    }
}

/// A folder's name: a word that is not `.` or `..` or hidden, so a folder
/// named by it can be removed without removing anything else.
fn folder_ok(s: &str) -> bool {
    !s.is_empty() && word(s) && !s.starts_with('.')
}

impl Recipe {
    /// Why it cannot be installed, or None: every value it puts on a command line checked.
    pub fn problem(&self) -> Option<Problem> {
        let bad =
            |code: &str, english: &str, v: &str| Some(Problem::new(code, english).with("value", v));
        if !folder_ok(&self.name) {
            return bad(
                "recipe.name",
                "That is not an Environment's folder name.",
                &self.name,
            );
        }
        if !folder_ok(&self.app) {
            return bad("recipe.app", "That is not an app's folder name.", &self.app);
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
                return bad("recipe.value", "That is not a requirement or a file.", v);
            }
            if v.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
                return bad("recipe.control", "That holds a control character.", v);
            }
        }
        if self.check.trim().is_empty() {
            return Some(Problem::new("recipe.check", "A Recipe needs a check."));
        }
        None
    }
}

/// Where the Environment the app makes lives: one venv, upgraded in place.
pub fn own_folder(own: &Own, data: &str, r: &Recipe) -> String {
    match own {
        Own::Windows => format!(r"{data}\environments\{}", r.name),
        Own::Wsl { .. } => format!("{}/{}", wsl_share(&r.app, "~"), r.name),
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

/// The distributions WSL has, one per line, in UTF-8 rather than its UTF-16.
/// What it prints is read with `detect::wsl_distros`.
pub fn wsl_list() -> Program {
    let mut p = program("wsl.exe", &["--list", "--quiet"]);
    p.env.insert("WSL_UTF8".into(), "1".into());
    p
}

/// What one distribution runs to say whether its GPU is reachable: a `GPU`
/// line naming it, or nothing. Fixed text: nothing in it comes from the user.
pub const GPU_PROBE: &str = r#"command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | head -n 1 | sed "s/^/GPU\t/"
true"#;

/// The GPU probe run in `distro` (WSL's default where it is empty).
pub fn wsl_gpu_probe(distro: &str) -> Result<Program, Problem> {
    distro_ok(distro)?;
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
pub(crate) mod tests {
    use super::*;

    pub(crate) fn recipe() -> Recipe {
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
        let w = |p: &str| wsl_path(p, "Ubuntu");
        assert_eq!(w(r"C:\Users\Ítalo\P").unwrap(), "/mnt/c/Users/Ítalo/P");
        assert_eq!(w(r"D:\").unwrap(), "/mnt/d");
        assert_eq!(w("d:/x/y/").unwrap(), "/mnt/d/x/y");
        assert_eq!(
            w(r"\\wsl.localhost\Ubuntu\home\me\p").unwrap(),
            "/home/me/p"
        );
        assert_eq!(w(r"\\WSL$\ubuntu\home").unwrap(), "/home");
        assert_eq!(w(r"\\wsl.localhost\Ubuntu").unwrap(), "/");
        // WSL's default distribution: whichever one the path names is taken
        assert_eq!(wsl_path(r"\\wsl.localhost\Debian\etc", "").unwrap(), "/etc");
        assert_eq!(w("relative").unwrap_err().code, "wsl.path");
        assert_eq!(w(r"\\server\share\x").unwrap_err().code, "wsl.path");
    }

    #[test]
    fn a_path_in_another_distribution_or_relative_to_a_drive_is_refused() {
        let e = wsl_path(r"\\wsl.localhost\Debian\home\me", "Ubuntu").unwrap_err();
        assert_eq!(e.code, "wsl.other_distro");
        assert_eq!(
            wsl_path("C:foo", "Ubuntu").unwrap_err().code,
            "wsl.drive_relative"
        );
        assert_eq!(
            wsl_path("C:", "Ubuntu").unwrap_err().code,
            "wsl.drive_relative"
        );
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
        assert_eq!(python(&env, &["-m", "app"]).unwrap_err().code, "env.cmd");
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
        assert_eq!(p.linux, None);
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
        // what runs on the Linux side is kept apart for a Spawner that can end it
        let l = p.linux.clone().unwrap();
        assert_eq!(
            (l.distro.as_str(), l.script.as_str()),
            ("Ubuntu", p.args[5].as_str())
        );
        let conda = Environment {
            python: Python::Conda {
                name: "tools".into(),
            },
            ..env.clone()
        };
        assert!(python(&conda, &["-V"]).unwrap().args[5]
            .contains("conda activate 'tools' && exec python '-I'"));
        let default = Environment {
            python: Python::Default,
            ..env
        };
        assert!(python(&default, &[]).unwrap().args[5].starts_with("exec python3.12 "));
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
        let posix = Environment {
            machine: Machine::Posix,
            ..env
        };
        assert_eq!(python(&posix, &[]).unwrap().program, "conda");
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
        // a folder that is removed on a fresh install must be one folder
        assert!(bad(|r| r.name = "..".into()));
        assert!(bad(|r| r.app = ".".into()));
        assert!(bad(|r| r.name = ".hidden".into()));
        assert!(bad(|r| r.python = "3.12; rm".into()));
        assert!(bad(|r| r.packages.push("--index-url=http://x".into())));
        assert!(bad(|r| r.wheels.push("a\nb".into())));
        assert!(bad(|r| r.lockfile = Some(" ".into())));
        assert!(bad(|r| r.check = String::new()));
        let mut r = recipe();
        r.name = "a b".into();
        assert_eq!(r.problem().unwrap().code, "recipe.name");
    }

    #[test]
    fn installs_only_what_this_computer_can_have() {
        assert_eq!(Own::Posix.here().is_ok(), !cfg!(windows));
        assert_eq!(Own::Windows.here().is_ok(), cfg!(windows));
        let wsl = Own::Wsl { distro: "U".into() };
        assert!(wsl.supported_on(Os::Windows).is_ok() && wsl.supported_on(Os::Posix).is_err());
        assert!(Own::Posix.supported_on(Os::Posix).is_ok());
        assert!(Own::Posix.native() && Own::Windows.native() && !wsl.native());
    }

    #[test]
    fn the_gpu_probe_names_what_it_found() {
        assert!(wsl_gpu_probe("a;b").is_err());
        let p = wsl_gpu_probe("Ubuntu").unwrap();
        assert_eq!(p.args[5], GPU_PROBE);
        // WSL's default distribution, as `wsl()` takes it
        let d = wsl_gpu_probe("").unwrap();
        assert_eq!(&d.args[..3], ["--exec", "bash", "-lc"]);
        let found = gpu_found(&["GPU\tGPU 0: NVIDIA GeForce RTX 4060 Ti (UUID: GPU-1)".into()]);
        assert_eq!(
            found.as_deref(),
            Some("GPU 0: NVIDIA GeForce RTX 4060 Ti (UUID: GPU-1)")
        );
        assert_eq!(gpu_found(&[]), None);
        assert_eq!(gpu_found(&["GPU\t  ".into()]), None);
    }
}
