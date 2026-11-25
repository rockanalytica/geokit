// The GPU Lease: the single right to use the GPU, held by at most one GPU
// Job at a time. The app's core holds the one Lease, because it is the only
// thing that starts Jobs on both sides of the Windows/WSL boundary; a lock
// inside Python could see neither a native program nor the other side.
//
// A second GPU Job waits for the Lease, first come first served, and is told
// its place in the queue so the page can show it as waiting for the GPU. A
// Job that would rather run on the CPU than queue asks with `try_hold`.
// What the Lease knows it knows from its own holders: in WSL `nvidia-smi`
// cannot list the processes using the GPU, so nothing here asks the GPU.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

#[derive(Default)]
struct Queue {
    next: u64,
    holder: Option<(u64, String)>,
    waiting: VecDeque<(u64, String)>,
}

#[derive(Default)]
struct Inner {
    queue: Mutex<Queue>,
    changed: Condvar,
}

impl Inner {
    /// The queue, even after a holder panicked with it locked: its state is
    /// changed only in whole steps, so it is still sound.
    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Who holds the GPU and who waits for it, in order: what the page shows.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LeaseState {
    pub holder: Option<String>,
    pub waiting: Vec<String>,
}

/// The one GPU Lease. Cloned, it is the same Lease.
#[derive(Clone, Default)]
pub struct GpuLease {
    inner: Arc<Inner>,
}

/// The Lease, held: given back when dropped, and the next in the queue woken.
pub struct Held {
    inner: Arc<Inner>,
    id: u64,
    job: String,
}

impl Held {
    /// The Job holding it, as it was named when it asked.
    pub fn job(&self) -> &str {
        &self.job
    }
}

impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Held").field("job", &self.job).finish()
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut q = self.inner.queue();
        if q.holder.as_ref().is_some_and(|(id, _)| *id == self.id) {
            q.holder = None;
            log::debug!("GPU Lease given back by {:?}", self.job);
        }
        drop(q);
        self.inner.changed.notify_all();
    }
}

/// How often a waiting Job looks whether it has been cancelled.
const LOOK: Duration = Duration::from_millis(50);

impl GpuLease {
    pub fn new() -> Self {
        Self::default()
    }

    /// The Lease for `job` now if it is free and no one waits for it; None
    /// otherwise, for a Job that runs on the CPU rather than queue.
    pub fn try_hold(&self, job: &str) -> Option<Held> {
        let mut q = self.inner.queue();
        if q.holder.is_some() || !q.waiting.is_empty() {
            return None;
        }
        q.next += 1;
        let id = q.next;
        q.holder = Some((id, job.to_string()));
        log::debug!("GPU Lease held by {job:?}");
        Some(Held {
            inner: self.inner.clone(),
            id,
            job: job.to_string(),
        })
    }

    /// The Lease for `job`, once every Job that asked before it has had it
    /// and given it back. `waiting` is told the Job's place in the queue (1
    /// is next) whenever it changes, and not at all when the Lease is free.
    /// None when `cancelled` says so before the Lease comes.
    pub fn hold(
        &self,
        job: &str,
        cancelled: impl Fn() -> bool,
        mut waiting: impl FnMut(usize),
    ) -> Option<Held> {
        let mut q = self.inner.queue();
        q.next += 1;
        let id = q.next;
        q.waiting.push_back((id, job.to_string()));
        log::debug!("{job:?} waits for the GPU Lease");
        let mut told = 0;
        loop {
            let place = q.waiting.iter().position(|(i, _)| *i == id).map(|p| p + 1);
            if q.holder.is_none() && place == Some(1) {
                q.waiting.pop_front();
                q.holder = Some((id, job.to_string()));
                log::debug!("GPU Lease held by {job:?}");
                drop(q);
                // the next in the queue moves up a place
                self.inner.changed.notify_all();
                return Some(Held {
                    inner: self.inner.clone(),
                    id,
                    job: job.to_string(),
                });
            }
            let place = place.unwrap_or(1);
            if place != told {
                told = place;
                drop(q);
                waiting(place);
                q = self.inner.queue();
                continue;
            }
            if cancelled() {
                q.waiting.retain(|(i, _)| *i != id);
                log::debug!("{job:?} gave up waiting for the GPU Lease");
                drop(q);
                self.inner.changed.notify_all();
                return None;
            }
            q = self
                .inner
                .changed
                .wait_timeout(q, LOOK)
                .map(|(g, _)| g)
                .unwrap_or_else(|e| e.into_inner().0);
        }
    }

    /// Who holds the Lease and who waits for it, in order.
    pub fn state(&self) -> LeaseState {
        let q = self.inner.queue();
        LeaseState {
            holder: q.holder.as_ref().map(|(_, j)| j.clone()),
            waiting: q.waiting.iter().map(|(_, j)| j.clone()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::scripted::{Script, Scripted};
    use crate::process::tests::collect;
    use crate::process::Processes;
    use crate::programs::program;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;

    const LONG: Duration = Duration::from_secs(20);

    fn never() -> bool {
        false
    }

    /// Wait until the Lease's state is `want`, or fail.
    fn until(lease: &GpuLease, want: LeaseState) {
        let end = Instant::now() + LONG;
        while lease.state() != want {
            assert!(
                Instant::now() < end,
                "still {:?}, wanted {want:?}",
                lease.state()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn state(holder: Option<&str>, waiting: &[&str]) -> LeaseState {
        LeaseState {
            holder: holder.map(str::to_string),
            waiting: waiting.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn a_free_lease_is_held_at_once_and_given_back_when_dropped() {
        let lease = GpuLease::new();
        assert_eq!(lease.state(), LeaseState::default());
        let mut told = vec![];
        let held = lease
            .hold("extract features", never, |p| told.push(p))
            .unwrap();
        assert!(told.is_empty(), "nobody waits for a free Lease");
        assert_eq!(held.job(), "extract features");
        assert_eq!(lease.state(), state(Some("extract features"), &[]));
        drop(held);
        assert_eq!(lease.state(), LeaseState::default());
    }

    #[test]
    fn try_hold_never_waits_and_never_jumps_the_queue() {
        let lease = GpuLease::new();
        let a = lease.try_hold("train").unwrap();
        // held: a single prediction runs on the CPU instead
        assert!(lease.try_hold("predict one").is_none());
        let l = lease.clone();
        let waiter =
            thread::spawn(move || l.hold("stereo", never, |_| {}).map(|h| h.job().to_string()));
        until(&lease, state(Some("train"), &["stereo"]));
        drop(a);
        assert_eq!(waiter.join().unwrap().as_deref(), Some("stereo"));
        // free again, and no one waiting
        assert!(lease.try_hold("predict one").is_some());
    }

    #[test]
    fn waiting_jobs_get_it_in_the_order_they_asked_told_their_place() {
        let lease = GpuLease::new();
        let first = lease.hold("match", never, |_| {}).unwrap();
        let (order_tx, order) = mpsc::channel();
        let (place_tx, places) = mpsc::channel();
        let mut handles = vec![];
        for job in ["stereo", "train", "predict"] {
            let l = lease.clone();
            let order_tx = order_tx.clone();
            let place_tx = place_tx.clone();
            let mut want = state(Some("match"), &[]);
            want.waiting = lease.state().waiting;
            want.waiting.push(job.to_string());
            handles.push(thread::spawn(move || {
                let held = l
                    .hold(job, never, |p| place_tx.send((job, p)).unwrap())
                    .unwrap();
                order_tx.send(job).unwrap();
                // hold it a moment, so the next really waits for this one
                thread::sleep(Duration::from_millis(20));
                drop(held);
            }));
            until(&lease, want);
        }
        drop(first);
        for h in handles {
            h.join().unwrap();
        }
        let got: Vec<_> = order.try_iter().collect();
        assert_eq!(got, ["stereo", "train", "predict"]);
        let told: Vec<_> = places.try_iter().collect();
        // each told where it joined, and the last told as it moved up
        assert!(told.contains(&("stereo", 1)));
        assert!(told.contains(&("train", 2)));
        assert!(told.contains(&("predict", 3)));
        assert!(told.contains(&("predict", 2)) && told.contains(&("predict", 1)));
        assert_eq!(lease.state(), LeaseState::default());
    }

    #[test]
    fn a_job_cancelled_while_waiting_leaves_the_queue() {
        let lease = GpuLease::new();
        let held = lease.hold("train", never, |_| {}).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let (l, s) = (lease.clone(), stop.clone());
        let waiter = thread::spawn(move || {
            l.hold("stereo", || s.load(Ordering::Relaxed), |_| {})
                .is_none()
        });
        until(&lease, state(Some("train"), &["stereo"]));
        stop.store(true, Ordering::Relaxed);
        assert!(waiter.join().unwrap(), "cancelled, it gets nothing");
        assert_eq!(lease.state(), state(Some("train"), &[]));
        drop(held);
        assert!(lease.try_hold("next").is_some());
    }

    #[test]
    fn a_gpu_job_keeps_the_lease_until_its_program_ends() {
        let lease = GpuLease::new();
        // a program that takes a moment
        let ps = Processes::new(Arc::new(Scripted::always(
            Script::ok().runs_for(Duration::from_millis(200)),
        )));
        let (sink, _) = collect();
        let held = lease.hold("extract features", never, |_| {}).unwrap();
        let (_, ended) = ps.start_holding(&program("x", &[]), sink, held).unwrap();
        assert_eq!(lease.state().holder.as_deref(), Some("extract features"));
        assert!(lease.try_hold("predict one").is_none());
        ended.recv_timeout(LONG).unwrap();
        until(&lease, LeaseState::default());
        assert!(lease.try_hold("predict one").is_some());
    }

    #[test]
    fn a_killed_gpu_job_gives_the_lease_back_only_once_its_tree_is_gone() {
        let lease = GpuLease::new();
        let sp = Arc::new(Scripted::always(
            Script::ok()
                .until_killed()
                .takes_to_die(Duration::from_millis(400)),
        ));
        let ps = Processes::new(sp);
        let (sink, _) = collect();
        let held = lease.hold("train", never, |_| {}).unwrap();
        let (id, ended) = ps.start_holding(&program("x", &[]), sink, held).unwrap();
        ps.kill(id);
        // its main program is gone as far as the page asked, but the tree is not
        thread::sleep(Duration::from_millis(150));
        assert_eq!(lease.state().holder.as_deref(), Some("train"));
        assert!(lease.try_hold("predict one").is_none());
        ended.recv_timeout(LONG).unwrap();
        until(&lease, LeaseState::default());
    }

    #[test]
    fn a_holder_that_panics_gives_the_lease_back() {
        let lease = GpuLease::new();
        let l = lease.clone();
        let r = thread::spawn(move || {
            let _held = l.hold("train", never, |_| {}).unwrap();
            panic!("the Job failed");
        })
        .join();
        assert!(r.is_err());
        assert_eq!(lease.state(), LeaseState::default());
        assert!(lease.try_hold("next").is_some());
    }

    #[test]
    fn its_state_is_what_the_page_reads() {
        let lease = GpuLease::new();
        let _h = lease.try_hold("train").unwrap();
        assert_eq!(
            serde_json::to_string(&lease.state()).unwrap(),
            r#"{"holder":"train","waiting":[]}"#
        );
    }
}
