// Starting the programs `programs.rs` builds and telling the page what they
// say. The page never names a program: it asks for something to be started,
// and the app's core builds what that is. No console window opens; output
// comes back line by line. What reaches the page (a Tauri channel, an event)
// is the app's own `Sink`.

use crate::programs::Program;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Default)]
pub struct Processes {
    next: AtomicU32,
    running: Arc<Mutex<HashMap<u32, Child>>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Said {
    Out { line: String },
    Err { line: String },
    Exit { code: Option<i32> },
}

/// Where what a program says goes: the page's channel, or a list kept here.
/// It answers whether anyone still hears; once no one does, the rest is read
/// and dropped.
pub type Sink = Arc<dyn Fn(Said) -> bool + Send + Sync>;

/// Each line as it comes; bytes that are not UTF-8 (a Windows code page) are
/// read as best they can be, never a reason to stop reading — a pipe left
/// unread would fail the program writing to it.
fn relay(from: impl Read + Send + 'static, to: Sink, err: bool) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(from);
        let mut buf = Vec::new();
        let mut heard = true;
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
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

fn command(p: &Program) -> Command {
    let mut cmd = Command::new(&p.program);
    cmd.args(&p.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &p.env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

impl Processes {
    /// `p` started, what it says sent to `on`; its id, and where its end is told.
    pub fn start(
        &self,
        p: &Program,
        on: Sink,
    ) -> Result<(u32, mpsc::Receiver<Option<i32>>), String> {
        self.start_holding(p, on, ())
    }

    /// `p` started as `start` starts it, `keep` held until it has ended and
    /// said all it had to: a GPU Lease's `Held`, so the next GPU Job waits
    /// for this one's end and not for whoever started it.
    pub fn start_holding<T: Send + 'static>(
        &self,
        p: &Program,
        on: Sink,
        keep: T,
    ) -> Result<(u32, mpsc::Receiver<Option<i32>>), String> {
        let mut child = command(p)
            .spawn()
            .map_err(|e| format!("{}: {e}", p.program))?;
        let mut readers = vec![];
        if let Some(out) = child.stdout.take() {
            readers.push(relay(out, on.clone(), false));
        }
        if let Some(err) = child.stderr.take() {
            readers.push(relay(err, on.clone(), true));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.running
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, child);
        let running = self.running.clone();
        let (tell, ended) = mpsc::channel();
        thread::spawn(move || {
            let code = loop {
                thread::sleep(Duration::from_millis(50));
                let Ok(mut all) = running.lock() else {
                    break None;
                };
                let Some(child) = all.get_mut(&id) else {
                    break None;
                };
                let code = match child.try_wait() {
                    Ok(Some(status)) => status.code(),
                    Ok(None) => continue,
                    Err(_) => None,
                };
                all.remove(&id);
                break code;
            };
            // its last lines told before its end
            for r in readers {
                let _ = r.join();
            }
            drop(keep);
            on(Said::Exit { code });
            let _ = tell.send(code);
        });
        Ok((id, ended))
    }

    /// End a program started here; one already ended is not an error.
    pub fn kill(&self, id: u32) -> Result<(), String> {
        let mut all = self.running.lock().map_err(|e| e.to_string())?;
        if let Some(child) = all.get_mut(&id) {
            let _ = child.kill();
        }
        Ok(())
    }

    /// Every program still running, ended as the app closes.
    pub fn end_all(&self) {
        if let Ok(mut all) = self.running.lock() {
            for child in all.values_mut() {
                let _ = child.kill();
            }
        }
    }
}

/// What `p` printed to its output, once it has ended.
pub fn output(p: &Program) -> Result<Vec<String>, String> {
    let out = command(p)
        .output()
        .map_err(|e| format!("{}: {e}", p.program))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_owned)
        .collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::programs::program;

    /// A shell running `script`, on either system.
    pub(crate) fn shell(script: &str) -> Program {
        if cfg!(windows) {
            program("cmd.exe", &["/C", script])
        } else {
            program("sh", &["-c", script])
        }
    }

    pub(crate) fn collect() -> (Sink, Arc<Mutex<Vec<Said>>>) {
        let heard = Arc::new(Mutex::new(vec![]));
        let h = heard.clone();
        let sink: Sink = Arc::new(move |s| {
            h.lock().unwrap().push(s);
            true
        });
        (sink, heard)
    }

    #[test]
    fn says_its_lines_then_its_end() {
        let ps = Processes::default();
        let (sink, heard) = collect();
        let (_, ended) = ps.start(&shell("echo one&& echo two 1>&2"), sink).unwrap();
        assert_eq!(
            ended.recv_timeout(Duration::from_secs(20)).unwrap(),
            Some(0)
        );
        let heard = heard.lock().unwrap();
        assert!(heard.contains(&Said::Out { line: "one".into() }));
        assert!(heard
            .iter()
            .any(|s| matches!(s, Said::Err { line } if line.trim() == "two")));
        assert_eq!(heard.last(), Some(&Said::Exit { code: Some(0) }));
    }

    #[test]
    fn tells_a_failure_by_its_code_and_a_missing_program_at_once() {
        let ps = Processes::default();
        let (sink, _) = collect();
        let (_, ended) = ps.start(&shell("exit 3"), sink.clone()).unwrap();
        assert_eq!(
            ended.recv_timeout(Duration::from_secs(20)).unwrap(),
            Some(3)
        );
        assert!(ps
            .start(&program("no-such-program-here", &[]), sink)
            .is_err());
    }

    #[test]
    fn holds_what_it_was_given_until_the_program_ends() {
        let ps = Processes::default();
        let (sink, _) = collect();
        let kept = Arc::new(());
        let (_, ended) = ps
            .start_holding(&shell("echo held"), sink, kept.clone())
            .unwrap();
        ended.recv_timeout(Duration::from_secs(20)).unwrap();
        // the watcher dropped its clone before telling the end
        assert_eq!(Arc::strong_count(&kept), 1);
    }

    #[test]
    fn output_is_what_it_printed() {
        assert_eq!(output(&shell("echo out")).unwrap()[0].trim(), "out");
    }
}
