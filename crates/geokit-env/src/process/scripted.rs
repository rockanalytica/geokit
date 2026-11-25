// A Spawner that starts nothing: each program it is asked for says what a
// `Script` says, ends when the Script says (or when it is killed), and is
// remembered, so a test can see what was started and what was killed. For
// this crate's own tests and for an app's: no program is run, so a test of
// logic takes no real time and needs no real system.

use super::{Exit, How, Running, Spawned, Spawner};
use crate::problem::Problem;
use crate::programs::Program;
use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

/// What one scripted program does.
#[derive(Clone, Debug)]
pub struct Script {
    /// What it says, in order: (on the error output?, the line).
    lines: Vec<(bool, String)>,
    code: i32,
    /// How long it runs after its last line; None, until it is killed.
    run: Option<Duration>,
    /// The pause before each line.
    gap: Duration,
    /// How long its tree takes to be gone once it is killed.
    dying: Duration,
    start: Option<Problem>,
}

impl Script {
    /// A program that ends at once with code 0.
    pub fn ok() -> Self {
        Script {
            lines: vec![],
            code: 0,
            run: Some(Duration::ZERO),
            gap: Duration::ZERO,
            dying: Duration::ZERO,
            start: None,
        }
    }

    /// A program that cannot be started.
    pub fn cannot_start(why: Problem) -> Self {
        Script {
            start: Some(why),
            ..Self::ok()
        }
    }

    /// Says `line` on its output.
    pub fn says(mut self, line: &str) -> Self {
        self.lines.push((false, line.into()));
        self
    }

    /// Says `line` on its error output.
    pub fn complains(mut self, line: &str) -> Self {
        self.lines.push((true, line.into()));
        self
    }

    /// Ends with `code`.
    pub fn exits(mut self, code: i32) -> Self {
        self.code = code;
        self
    }

    /// Keeps running for `d` after its last line.
    pub fn runs_for(mut self, d: Duration) -> Self {
        self.run = Some(d);
        self
    }

    /// Runs until it is killed.
    pub fn until_killed(mut self) -> Self {
        self.run = None;
        self
    }

    /// Waits `d` before each line.
    pub fn pauses(mut self, d: Duration) -> Self {
        self.gap = d;
        self
    }

    /// Once killed, its tree takes `d` to be gone.
    pub fn takes_to_die(mut self, d: Duration) -> Self {
        self.dying = d;
        self
    }
}

struct Record {
    program: Program,
    killed: Arc<AtomicBool>,
}

/// The scripted Spawner. Shared (an `Arc`), it is handed to `Processes::new`
/// and kept by the test to ask what happened.
pub struct Scripted {
    script: Box<dyn Fn(&Program) -> Script + Send + Sync>,
    seen: Mutex<Vec<Record>>,
}

impl Scripted {
    /// Each program started follows the Script `f` gives for it.
    pub fn new(f: impl Fn(&Program) -> Script + Send + Sync + 'static) -> Self {
        Scripted {
            script: Box::new(f),
            seen: Mutex::new(vec![]),
        }
    }

    /// Every program follows `s`.
    pub fn always(s: Script) -> Self {
        Self::new(move |_| s.clone())
    }

    /// The programs follow `scripts` in the order they are started; one
    /// started after they run out cannot be started.
    pub fn queue(scripts: Vec<Script>) -> Self {
        let q = Mutex::new(VecDeque::from(scripts));
        Self::new(move |_| {
            crate::locked(&q).pop_front().unwrap_or_else(|| {
                Script::cannot_start(Problem::new("process.spawn", "no more scripted programs"))
            })
        })
    }

    /// Every program started, in order.
    pub fn spawned(&self) -> Vec<Program> {
        crate::locked(&self.seen)
            .iter()
            .map(|r| r.program.clone())
            .collect()
    }

    /// The programs that were killed, in the order they were started.
    pub fn killed(&self) -> Vec<Program> {
        crate::locked(&self.seen)
            .iter()
            .filter(|r| r.killed.load(Ordering::SeqCst))
            .map(|r| r.program.clone())
            .collect()
    }
}

/// What a scripted program's output is read from.
struct Pipe {
    rx: mpsc::Receiver<Vec<u8>>,
    rest: Vec<u8>,
}

impl Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.rest.is_empty() {
            match self.rx.recv() {
                Ok(b) => self.rest = b,
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.rest.len());
        buf[..n].copy_from_slice(&self.rest[..n]);
        self.rest.drain(..n);
        Ok(n)
    }
}

#[derive(Default)]
struct State {
    killed: bool,
    done: bool,
}

struct Fake {
    state: Mutex<State>,
    changed: Condvar,
    killed: Arc<AtomicBool>,
    code: i32,
}

impl Running for Fake {
    fn wait(&self) -> Exit {
        let mut s = crate::locked(&self.state);
        while !s.done {
            s = self.changed.wait(s).unwrap_or_else(|e| e.into_inner());
        }
        if s.killed {
            Exit {
                code: None,
                how: How::Killed,
            }
        } else {
            Exit::ended(Some(self.code))
        }
    }

    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        crate::locked(&self.state).killed = true;
        self.changed.notify_all();
    }
}

impl Spawner for Scripted {
    fn spawn(&self, p: &Program) -> Result<Spawned, Problem> {
        let script = (self.script)(p);
        if let Some(why) = script.start {
            return Err(why);
        }
        let killed = Arc::new(AtomicBool::new(false));
        crate::locked(&self.seen).push(Record {
            program: p.clone(),
            killed: killed.clone(),
        });
        let running = Arc::new(Fake {
            state: Mutex::default(),
            changed: Condvar::new(),
            killed,
            code: script.code,
        });
        let (out_tx, out_rx) = mpsc::channel();
        let (err_tx, err_rx) = mpsc::channel();
        let r = running.clone();
        thread::spawn(move || {
            // a pause, cut short by a kill
            let pause = |d: Duration| -> bool {
                let s = crate::locked(&r.state);
                let (s, _) = r
                    .changed
                    .wait_timeout_while(s, d, |s| !s.killed)
                    .unwrap_or_else(|e| e.into_inner());
                s.killed
            };
            let mut died = false;
            for (err, line) in &script.lines {
                if !script.gap.is_zero() && pause(script.gap) {
                    died = true;
                    break;
                }
                let tx = if *err { &err_tx } else { &out_tx };
                let _ = tx.send(format!("{line}\n").into_bytes());
            }
            if !died {
                died = match script.run {
                    Some(d) if d.is_zero() => crate::locked(&r.state).killed,
                    Some(d) => pause(d),
                    None => {
                        let s = crate::locked(&r.state);
                        let _s = r
                            .changed
                            .wait_while(s, |s| !s.killed)
                            .unwrap_or_else(|e| e.into_inner());
                        true
                    }
                };
            }
            if died {
                thread::sleep(script.dying);
            }
            drop((out_tx, err_tx));
            crate::locked(&r.state).done = true;
            r.changed.notify_all();
        });
        Ok(Spawned {
            out: Some(Box::new(Pipe {
                rx: out_rx,
                rest: vec![],
            })),
            err: Some(Box::new(Pipe {
                rx: err_rx,
                rest: vec![],
            })),
            running,
        })
    }
}
