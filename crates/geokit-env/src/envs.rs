// The Environments an app may start its Python in: a list with a default,
// kept in the app's data folder and written by the app's core alone. One
// reaches it only by the user's yes to the core's own question, which names
// what will be started; the app's own Environment is put there by the core
// when it has installed it. The page names an Environment when it starts
// something, and one not on the list is refused.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Machine {
    Windows,
    Wsl,
    Posix,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Kept {
    pub environment: Environment,
    /// Made by the app itself (its own install), rather than given by the user.
    pub own: bool,
    /// What the app installed in it, for one of its own: a version, as the app words it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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
    /// on a command line.
    pub fn problem(&self) -> Option<&'static str> {
        let mut texts = vec![self.distro.as_str()];
        match &self.python {
            Python::Path { path } => texts.push(path),
            Python::Conda { name } => texts.push(name),
            Python::Default => {}
        }
        if texts.iter().any(|s| s.contains('"')) {
            return Some("quote");
        }
        if texts.iter().any(|s| control(s)) {
            return Some("control");
        }
        if self.machine != Machine::Posix
            && texts
                .iter()
                .any(|s| s.contains(&CMD_SPECIAL[..]) || s.contains('^'))
        {
            return Some("cmd");
        }
        if self.machine == Machine::Wsl && !word(self.distro.trim()) {
            return Some("distro");
        }
        match &self.python {
            Python::Path { path } => {
                let p = path.trim();
                if p.is_empty() {
                    return Some("path_empty");
                }
                let windows_abs = p.len() > 2
                    && p.as_bytes()[0].is_ascii_alphabetic()
                    && p.as_bytes()[1] == b':'
                    && matches!(p.as_bytes()[2], b'\\' | b'/')
                    || p.starts_with(r"\\");
                if self.machine == Machine::Windows && !windows_abs {
                    return Some("path_windows");
                }
                if self.machine != Machine::Windows
                    && !(p.starts_with('/') || p.starts_with("~/") || word(p))
                {
                    return Some("path_posix");
                }
            }
            Python::Conda { name } if !word(name.trim()) || name.trim().is_empty() => {
                return Some("conda_name")
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
            Python::Default => match self.machine {
                Machine::Windows => "python".into(),
                Machine::Wsl => format!("python{}", crate::programs::DEFAULT_PYTHON),
                Machine::Posix => "python3".into(),
            },
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
}

/// The name of the list's file in the app's data folder.
pub const FILE: &str = "environments.json";

impl Environments {
    /// The list kept in `data`, or an empty one where there is none yet.
    pub fn load(data: &Path) -> Self {
        Self::load_with(data, |_| {})
    }

    /// The list kept in `data`, its JSON first handed to `migrate`: where an
    /// app moves what an older version of it wrote.
    pub fn load_with(data: &Path, migrate: impl FnOnce(&mut serde_json::Value)) -> Self {
        let file = data.join(FILE);
        let list = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|mut v| {
                migrate(&mut v);
                serde_json::from_value::<List>(v).ok()
            })
            .unwrap_or_default();
        Environments {
            file: Some(file),
            list: Mutex::new(list),
        }
    }

    /// A list kept nowhere: for tests, and for an app that has no data folder yet.
    pub fn in_memory() -> Self {
        Environments {
            file: None,
            list: Mutex::new(List::default()),
        }
    }

    pub fn list(&self) -> List {
        self.list.lock().map(|l| l.clone()).unwrap_or_default()
    }

    /// Whether `env` is on the list, as it is written there.
    pub fn has(&self, env: &Environment) -> bool {
        let env = env.trimmed();
        self.list
            .lock()
            .map(|l| l.environments.iter().any(|k| k.environment == env))
            .unwrap_or(false)
    }

    /// The default Environment, if the list has one.
    pub fn default_environment(&self) -> Option<Environment> {
        let l = self.list.lock().ok()?;
        l.environments
            .get(l.default?)
            .map(|k| k.environment.clone())
    }

    fn change(&self, f: impl FnOnce(&mut List) -> Result<(), String>) -> Result<List, String> {
        let mut l = self.list.lock().map_err(|e| e.to_string())?;
        f(&mut l)?;
        if let Some(file) = &self.file {
            let json = serde_json::to_vec_pretty(&*l).map_err(|e| e.to_string())?;
            let part = file.with_extension("json.part");
            fs::write(&part, json).map_err(|e| e.to_string())?;
            fs::rename(&part, file).map_err(|e| e.to_string())?;
        }
        Ok(l.clone())
    }

    /// `env` put on the list, where it is not there yet, and made the default.
    /// The caller has the user's yes, or made it itself (`own`).
    pub fn add(&self, env: &Environment, own: bool) -> Result<List, String> {
        let env = env.trimmed();
        if let Some(why) = env.problem() {
            return Err(format!("refused Environment: {why}"));
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
    /// list as the default, in place of the one it made before on the same machine.
    pub fn add_own(&self, env: &Environment, installed: &str) -> Result<List, String> {
        let env = env.trimmed();
        if let Some(why) = env.problem() {
            return Err(format!("refused Environment: {why}"));
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

    pub fn set_default(&self, index: usize) -> Result<List, String> {
        self.change(|l| {
            if index >= l.environments.len() {
                return Err("no such Environment".into());
            }
            l.default = Some(index);
            Ok(())
        })
    }

    pub fn remove(&self, index: usize) -> Result<List, String> {
        self.change(|l| {
            if index >= l.environments.len() {
                return Err("no such Environment".into());
            }
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

    #[test]
    fn checked_for_the_command_line() {
        assert_eq!(
            path(Machine::Windows, "", r"C:\py\python.exe").problem(),
            None
        );
        assert_eq!(
            path(Machine::Windows, "", "python.exe").problem(),
            Some("path_windows")
        );
        assert_eq!(
            path(Machine::Windows, "", r"C:\a&b\python.exe").problem(),
            Some("cmd")
        );
        assert_eq!(
            path(Machine::Wsl, "Ubuntu", "~/.venvs/g/bin/python").problem(),
            None
        );
        assert_eq!(
            path(Machine::Wsl, "Ubu ntu", "/usr/bin/python3").problem(),
            Some("distro")
        );
        assert_eq!(
            path(Machine::Wsl, "Ubuntu", "C:\\x").problem(),
            Some("path_posix")
        );
        assert_eq!(path(Machine::Posix, "", "/a\"b").problem(), Some("quote"));
        assert_eq!(path(Machine::Posix, "", "/a\nb").problem(), Some("control"));
        let conda = |n: &str| Environment {
            machine: Machine::Windows,
            distro: String::new(),
            python: Python::Conda { name: n.into() },
        };
        assert_eq!(conda("tools").problem(), None);
        assert_eq!(conda("to ols").problem(), Some("conda_name"));
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
        let l = e.remove(0).unwrap();
        assert_eq!((l.environments.len(), l.default), (1, Some(0)));
        assert!(!e.has(&a));
        assert!(e.add(&path(Machine::Windows, "", "python"), false).is_err());
        assert!(e.set_default(5).is_err() && e.remove(5).is_err());
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
    }

    #[test]
    fn kept_on_disk_and_read_back_through_a_migration() {
        let dir = tempfile::tempdir().unwrap();
        let e = Environments::load(dir.path());
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
        assert_eq!(
            moved.list().environments[0].installed.as_deref(),
            Some("0.9")
        );
        // unreadable, it is an empty list rather than an error
        std::fs::write(dir.path().join(FILE), b"not json").unwrap();
        assert!(Environments::load(dir.path())
            .list()
            .environments
            .is_empty());
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
    }
}
