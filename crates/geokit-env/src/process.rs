// Starting the programs `programs.rs` builds and telling the page what they
// say. The page never names a program: it asks for something to be started,
// and the app's core builds what that is. No console window opens; output
// comes back line by line. What reaches the page (a Tauri channel, an event)
// is the app's own `Sink`.
//
// A program is a tree: what it starts, and what that starts. `Processes`
// owns the whole tree. Killing a program ends all of it, and a program's end
// is told (and a `Held` GPU Lease given back) only once the tree is gone, so
// the Lease is never free while something it covers still runs.
//
// What starts programs is a `Spawner`, a seam with two adapters: `OsSpawner`,
// which puts each program in a Job Object (Windows) or a process group
// (elsewhere), and `scripted::Scripted`, for tests, which says what it is
// told to and ends when it is told.

pub mod os;
pub mod scripted;

use crate::problem::Problem;
use crate::programs::Program;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub use os::OsSpawner;

/// How a program came to its end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum How {
    /// It ended by itself: with its exit code, or with none when a signal took it.
    Ended,
    /// It was killed here, and its tree with it.
    Killed,
    /// What became of it is not known: waiting for it failed.
    Lost,
}

/// A program's end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Exit {
    /// None when it was killed or lost, or a signal ended it.
    pub code: Option<i32>,
    pub how: How,
}

impl Exit {
    pub fn ended(code: Option<i32>) -> Self {
        Exit {
            code,
            how: How::Ended,
        }
    }

    /// Ended by itself with code 0.
    pub fn success(&self) -> bool {
        self.how == How::Ended && self.code == Some(0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Said {
    Out { line: String },
    Err { line: String },
    Exit { code: Option<i32>, how: How },
}

/// Where what a program says goes: the page's channel, or a list kept here.
/// It answers whether anyone still hears; once no one does, the rest is read
/// and dropped.
pub type Sink = Arc<dyn Fn(Said) -> bool + Send + Sync>;

/// A program that has been started, as the Spawner hands it over.
pub struct Spawned {
    pub out: Option<Box<dyn Read + Send>>,
    pub err: Option<Box<dyn Read + Send>>,
    pub running: Arc<dyn Running>,
}

/// A started program and everything it started.
pub trait Running: Send + Sync {
    /// Waits for the program to end, then for its whole tree to be gone
    /// (what it left behind is killed), and says how it ended. Called once.
    fn wait(&self) -> Exit;
    /// Ends the program and its whole tree. Safe to call from any thread, at
    /// any time, any number of times.
    fn kill(&self);
}

/// What starts programs: the seam between this crate's logic and the system.
pub trait Spawner: Send + Sync {
    /// `p` started, its output piped, its input closed. A program that cannot
    /// be started is a Problem, never an Exit.
    fn spawn(&self, p: &Program) -> Result<Spawned, Problem>;
}

/// The longest line told, in bytes: a longer one is told in pieces.
pub const MAX_LINE: usize = 64 * 1024;

/// How long the last lines of a program are waited for once it has ended.
const DRAIN: Duration = Duration::from_secs(3);

/// A line (or the first `cap` bytes of one) appended to `buf`; the bytes read, 0 at the end.
fn read_line_capped(r: &mut impl BufRead, buf: &mut Vec<u8>, cap: usize) -> io::Result<usize> {
    let mut total = 0;
    loop {
        let avail = match r.fill_buf() {
            Ok(a) => a,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if avail.is_empty() {
            return Ok(total);
        }
        let room = cap - buf.len();
        let (used, done) = match avail.iter().position(|&b| b == b'\n') {
            Some(i) if i < room => (i + 1, true),
            _ => (avail.len().min(room), false),
        };
        buf.extend_from_slice(&avail[..used]);
        r.consume(used);
        total += used;
        if done || buf.len() >= cap {
            return Ok(total);
        }
    }
}

/// Each line as it comes; bytes that are not UTF-8 (a Windows code page) are
/// read as best they can be, never a reason to stop reading — a pipe left
/// unread would fail the program writing to it. A line longer than
/// `MAX_LINE` is told in pieces.
fn relay(from: impl Read + Send + 'static, to: Sink, err: bool) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(from);
        let mut buf = Vec::new();
        let mut heard = true;
        loop {
            buf.clear();
            match read_line_capped(&mut reader, &mut buf, MAX_LINE) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if !heard {
                continue;
            }
            let line = String::from_utf8_lossy(&buf)
                .trim_end_matches(['\r', '\n'])
                .to_string();
            let said = if err {
                Said::Err { line }
            } else {
                Said::Out { line }
            };
            // the page gone, the rest is still read, so the program is not stopped by a full pipe
            heard = to(said);
        }
    })
}

/// Waits for `h` for up to `within`; a reader held open by something that
/// escaped is left behind rather than waited for forever.
fn join_within(h: thread::JoinHandle<()>, within: Duration) {
    let end = Instant::now() + within;
    while !h.is_finished() && Instant::now() < end {
        thread::sleep(Duration::from_millis(5));
    }
    if h.is_finished() {
        let _ = h.join();
    } else {
        log::warn!("a program's output was still open after its end");
    }
}

/// The programs started, by the id told to whoever started them.
pub struct Processes {
    spawner: Arc<dyn Spawner>,
    next: AtomicU32,
    running: Arc<Mutex<HashMap<u32, Arc<dyn Running>>>>,
}

impl Default for Processes {
    /// The system's own Spawner.
    fn default() -> Self {
        Self::new(Arc::new(OsSpawner::default()))
    }
}

/// What a program printed, once it has ended.
#[derive(Clone, Debug, PartialEq)]
pub struct Captured {
    pub exit: Exit,
    /// Its output, line by line.
    pub lines: Vec<String>,
    /// What it wrote to its error output.
    pub stderr: Vec<String>,
}

impl Captured {
    pub fn success(&self) -> bool {
        self.exit.success()
    }
}

impl Processes {
    /// Programs started by `spawner`.
    pub fn new(spawner: Arc<dyn Spawner>) -> Self {
        Processes {
            spawner,
            next: AtomicU32::new(0),
            running: Arc::default(),
        }
    }

    /// The Spawner these programs are started by.
    pub fn spawner(&self) -> &Arc<dyn Spawner> {
        &self.spawner
    }

    /// `p` started, what it says sent to `on`; its id, and where its end is told.
    pub fn start(&self, p: &Program, on: Sink) -> Result<(u32, mpsc::Receiver<Exit>), Problem> {
        self.start_holding(p, on, ())
    }

    /// `p` started as `start` starts it, `keep` held until it has ended, its
    /// tree gone, and all it had to say said: a GPU Lease's `Held`, so the
    /// next GPU Job waits for this one's end and not for whoever started it.
    pub fn start_holding<T: Send + 'static>(
        &self,
        p: &Program,
        on: Sink,
        keep: T,
    ) -> Result<(u32, mpsc::Receiver<Exit>), Problem> {
        let spawned = self.spawner.spawn(p)?;
        let running = spawned.running.clone();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        // known before anything can end, so no program is ever left unowned
        crate::locked(&self.running).insert(id, running.clone());
        log::info!("started #{id}: {}", p.program);
        log::trace!("#{id} {:?}", p.args);
        let mut readers = vec![];
        if let Some(out) = spawned.out {
            readers.push(relay(out, on.clone(), false));
        }
        if let Some(err) = spawned.err {
            readers.push(relay(err, on.clone(), true));
        }
        let all = self.running.clone();
        let (tell, ended) = mpsc::channel();
        let watcher = thread::Builder::new()
            .name(format!("geokit-wait-{id}"))
            .spawn({
                let running = running.clone();
                move || {
                    let exit = running.wait();
                    // its last lines told before its end
                    for r in readers {
                        join_within(r, DRAIN);
                    }
                    crate::locked(&all).remove(&id);
                    log::info!("ended #{id}: {exit:?}");
                    drop(keep);
                    on(Said::Exit {
                        code: exit.code,
                        how: exit.how,
                    });
                    let _ = tell.send(exit);
                }
            });
        if let Err(e) = watcher {
            running.kill();
            crate::locked(&self.running).remove(&id);
            return Err(
                Problem::new("process.thread", "A program could not be watched.").because(e),
            );
        }
        Ok((id, ended))
    }

    /// End a program started here, with its whole tree; one already ended is
    /// not an error. Its end is told as for any other.
    pub fn kill(&self, id: u32) {
        let found = crate::locked(&self.running).get(&id).cloned();
        if let Some(r) = found {
            log::info!("killing #{id}");
            r.kill();
        }
    }

    /// Every program still running, ended as the app closes.
    pub fn end_all(&self) {
        let all: Vec<_> = crate::locked(&self.running).values().cloned().collect();
        for r in all {
            r.kill();
        }
    }

    /// What `p` printed, once it has ended; killed, with its tree, and a
    /// Problem if it takes longer than `timeout`. A program that ends badly
    /// is not an error here: its `exit` says so.
    pub fn output(&self, p: &Program, timeout: Duration) -> Result<Captured, Problem> {
        #[derive(Default)]
        struct Got {
            lines: Vec<String>,
            stderr: Vec<String>,
        }
        let got = Arc::new(Mutex::new(Got::default()));
        let g = got.clone();
        let sink: Sink = Arc::new(move |s| {
            let mut g = crate::locked(&g);
            match s {
                Said::Out { line } => g.lines.push(line),
                Said::Err { line } => g.stderr.push(line),
                Said::Exit { .. } => {}
            }
            true
        });
        let (id, ended) = self.start(p, sink)?;
        let exit = match ended.recv_timeout(timeout) {
            Ok(e) => e,
            Err(_) => {
                self.kill(id);
                let _ = ended.recv_timeout(Duration::from_secs(10));
                return Err(Problem::new("process.timeout", "A program took too long.")
                    .with("program", p.program.clone())
                    .with("seconds", timeout.as_secs() as i64));
            }
        };
        let mut g = crate::locked(&got);
        Ok(Captured {
            exit,
            lines: std::mem::take(&mut g.lines),
            stderr: std::mem::take(&mut g.stderr),
        })
    }
}

/// What `p` printed, run by the system, once it has ended: see `Processes::output`.
pub fn output(p: &Program, timeout: Duration) -> Result<Captured, Problem> {
    Processes::default().output(p, timeout)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::scripted::{Script, Scripted};
    use super::*;
    use crate::programs::program;

    const LONG: Duration = Duration::from_secs(20);

    pub(crate) fn collect() -> (Sink, Arc<Mutex<Vec<Said>>>) {
        let heard = Arc::new(Mutex::new(vec![]));
        let h = heard.clone();
        let sink: Sink = Arc::new(move |s| {
            crate::locked(&h).push(s);
            true
        });
        (sink, heard)
    }

    fn scripted(s: Script) -> (Processes, Arc<Scripted>) {
        let sp = Arc::new(Scripted::always(s));
        (Processes::new(sp.clone()), sp)
    }

    #[test]
    fn says_its_lines_then_its_end() {
        let (ps, _) = scripted(Script::ok().says("one").complains("two"));
        let (sink, heard) = collect();
        let (_, ended) = ps.start(&program("x", &[]), sink).unwrap();
        assert_eq!(ended.recv_timeout(LONG).unwrap(), Exit::ended(Some(0)));
        let heard = crate::locked(&heard);
        assert_eq!(heard.len(), 3);
        assert!(heard.contains(&Said::Out { line: "one".into() }));
        assert!(heard.contains(&Said::Err { line: "two".into() }));
        assert_eq!(
            heard.last(),
            Some(&Said::Exit {
                code: Some(0),
                how: How::Ended
            })
        );
    }

    #[test]
    fn tells_a_failure_by_its_code_and_a_missing_program_at_once() {
        let (ps, _) = scripted(Script::ok().exits(3));
        let (sink, _) = collect();
        let (_, ended) = ps.start(&program("x", &[]), sink.clone()).unwrap();
        assert_eq!(ended.recv_timeout(LONG).unwrap(), Exit::ended(Some(3)));
        let (ps, _) = scripted(Script::cannot_start(Problem::new("process.spawn", "no")));
        assert_eq!(
            ps.start(&program("x", &[]), sink).unwrap_err().code,
            "process.spawn"
        );
    }

    #[test]
    fn a_killed_program_says_it_was_killed() {
        let (ps, sp) = scripted(Script::ok().says("up").until_killed());
        let (sink, heard) = collect();
        let (id, ended) = ps.start(&program("serve", &[]), sink).unwrap();
        assert!(ended.recv_timeout(Duration::from_millis(100)).is_err());
        ps.kill(id);
        ps.kill(id); // twice is no error
        let exit = ended.recv_timeout(LONG).unwrap();
        assert_eq!(
            exit,
            Exit {
                code: None,
                how: How::Killed
            }
        );
        assert_eq!(sp.killed().len(), 1);
        assert!(crate::locked(&heard).contains(&Said::Out { line: "up".into() }));
        ps.kill(id); // already ended: not an error
    }

    #[test]
    fn holds_what_it_was_given_until_the_tree_is_gone() {
        let (ps, _) = scripted(
            Script::ok()
                .until_killed()
                .takes_to_die(Duration::from_millis(300)),
        );
        let (sink, _) = collect();
        let kept = Arc::new(());
        let (id, ended) = ps
            .start_holding(&program("x", &[]), sink, kept.clone())
            .unwrap();
        assert_eq!(Arc::strong_count(&kept), 2);
        ps.kill(id);
        // killed, but its tree is still dying: still held
        thread::sleep(Duration::from_millis(100));
        assert_eq!(Arc::strong_count(&kept), 2);
        ended.recv_timeout(LONG).unwrap();
        // the watcher dropped its clone before telling the end
        assert_eq!(Arc::strong_count(&kept), 1);
    }

    #[test]
    fn end_all_kills_everything_running() {
        let (ps, sp) = scripted(Script::ok().until_killed());
        let (sink, _) = collect();
        let a = ps.start(&program("a", &[]), sink.clone()).unwrap().1;
        let b = ps.start(&program("b", &[]), sink).unwrap().1;
        ps.end_all();
        assert_eq!(a.recv_timeout(LONG).unwrap().how, How::Killed);
        assert_eq!(b.recv_timeout(LONG).unwrap().how, How::Killed);
        assert_eq!(sp.killed().len(), 2);
    }

    #[test]
    fn output_is_what_it_printed_and_how_it_ended() {
        let (ps, _) = scripted(Script::ok().says("out").complains("warn").exits(2));
        let c = ps
            .output(&program("x", &[]), Duration::from_secs(5))
            .unwrap();
        assert_eq!(c.lines, ["out"]);
        assert_eq!(c.stderr, ["warn"]);
        assert_eq!(c.exit, Exit::ended(Some(2)));
        assert!(!c.success());
    }

    #[test]
    fn output_gives_up_on_a_program_that_takes_too_long() {
        let (ps, sp) = scripted(Script::ok().until_killed());
        let e = ps
            .output(&program("x", &[]), Duration::from_millis(100))
            .unwrap_err();
        assert_eq!(e.code, "process.timeout");
        assert_eq!(sp.killed().len(), 1);
    }

    #[test]
    fn a_long_line_is_told_in_pieces() {
        let mut r = io::Cursor::new(vec![b'a'; 10]);
        let mut buf = vec![];
        assert_eq!(read_line_capped(&mut r, &mut buf, 4).unwrap(), 4);
        assert_eq!(buf, b"aaaa");
        buf.clear();
        let mut r = io::Cursor::new(b"ab\ncd".to_vec());
        read_line_capped(&mut r, &mut buf, 4).unwrap();
        assert_eq!(buf, b"ab\n");
        buf.clear();
        read_line_capped(&mut r, &mut buf, 4).unwrap();
        assert_eq!(buf, b"cd");
        buf.clear();
        assert_eq!(read_line_capped(&mut r, &mut buf, 4).unwrap(), 0);
    }

    /// A shell running `script`, on either system.
    fn shell(script: &str) -> Program {
        if cfg!(windows) {
            program("cmd.exe", &["/C", script])
        } else {
            program("sh", &["-c", script])
        }
    }

    #[test]
    fn the_system_runs_a_program_and_tells_its_lines_and_code() {
        let ps = Processes::default();
        let (sink, heard) = collect();
        let (_, ended) = ps.start(&shell("echo one&& exit 3"), sink.clone()).unwrap();
        assert_eq!(ended.recv_timeout(LONG).unwrap(), Exit::ended(Some(3)));
        assert!(crate::locked(&heard).contains(&Said::Out { line: "one".into() }));
        let e = ps
            .start(&program("no-such-program-here", &[]), sink)
            .unwrap_err();
        assert_eq!(e.code, "process.spawn");
        let c = output(&shell("echo out"), Duration::from_secs(20)).unwrap();
        assert_eq!(c.lines[0].trim(), "out");
    }

    /// The point of owning the tree: killing a program ends what it started.
    #[test]
    fn killing_a_program_ends_the_program_it_started() {
        // a marker no other program has, in the grandchild's command line
        let (script, probe) = if cfg!(windows) {
            (
                "ping -n 40 127.0.0.37 >NUL",
                vec![
                    "powershell.exe",
                    "-NoProfile",
                    "-Command",
                    "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*127.0.0.37*' -and $_.Name -eq 'PING.EXE' } | Measure-Object).Count",
                ],
            )
        } else {
            (
                "sleep 37 & wait",
                vec!["sh", "-c", "pgrep -f '[s]leep 37' | wc -l"],
            )
        };
        let count = || -> i32 {
            let out = std::process::Command::new(probe[0])
                .args(&probe[1..])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
        };
        let ps = Processes::default();
        let (sink, _) = collect();
        let (id, ended) = ps.start(&shell(script), sink).unwrap();
        let end = Instant::now() + LONG;
        while count() == 0 {
            assert!(Instant::now() < end, "the grandchild never started");
            thread::sleep(Duration::from_millis(200));
        }
        ps.kill(id);
        let exit = ended.recv_timeout(LONG).unwrap();
        assert_eq!(exit.how, How::Killed);
        // its end is told only once the tree is gone
        assert_eq!(count(), 0, "the grandchild outlived the program");
    }

    /// The Linux side of a program in WSL ends with it: set GEOKIT_WSL_DISTRO
    /// to a distribution's name and run with `cargo test -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a WSL distribution (GEOKIT_WSL_DISTRO)"]
    fn killing_a_program_in_wsl_ends_its_linux_side() {
        let Ok(distro) = std::env::var("GEOKIT_WSL_DISTRO") else {
            return;
        };
        let linux = |script: &str| -> String {
            // no `linux` side, so no file of its own to be counted
            let p = program("wsl.exe", &["-d", &distro, "--exec", "bash", "-c", script]);
            output(&p, LONG).unwrap().lines.join(
                "
",
            )
        };
        let ps = Processes::default();
        let (sink, heard) = collect();
        let p = crate::programs::wsl(&distro, "echo up; sleep 331 & wait");
        let (id, ended) = ps.start(&p, sink).unwrap();
        let end = Instant::now() + LONG;
        while !crate::locked(&heard).contains(&Said::Out { line: "up".into() }) {
            assert!(Instant::now() < end, "it never started");
            thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(linux("ps -eo args | grep -c '^sleep 331'").trim(), "1");
        ps.kill(id);
        assert_eq!(ended.recv_timeout(LONG).unwrap().how, How::Killed);
        // told ended only once the Linux side is gone, and its file with it
        assert_eq!(
            linux("ps -eo args | grep -c '^sleep 331' || true").trim(),
            "0"
        );
        assert_eq!(
            linux("ls /tmp/geokit-*.pid 2>/dev/null | wc -l").trim(),
            "0"
        );
    }
}
