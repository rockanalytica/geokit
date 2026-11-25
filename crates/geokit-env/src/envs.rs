// The Environments an app may start its Python in: a list with a default,
// kept in the app's data folder and written by the app's core alone. One
// reaches it only by the user's yes to the core's own question, which names
// what will be started; the app's own Environment is put there by the core
// when it has installed it. The page names an Environment when it starts
// something, and one not on the list is refused.

use crate::problem::Problem;
use crate::programs::DEFAULT_PYTHON;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Machine {
    Windows,
    Wsl,
    Posix,
}

impl Machine {
    /// What starts the Python an Environment of `Python::Default` names: the
    /// one place this is spelled.
    pub fn default_python(&self) -> String {
        match self {
            Machine::Windows => "python".into(),
            Machine::Wsl => format!("python{DEFAULT_PYTHON}"),
            Machine::Posix => "python3".into(),
        }
    }

    /// What starts conda, where `Python::Conda` is used.
    pub fn conda(&self) -> &'static str {
        match self {
            Machine::Windows => "conda.exe",
            Machine::Wsl | Machine::Posix => "conda",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Python {
    Path { path: String },
    Conda { name: String },
    Default,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Environment {
    pub machine: Machine,
    pub distro: String,
    pub python: Python,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Kept {
    pub environment: Environment,
    /// Made by the app itself (its own install), rather than given by the user.
    pub own: bool,
    /// What the app installed in it, for one of its own: a version, as the app words it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct List {
    pub environments: Vec<Kept>,
    pub default: Option<usize>,
}

/// What cmd reads as its own inside a .bat line.
const CMD_SPECIAL: [char; 6] = ['%', '!', '&', '|', '<', '>'];

fn control(s: &str) -> bool {
    s.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}')
}

/// Letters, digits, `_`, `.` and `-` only: a name safe on any command line.
pub fn word(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

impl Environment {
    /// The same Environment with what is typed trimmed, as it is kept and compared.
    pub fn trimmed(&self) -> Environment {
        Environment {
            machine: self.machine.clone(),
            distro: if self.machine == Machine::Wsl {
                self.distro.trim().into()
            } else {
                String::new()
            },
            python: match &self.python {
                Python::Path { path } => Python::Path {
                    path: path.trim().into(),
                },
                Python::Conda { name } => Python::Conda {
                    name: name.trim().into(),
                },
                Python::Default => Python::Default,
            },
        }
    }

    /// Why it cannot be used, or None: the shape of what the core will put
    /// on a command line. The codes are `env.quote`, `env.control`,
    /// `env.cmd`, `env.distro`, `env.path_empty`, `env.path_windows`,
    /// `env.path_posix` and `env.conda_name`.
    pub fn problem(&self) -> Option<Problem> {
        let no = |code: &str, english: &str| Some(Problem::new(code, english));
        let mut texts = vec![self.distro.as_str()];
        match &self.python {
            Python::Path { path } => texts.push(path),
            Python::Conda { name } => texts.push(name),
            Python::Default => {}
        }
        if texts.iter().any(|s| s.contains('"')) {
            return no("env.quote", "A quotation mark cannot be used here.");
        }
        if texts.iter().any(|s| control(s)) {
            return no("env.control", "A control character cannot be used here.");
        }
        if self.machine != Machine::Posix
            && texts
                .iter()
                .any(|s| s.contains(&CMD_SPECIAL[..]) || s.contains('^'))
        {
            return no(
                "env.cmd",
                "One of % ! & | < > ^ cannot be used in a Windows command.",
            );
        }
        if self.machine == Machine::Wsl && !word(self.distro.trim()) {
            return Some(
                Problem::new("env.distro", "That is not a WSL distribution's name.")
                    .with("distro", self.distro.trim()),
            );
        }
        match &self.python {
            Python::Path { path } => {
                let p = path.trim();
                if p.is_empty() {
                    return no("env.path_empty", "A path is needed.");
                }
                let windows_abs = p.len() > 2
                    && p.as_bytes()[0].is_ascii_alphabetic()
                    && p.as_bytes()[1] == b':'
                    && matches!(p.as_bytes()[2], b'\\' | b'/')
                    || p.starts_with(r"\\");
                if self.machine == Machine::Windows && !windows_abs {
                    return no("env.path_windows", "A full Windows path is needed.");
                }
                if self.machine != Machine::Windows
                    && !(p.starts_with('/') || p.starts_with("~/") || word(p))
                {
                    return no(
                        "env.path_posix",
                        "A full path (or one from ~/) or a command name is needed.",
                    );
                }
            }
            Python::Conda { name } if !word(name.trim()) || name.trim().is_empty() => {
                return no("env.conda_name", "That is not a conda environment's name.");
            }
            _ => {}
        }
        None
    }

    /// What will be started, as the user is asked about it: the machine and the Python.
    pub fn described(&self) -> String {
        let machine = match self.machine {
            Machine::Windows => "Windows".to_string(),
            Machine::Wsl if self.distro.is_empty() => "WSL".to_string(),
            Machine::Wsl => format!("WSL ({})", self.distro),
            Machine::Posix => "this computer".to_string(),
        };
        let python = match &self.python {
            Python::Path { path } => path.clone(),
            Python::Conda { name } => format!("conda run -n {name}"),
            Python::Default => self.machine.default_python(),
        };
        format!("{machine}: {python}")
    }
}

/// Whether two Environments run on the same machine: both Windows, or WSL's same distribution.
fn same_place(a: &Environment, b: &Environment) -> bool {
    a.machine == b.machine && a.distro == b.distro
}

pub struct Environments {
    file: Option<PathBuf>,
    list: Mutex<List>,
    /// What was wrong with the file when it was read, if anything.
    load_problem: Option<Problem>,
    /// Set when the file could not be read at all: it may well be fine, so
    /// nothing is written over it.
    blocked: bool,
}

/// The name of the list's file in the app's data folder.
pub const FILE: &str = "environments.json";

/// `file` moved aside under the first name not taken: `.bad`, `.bad.1`, …
fn keep_aside(file: &Path) -> io::Result<PathBuf> {
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned());
    let name = name.unwrap_or_else(|| FILE.into());
    for n in 0.. {
        let ext = if n == 0 {
            format!("{name}.bad")
        } else {
            format!("{name}.bad.{n}")
        };
        let to = file.with_file_name(ext);
        if !to.exists() {
            fs::rename(file, &to)?;
            return Ok(to);
        }
    }
    unreachable!()
}

impl Environments {
    /// The list kept in `data`, or an empty one where there is none yet. A
    /// file that cannot be understood is kept aside (`environments.json.bad`)
    /// and the list is empty; `load_problem` says so.
    pub fn load(data: &Path) -> Self {
        Self::load_with(data, |_| {})
    }

    /// The list kept in `data`, its JSON first handed to `migrate`: where an
    /// app moves what an older version of it wrote.
    pub fn load_with(data: &Path, migrate: impl FnOnce(&mut serde_json::Value)) -> Self {
        let file = data.join(FILE);
        let mut load_problem = None;
        let mut blocked = false;
        let mut list = match fs::read(&file) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => List::default(),
            Err(e) => {
                blocked = true;
                load_problem = Some(
                    Problem::new(
                        "env.load_read",
                        "The list of Environments could not be read.",
                    )
                    .because(e),
                );
                List::default()
            }
            Ok(bytes) => {
                match serde_json::from_slice::<serde_json::Value>(&bytes).and_then(|mut v| {
                    migrate(&mut v);
                    serde_json::from_value::<List>(v)
                }) {
                    Ok(l) => l,
                    Err(e) => {
                        let mut p = Problem::new(
                        "env.load_corrupt",
                        "The list of Environments could not be understood; it was kept aside and the list is empty.",
                    )
                    .because(e);
                        match keep_aside(&file) {
                            Ok(to) => p = p.with("kept", to.display().to_string()),
                            Err(e) => {
                                // not moved: not written over either
                                blocked = true;
                                p = p.with("kept_failed", e.to_string());
                            }
                        }
                        log::warn!("{p}");
                        load_problem = Some(p);
                        List::default()
                    }
                }
            }
        };
        // a default past the end of the list is no default
        if list.default.is_some_and(|d| d >= list.environments.len()) {
            list.default = None;
        }
        Environments {
            file: Some(file),
            list: Mutex::new(list),
            load_problem,
            blocked,
        }
    }

    /// A list kept nowhere: for tests, and for an app that has no data folder yet.
    pub fn in_memory() -> Self {
        Environments {
            file: None,
            list: Mutex::new(List::default()),
            load_problem: None,
            blocked: false,
        }
    }

    /// What was wrong with the kept list when it was loaded: it could not be
    /// read, or understood (then it is kept aside). None when all was well.
    pub fn load_problem(&self) -> Option<&Problem> {
        self.load_problem.as_ref()
    }

    pub fn list(&self) -> List {
        crate::locked(&self.list).clone()
    }

    /// Whether `env` is on the list, as it is written there.
    pub fn has(&self, env: &Environment) -> bool {
        let env = env.trimmed();
        crate::locked(&self.list)
            .environments
            .iter()
            .any(|k| k.environment == env)
    }

    /// What is kept of `env`, if it is on the list.
    pub fn get(&self, env: &Environment) -> Option<Kept> {
        let env = env.trimmed();
        crate::locked(&self.list)
            .environments
            .iter()
            .find(|k| k.environment == env)
            .cloned()
    }

    /// The default Environment, if the list has one.
    pub fn default_environment(&self) -> Option<Environment> {
        let l = crate::locked(&self.list);
        l.environments
            .get(l.default?)
            .map(|k| k.environment.clone())
    }

    /// `f` applied to the list and the result written; if either fails the
    /// list stays as it was.
    fn change(&self, f: impl FnOnce(&mut List) -> Result<(), Problem>) -> Result<List, Problem> {
        if self.blocked {
            return Err(self.load_problem.clone().unwrap_or_else(|| {
                Problem::new(
                    "env.load_read",
                    "The list of Environments could not be read.",
                )
            }));
        }
        let mut l = crate::locked(&self.list);
        let before = l.clone();
        let done = f(&mut l).and_then(|()| self.write(&l));
        if let Err(e) = done {
            *l = before;
            return Err(e);
        }
        Ok(l.clone())
    }

    fn write(&self, l: &List) -> Result<(), Problem> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let no = |e: &dyn std::fmt::Display| {
            Problem::new("env.write", "The list of Environments could not be saved.").because(e)
        };
        let json = serde_json::to_vec_pretty(l).map_err(|e| no(&e))?;
        let part = file.with_extension("json.part");
        fs::write(&part, json).map_err(|e| no(&e))?;
        fs::rename(&part, file).map_err(|e| {
            let _ = fs::remove_file(&part);
            no(&e)
        })
    }

    /// `env` put on the list, where it is not there yet, and made the default.
    /// The caller has the user's yes, or made it itself (`own`).
    pub fn add(&self, env: &Environment, own: bool) -> Result<List, Problem> {
        let env = env.trimmed();
        if let Some(why) = env.problem() {
            return Err(why);
        }
        self.change(|l| {
            let at = match l.environments.iter().position(|k| k.environment == env) {
                Some(i) => i,
                None => {
                    l.environments.push(Kept {
                        environment: env,
                        own,
                        installed: None,
                    });
                    l.environments.len() - 1
                }
            };
            l.default = Some(at);
            Ok(())
        })
    }

    /// The app's own Environment, just installed with `installed`, put on the
    /// list as the default, in place of the one it made before on the same
    /// machine. (The older one's folder is left where it is.)
    pub fn add_own(&self, env: &Environment, installed: &str) -> Result<List, Problem> {
        let env = env.trimmed();
        if let Some(why) = env.problem() {
            return Err(why);
        }
        self.change(|l| {
            l.environments
                .retain(|k| !(k.own && same_place(&k.environment, &env)) || k.environment == env);
            let at = match l.environments.iter().position(|k| k.environment == env) {
                Some(i) => i,
                None => {
                    l.environments.push(Kept {
                        environment: env.clone(),
                        own: true,
                        installed: None,
                    });
                    l.environments.len() - 1
                }
            };
            if let Some(k) = l.environments.get_mut(at) {
                k.own = true;
                k.installed = Some(installed.into());
            }
            l.default = Some(at);
            Ok(())
        })
    }

    /// `env` made the default. Named by value, not by place: a page holding
    /// an older list cannot choose another Environment than the one it saw.
    pub fn set_default(&self, env: &Environment) -> Result<List, Problem> {
        let env = env.trimmed();
        self.change(|l| {
            let at = l
                .environments
                .iter()
                .position(|k| k.environment == env)
                .ok_or_else(not_listed)?;
            l.default = Some(at);
            Ok(())
        })
    }

    /// `env` taken off the list (its folder, if it has one, is left; see
    /// `install::uninstall`). Named by value, as for `set_default`.
    pub fn remove(&self, env: &Environment) -> Result<List, Problem> {
        let env = env.trimmed();
        self.change(|l| {
            let index = l
                .environments
                .iter()
                .position(|k| k.environment == env)
                .ok_or_else(not_listed)?;
            l.environments.remove(index);
            l.default = match l.default {
                Some(d) if d == index => (!l.environments.is_empty()).then_some(0),
                Some(d) if d > index => Some(d - 1),
                d => d,
            };
            Ok(())
        })
    }
}

fn not_listed() -> Problem {
    Problem::new("env.not_listed", "That Environment is not on the list.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(machine: Machine, distro: &str, p: &str) -> Environment {
        Environment {
            machine,
            distro: distro.into(),
            python: Python::Path { path: p.into() },
        }
    }

    fn code(e: &Environment) -> Option<String> {
        e.problem().map(|p| p.code)
    }

    #[test]
    fn checked_for_the_command_line() {
        let c = |s: &str| Some(s.to_string());
        assert_eq!(code(&path(Machine::Windows, "", r"C:\py\python.exe")), None);
        assert_eq!(
            code(&path(Machine::Windows, "", "python.exe")),
            c("env.path_windows")
        );
        assert_eq!(
            code(&path(Machine::Windows, "", r"C:\a&b\python.exe")),
            c("env.cmd")
        );
        assert_eq!(
            code(&path(Machine::Wsl, "Ubuntu", "~/.venvs/g/bin/python")),
            None
        );
        assert_eq!(
            code(&path(Machine::Wsl, "Ubu ntu", "/usr/bin/python3")),
            c("env.distro")
        );
        assert_eq!(
            code(&path(Machine::Wsl, "Ubuntu", "C:\\x")),
            c("env.path_posix")
        );
        assert_eq!(code(&path(Machine::Posix, "", "/a\"b")), c("env.quote"));
        assert_eq!(code(&path(Machine::Posix, "", "/a\nb")), c("env.control"));
        let conda = |n: &str| Environment {
            machine: Machine::Windows,
            distro: String::new(),
            python: Python::Conda { name: n.into() },
        };
        assert_eq!(code(&conda("tools")), None);
        assert_eq!(code(&conda("to ols")), c("env.conda_name"));
    }

    #[test]
    fn a_list_with_a_default() {
        let e = Environments::in_memory();
        let a = path(Machine::Windows, "", r"C:\a\python.exe");
        let b = path(Machine::Wsl, "Ubuntu", "~/b/bin/python");
        assert!(!e.has(&a));
        assert_eq!(e.default_environment(), None);
        e.add(&a, false).unwrap();
        let l = e.add(&b, false).unwrap();
        assert_eq!((l.environments.len(), l.default), (2, Some(1)));
        assert_eq!(e.default_environment(), Some(b.clone()));
        // added again, it is not doubled: it becomes the default
        let l = e
            .add(&path(Machine::Windows, "", r"  C:\a\python.exe "), false)
            .unwrap();
        assert_eq!((l.environments.len(), l.default), (2, Some(0)));
        assert!(e.has(&a));
        let l = e.remove(&a).unwrap();
        assert_eq!((l.environments.len(), l.default), (1, Some(0)));
        assert!(!e.has(&a));
        assert!(e.add(&path(Machine::Windows, "", "python"), false).is_err());
    }

    #[test]
    fn a_page_with_a_stale_list_changes_what_it_saw_or_nothing() {
        let e = Environments::in_memory();
        let a = path(Machine::Windows, "", r"C:\a\python.exe");
        let b = path(Machine::Wsl, "Ubuntu", "~/b/bin/python");
        let c = path(Machine::Posix, "", "/c/bin/python");
        e.add(&a, false).unwrap();
        e.add(&b, false).unwrap();
        e.add(&c, false).unwrap();
        // the page saw [a, b, c]; a is removed elsewhere; the page asks for b
        e.remove(&a).unwrap();
        let l = e.set_default(&b).unwrap();
        assert_eq!(l.environments[l.default.unwrap()].environment, b);
        // and asks to remove a, which is gone: not the one that took its place
        let err = e.remove(&a).unwrap_err();
        assert_eq!(err.code, "env.not_listed");
        assert_eq!(e.list().environments.len(), 2);
        assert_eq!(e.set_default(&a).unwrap_err().code, "env.not_listed");
        // a default kept by value follows its Environment as others go
        let l = e.remove(&c).unwrap();
        assert_eq!(l.default, Some(0));
    }

    #[test]
    fn the_apps_own_replaces_the_one_it_made_before() {
        let e = Environments::in_memory();
        let old = path(
            Machine::Windows,
            "",
            r"C:\d\environments\old\Scripts\python.exe",
        );
        let users = path(Machine::Wsl, "Ubuntu", "~/.venvs/mine/bin/python");
        e.add(&old, true).unwrap();
        e.add(&users, false).unwrap();
        let new = path(
            Machine::Windows,
            "",
            r"C:\d\environments\app\Scripts\python.exe",
        );
        let l = e.add_own(&new, "1.2.0").unwrap();
        // the old one gone, the user's kept, the new one the default with its version
        assert_eq!(l.environments.len(), 2);
        assert!(!e.has(&old) && e.has(&users));
        let d = &l.environments[l.default.unwrap()];
        assert_eq!((d.own, d.installed.as_deref()), (true, Some("1.2.0")));
        // upgraded again in place: still one
        let l = e.add_own(&new, "1.3.0").unwrap();
        assert_eq!(l.environments.len(), 2);
        assert_eq!(
            l.environments[l.default.unwrap()].installed.as_deref(),
            Some("1.3.0")
        );
        assert_eq!(e.get(&new).unwrap().installed.as_deref(), Some("1.3.0"));
    }

    #[test]
    fn kept_on_disk_and_read_back_through_a_migration() {
        let dir = tempfile::tempdir().unwrap();
        let e = Environments::load(dir.path());
        assert!(e.load_problem().is_none());
        let a = path(Machine::Windows, "", r"C:\a\python.exe");
        e.add_own(&a, "1.0.0").unwrap();
        assert!(dir.path().join(FILE).exists());
        assert!(!dir.path().join("environments.json.part").exists());
        assert!(Environments::load(dir.path()).has(&a));
        // an older app's key, moved by the app that reads it
        std::fs::write(
            dir.path().join(FILE),
            r#"{"environments":[{"environment":{"machine":"windows","distro":"","python":{"kind":"default"}},"own":true,"old_key":"0.9"}],"default":0}"#,
        )
        .unwrap();
        let moved = Environments::load_with(dir.path(), |v| {
            let k = &mut v["environments"][0];
            if let Some(old) = k.as_object_mut().and_then(|o| o.remove("old_key")) {
                k["installed"] = old;
            }
        });
        assert!(moved.load_problem().is_none());
        assert_eq!(
            moved.list().environments[0].installed.as_deref(),
            Some("0.9")
        );
    }

    #[test]
    fn an_unreadable_list_is_kept_aside_and_said_so() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE);
        std::fs::write(&file, b"not json").unwrap();
        let e = Environments::load(dir.path());
        assert!(e.list().environments.is_empty());
        let p = e.load_problem().unwrap();
        assert_eq!(p.code, "env.load_corrupt");
        assert_eq!(
            std::fs::read(dir.path().join("environments.json.bad")).unwrap(),
            b"not json"
        );
        // the next change does not lose it
        e.add(&path(Machine::Posix, "", "/p/bin/python"), false)
            .unwrap();
        assert!(Environments::load(dir.path()).load_problem().is_none());
        assert!(dir.path().join("environments.json.bad").exists());
        // a second one does not overwrite the first
        std::fs::write(&file, b"{").unwrap();
        Environments::load(dir.path());
        assert_eq!(
            std::fs::read(dir.path().join("environments.json.bad")).unwrap(),
            b"not json"
        );
        assert_eq!(
            std::fs::read(dir.path().join("environments.json.bad.1")).unwrap(),
            b"{"
        );
    }

    #[test]
    fn a_default_past_the_end_is_no_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), r#"{"environments":[],"default":3}"#).unwrap();
        let e = Environments::load(dir.path());
        assert_eq!(e.list().default, None);
        assert_eq!(e.default_environment(), None);
    }

    #[test]
    fn a_change_that_cannot_be_written_is_not_made() {
        let dir = tempfile::tempdir().unwrap();
        let e = Environments::load(dir.path());
        let a = path(Machine::Posix, "", "/a/bin/python");
        e.add(&a, false).unwrap();
        // the folder gone: the write fails
        let gone = dir.path().join("gone");
        std::fs::create_dir(&gone).unwrap();
        let e = Environments::load(&gone);
        e.add(&a, false).unwrap();
        std::fs::remove_dir_all(&gone).unwrap();
        let b = path(Machine::Posix, "", "/b/bin/python");
        let err = e.add(&b, false).unwrap_err();
        assert_eq!(err.code, "env.write");
        assert!(!e.has(&b), "memory is what is on disk");
        assert_eq!(e.list().environments.len(), 1);
        assert_eq!(e.remove(&a).unwrap_err().code, "env.write");
        assert!(e.has(&a));
    }

    #[test]
    fn a_poisoned_list_is_still_read() {
        let e = std::sync::Arc::new(Environments::in_memory());
        let e2 = e.clone();
        let _ = std::thread::spawn(move || {
            let _g = e2.list.lock().unwrap();
            panic!("a holder panicked");
        })
        .join();
        assert!(e.list.is_poisoned());
        assert!(e.list().environments.is_empty());
        e.add(&path(Machine::Posix, "", "/a/bin/python"), false)
            .unwrap();
        assert!(e.default_environment().is_some());
    }

    #[test]
    fn read_as_the_page_writes_it() {
        let env: Environment = serde_json::from_str(
            r#"{"machine":"wsl","distro":"Ubuntu","python":{"kind":"conda","name":"tools"}}"#,
        )
        .unwrap();
        assert_eq!(env.described(), "WSL (Ubuntu): conda run -n tools");
        let d: Environment = serde_json::from_str(
            r#"{"machine":"windows","distro":"","python":{"kind":"default"}}"#,
        )
        .unwrap();
        assert_eq!(d.described(), "Windows: python");
        assert_eq!(Machine::Wsl.default_python(), "python3.12");
    }
}
