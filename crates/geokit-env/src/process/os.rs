// The system's own Spawner. Each program is started in a tree of its own that
// can be ended whole:
//
// - Windows: a Job Object that kills what is in it when it is closed. The
//   program is started suspended, put in the Job, then let go, so nothing it
//   starts can slip out. Ending the Job ends the tree.
// - Elsewhere: a process group of its own, ended with a signal to the group.
// - A program in WSL is a `wsl.exe` on this side and a bash on the Linux
//   side. Ending `wsl.exe` ends the Linux session started under it (checked
//   on a real distribution), but not something that left the session with
//   `setsid`, and not at once. So the script first writes its process group's
//   id to a file, and a program that is killed has that group killed from
//   inside the distribution, once `wsl.exe` has ended, before it is
//   reported ended. (That is done when a program ends by itself too, to
//   remove the file and end anything it left in its group.)

use super::{Exit, How, Running, Spawned, Spawner};
use crate::problem::Problem;
use crate::programs::{Linux, Program};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long a tree is given to be gone once it has been ended.
const GONE: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct OsSpawner {
    count: AtomicU64,
}

fn command(p: &Program, linux_file: Option<&str>) -> Command {
    let mut cmd = match (&p.linux, linux_file) {
        (Some(l), Some(file)) => {
            let mut c = Command::new("wsl.exe");
            c.args(wsl_args(
                &l.distro,
                &format!("echo $$ > '{file}'\n{}", l.script),
            ));
            c
        }
        _ => {
            let mut c = Command::new(&p.program);
            c.args(&p.args);
            c
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &p.env {
        cmd.env(k, v);
    }
    cmd
}

/// What `wsl.exe` is given to run `script` in `distro` (WSL's default if empty).
fn wsl_args(distro: &str, script: &str) -> Vec<String> {
    let mut a = vec![];
    if !distro.is_empty() {
        a.extend(["-d".to_string(), distro.to_string()]);
    }
    a.extend(["--exec", "bash", "-lc"].map(String::from));
    a.push(script.to_string());
    a
}

/// What is left to end inside a distribution once `wsl.exe` has ended.
struct LinuxSide {
    distro: String,
    file: String,
}

impl LinuxSide {
    /// The group of the script killed, and its file removed; waits until the
    /// group is gone.
    fn end(&self) {
        let script = format!(
            "F='{f}'; [ -f \"$F\" ] || exit 0; G=\"$(cat \"$F\")\"; rm -f \"$F\"; \
             case \"$G\" in ''|*[!0-9]*) exit 0;; esac; \
             kill -KILL -- -\"$G\" 2>/dev/null; \
             i=0; while kill -0 -- -\"$G\" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done",
            f = self.file
        );
        let mut c = Command::new("wsl.exe");
        c.args(wsl_args(&self.distro, &script))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        no_window(&mut c);
        match c.status() {
            Ok(s) if s.success() => {}
            other => log::warn!("the Linux side of a program was not confirmed gone: {other:?}"),
        }
    }
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_: &mut Command) {}

impl Spawner for OsSpawner {
    fn spawn(&self, p: &Program) -> Result<Spawned, Problem> {
        let n = self.count.fetch_add(1, Ordering::Relaxed);
        let side = match (&p.linux, cfg!(windows)) {
            (Some(Linux { distro, .. }), true) => Some(LinuxSide {
                distro: distro.clone(),
                file: format!("/tmp/geokit-{}-{n}.pid", std::process::id()),
            }),
            _ => None,
        };
        let mut cmd = command(p, side.as_ref().map(|s| s.file.as_str()));
        let (child, tree) = sys::start(&mut cmd).map_err(|e| {
            Problem::new(
                "process.spawn",
                format!("{} could not be started.", p.program),
            )
            .with("program", p.program.clone())
            .because(e)
        })?;
        let mut child = child;
        let out = child.stdout.take().map(|s| Box::new(s) as _);
        let err = child.stderr.take().map(|s| Box::new(s) as _);
        Ok(Spawned {
            out,
            err,
            running: Arc::new(OsRunning {
                child: Mutex::new(Some(child)),
                tree,
                side,
                killed: AtomicBool::new(false),
            }),
        })
    }
}

struct OsRunning {
    /// Taken by `wait`, so a kill never waits behind it.
    child: Mutex<Option<Child>>,
    tree: sys::Tree,
    side: Option<LinuxSide>,
    killed: AtomicBool,
}

impl Running for OsRunning {
    fn wait(&self) -> Exit {
        let child = crate::locked(&self.child).take();
        let status = match child {
            Some(mut c) => c.wait().map(|s| s.code()).map_err(|e| {
                log::warn!("waiting for a program failed: {e}");
            }),
            None => Err(()),
        };
        // what it left behind is ended with it
        self.tree.end_and_wait(GONE);
        // the Linux side: what is left of the script's group ended, its file removed
        if let Some(side) = &self.side {
            side.end();
        }
        if self.killed.load(Ordering::SeqCst) {
            return Exit {
                code: None,
                how: How::Killed,
            };
        }
        match status {
            Ok(code) => Exit::ended(code),
            Err(()) => Exit {
                code: None,
                how: How::Lost,
            },
        }
    }

    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        self.tree.end();
    }
}

#[cfg(windows)]
mod sys {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;

    /// The Job Object a program and its tree are in. Closed, it kills what is left in it.
    pub struct Tree(HANDLE);

    // a Job handle may be used from any thread
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}

    impl Drop for Tree {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn job() -> std::io::Result<Tree> {
        unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let tree = Tree(h);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            );
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(tree)
        }
    }

    /// Lets go the one thread a suspended new process has.
    fn resume(pid: u32) -> std::io::Result<()> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snap as isize == -1 {
                return Err(std::io::Error::last_os_error());
            }
            let mut e: THREADENTRY32 = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut resumed = false;
            let mut more = Thread32First(snap, &mut e) != 0;
            while more {
                if e.th32OwnerProcessID == pid {
                    let t = OpenThread(THREAD_SUSPEND_RESUME, 0, e.th32ThreadID);
                    if !t.is_null() {
                        resumed |= ResumeThread(t) != u32::MAX;
                        CloseHandle(t);
                    }
                }
                more = Thread32Next(snap, &mut e) != 0;
            }
            CloseHandle(snap);
            if resumed {
                Ok(())
            } else {
                Err(std::io::Error::other(
                    "the new program could not be resumed",
                ))
            }
        }
    }

    pub fn start(cmd: &mut Command) -> std::io::Result<(Child, Tree)> {
        let tree = job()?;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = cmd.spawn()?;
        let put = unsafe { AssignProcessToJobObject(tree.0, child.as_raw_handle() as HANDLE) };
        if put == 0 {
            let e = std::io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
        if let Err(e) = resume(child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
        Ok((child, tree))
    }

    impl Tree {
        fn active(&self) -> Option<u32> {
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                let ok = QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                );
                (ok != 0).then_some(info.ActiveProcesses)
            }
        }

        /// Everything in the Job ended.
        pub fn end(&self) {
            unsafe { TerminateJobObject(self.0, 1) };
        }

        /// What is left in the Job ended, and waited for until it is gone.
        pub fn end_and_wait(&self, within: Duration) {
            if self.active() != Some(0) {
                self.end();
            }
            let until = Instant::now() + within;
            while self.active().is_some_and(|n| n > 0) {
                if Instant::now() > until {
                    log::warn!("a program's tree was still there after being ended");
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[cfg(unix)]
mod sys {
    use super::*;
    use std::os::unix::process::CommandExt;

    /// The process group a program and its tree are in.
    pub struct Tree(i32);

    pub fn start(cmd: &mut Command) -> std::io::Result<(Child, Tree)> {
        cmd.process_group(0);
        let child = cmd.spawn()?;
        let pgid = child.id() as i32;
        Ok((child, Tree(pgid)))
    }

    impl Tree {
        fn alive(&self) -> bool {
            // SAFETY: signal 0 only asks whether the group exists
            unsafe { libc::killpg(self.0, 0) == 0 }
        }

        pub fn end(&self) {
            // SAFETY: a signal to the group this program was started as the leader of
            unsafe { libc::killpg(self.0, libc::SIGKILL) };
        }

        pub fn end_and_wait(&self, within: Duration) {
            if self.alive() {
                self.end();
            }
            let until = Instant::now() + within;
            while self.alive() {
                if Instant::now() > until {
                    log::warn!("a program's tree was still there after being ended");
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
