// What this computer could offer as an Environment: WSL's distributions, the
// conda environments if conda is found, the Pythons on the PATH. Each is a
// question put to the system through `Processes`, so tests answer them with
// a scripted Spawner. Nothing is added to the list here: the page offers the
// candidates and the user's yes puts one there (`Environments::add`).

use crate::envs::{word, Environment, Machine, Python};
use crate::problem::Problem;
use crate::process::{Captured, Processes};
use crate::programs::{program, wsl_list, Os};
use std::time::Duration;

/// How long each question is given.
const ASK: Duration = Duration::from_secs(20);

/// What was found, and what could not be asked.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Detected {
    pub environments: Vec<Environment>,
    /// A question that failed: WSL that could not be listed, conda that
    /// failed. Not finding anything is not a problem.
    pub problems: Vec<Problem>,
}

fn tail(c: &Captured) -> String {
    let said = if c.stderr.is_empty() {
        &c.lines
    } else {
        &c.stderr
    };
    let from = said.len().saturating_sub(5);
    said[from..].join("\n")
}

/// The distributions WSL has: an Error when `wsl --list` fails or cannot be
/// run, which is not the same as there being none (an empty list).
pub fn wsl_distros(procs: &Processes) -> Result<Vec<String>, Problem> {
    let c = procs.output(&wsl_list(), ASK)?;
    if !c.success() {
        return Err(
            Problem::new("detect.wsl", "WSL could not list its distributions.")
                .with("code", c.exit.code.map_or(-1, i64::from))
                .with("output", tail(&c)),
        );
    }
    Ok(c.lines
        .iter()
        // a UTF-16 answer read as bytes has a NUL between letters
        .map(|l| l.replace(['\0', '\u{feff}'], "").trim().to_string())
        .filter(|l| !l.is_empty() && word(l))
        // WSL's own helpers, not somewhere to run an app
        .filter(|l| !l.starts_with("docker-desktop"))
        .collect())
}

/// The conda environments, by name, for a conda that answers `conda info --json`.
fn conda_names(c: &Captured) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(&c.lines.join("\n")).ok()?;
    let root = v["root_prefix"].as_str().unwrap_or_default();
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let names = v["envs"]
        .as_array()?
        .iter()
        .filter_map(|e| e.as_str())
        .filter_map(|e| {
            let e = norm(e);
            if !root.is_empty() && e == norm(root) {
                return Some("base".to_string());
            }
            // an environment with a name lives under an `envs` folder
            let (parent, name) = e.rsplit_once('/')?;
            parent.ends_with("/envs").then(|| name.to_string())
        })
        .collect();
    Some(names)
}

/// Everything this computer offers, asked of this computer's system.
pub fn detect(procs: &Processes) -> Detected {
    detect_on(Os::this(), procs)
}

/// Everything a computer of kind `os` offers: its WSL distributions (on
/// Windows), conda's environments, the Pythons on the PATH.
pub fn detect_on(os: Os, procs: &Processes) -> Detected {
    let mut found = Detected::default();
    let mut offer = |e: Environment| {
        if e.problem().is_none() && !found.environments.contains(&e) {
            found.environments.push(e);
        }
    };
    let machine = if os == Os::Windows {
        Machine::Windows
    } else {
        Machine::Posix
    };
    let mut problems = vec![];

    if os == Os::Windows {
        match wsl_distros(procs) {
            Ok(names) => {
                for distro in names {
                    offer(Environment {
                        machine: Machine::Wsl,
                        distro,
                        python: Python::Default,
                    });
                }
            }
            Err(p) if p.code == "process.spawn" => log::debug!("no wsl.exe: {p}"),
            Err(p) => problems.push(p),
        }
    }

    match procs.output(&program(machine.conda(), &["info", "--json"]), ASK) {
        // no conda here
        Err(p) if p.code == "process.spawn" => log::debug!("no conda: {p}"),
        Err(p) => problems.push(p),
        Ok(c) if !c.success() => problems.push(
            Problem::new("detect.conda", "conda could not list its environments.")
                .with("code", c.exit.code.map_or(-1, i64::from))
                .with("output", tail(&c)),
        ),
        Ok(c) => match conda_names(&c) {
            Some(names) => {
                for name in names {
                    offer(Environment {
                        machine: machine.clone(),
                        distro: String::new(),
                        python: Python::Conda { name },
                    });
                }
            }
            None => problems.push(Problem::new(
                "detect.conda",
                "conda's answer could not be understood.",
            )),
        },
    }

    let names: &[&str] = if os == Os::Windows {
        &["python"]
    } else {
        &["python3", "python"]
    };
    for name in names {
        let ask = program(name, &["-c", "import sys; print(sys.executable)"]);
        // one that is not there, or a stub that only points at a store, is not a Python
        let Ok(c) = procs.output(&ask, ASK) else {
            continue;
        };
        if !c.success() {
            continue;
        }
        if let Some(path) = c
            .lines
            .iter()
            .rev()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
        {
            offer(Environment {
                machine: machine.clone(),
                distro: String::new(),
                python: Python::Path { path: path.into() },
            });
        }
    }
    found.problems = problems;
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::scripted::{Script, Scripted};
    use crate::programs::Program;
    use std::sync::Arc;

    fn answering(f: impl Fn(&Program) -> Script + Send + Sync + 'static) -> Processes {
        Processes::new(Arc::new(Scripted::new(f)))
    }

    fn not_there() -> Script {
        Script::cannot_start(Problem::new("process.spawn", "not found"))
    }

    #[test]
    fn a_failed_wsl_list_is_not_no_distributions() {
        let none = answering(|_| Script::ok());
        assert_eq!(wsl_distros(&none).unwrap(), Vec::<String>::new());
        let failed = answering(|_| Script::ok().complains("WSL is not installed").exits(1));
        let e = wsl_distros(&failed).unwrap_err();
        assert_eq!(e.code, "detect.wsl");
        assert_eq!(e.params["output"], "WSL is not installed".into());
        let missing = answering(|_| not_there());
        assert_eq!(wsl_distros(&missing).unwrap_err().code, "process.spawn");
    }

    #[test]
    fn distributions_as_wsl_lists_them() {
        let ps = answering(|_| {
            Script::ok()
                .says("Ubuntu")
                .says("\u{feff}U\0b\0u\0n\0t\0u\0-\x002\x004\0")
                .says("docker-desktop")
                .says("")
                .says("Has Space")
        });
        assert_eq!(wsl_distros(&ps).unwrap(), ["Ubuntu", "Ubuntu-24"]);
    }

    #[test]
    fn offers_wsl_conda_and_the_pythons_on_the_path() {
        let ps = answering(|p| {
            match p.program.as_str() {
            "wsl.exe" => Script::ok().says("Ubuntu").says("Debian"),
            "conda.exe" => Script::ok().says(
                r#"{"root_prefix":"C:\\Miniconda3","envs":["C:\\Miniconda3","C:\\Miniconda3\\envs\\tools","D:\\elsewhere\\mine"]}"#,
            ),
            "python" => Script::ok().says(r"C:\Python312\python.exe"),
            _ => not_there(),
        }
        });
        let d = detect_on(Os::Windows, &ps);
        assert_eq!(d.problems, vec![]);
        let wsl = |n: &str| Environment {
            machine: Machine::Wsl,
            distro: n.into(),
            python: Python::Default,
        };
        let conda = |n: &str| Environment {
            machine: Machine::Windows,
            distro: String::new(),
            python: Python::Conda { name: n.into() },
        };
        assert_eq!(
            d.environments,
            [
                wsl("Ubuntu"),
                wsl("Debian"),
                conda("base"),
                conda("tools"),
                Environment {
                    machine: Machine::Windows,
                    distro: String::new(),
                    python: Python::Path {
                        path: r"C:\Python312\python.exe".into()
                    }
                }
            ]
        );
    }

    #[test]
    fn on_posix_there_is_no_wsl_and_a_python_is_found_once() {
        let ps = answering(|p| match p.program.as_str() {
            "python3" | "python" => Script::ok().says("/usr/bin/python3"),
            _ => not_there(),
        });
        let d = detect_on(Os::Posix, &ps);
        assert_eq!(d.environments.len(), 1);
        assert_eq!(d.environments[0].machine, Machine::Posix);
        assert!(d.problems.is_empty());
    }

    #[test]
    fn what_fails_is_said_and_what_is_missing_is_not() {
        let ps = answering(|p| match p.program.as_str() {
            "wsl.exe" => Script::ok().complains("broken").exits(1),
            "conda.exe" => Script::ok().says("not json"),
            // a store stub
            "python" => Script::ok().exits(9009),
            _ => not_there(),
        });
        let d = detect_on(Os::Windows, &ps);
        assert!(d.environments.is_empty());
        let codes: Vec<_> = d.problems.iter().map(|p| p.code.as_str()).collect();
        assert_eq!(codes, ["detect.wsl", "detect.conda"]);
        let nothing = answering(|_| not_there());
        assert_eq!(detect_on(Os::Windows, &nothing), Detected::default());
    }
}
