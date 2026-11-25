//! The Environment manager and the GPU Lease an app's desktop core shares.
//!
//! - [`envs`]: the Environments the app may start its Python in, a list with
//!   a default, kept in its data folder. A list that cannot be read is kept
//!   aside and reported, never overwritten.
//! - [`programs`]: what is started — a Python in an Environment, the
//!   questions put to WSL — each value checked and passed as one argument.
//!   The app's own [`programs::Recipe`] is described here.
//! - [`install`]: making the app's own Environment from its Recipe (one
//!   call that plans, runs, tells, cancels and records), checking it
//!   ([`install::verify`]), repairing it and taking it away.
//! - [`detect`]: what the computer offers as an Environment: WSL's
//!   distributions, conda's environments, the Pythons on the PATH.
//! - [`process`]: starting programs and relaying what they say. A program is
//!   a whole tree, ended whole; what starts it is a [`process::Spawner`],
//!   the system's own or [`process::scripted::Scripted`] for tests.
//! - [`lease`]: the one GPU Lease, held by at most one GPU Job at a time,
//!   and given back only once the Job's program, tree and all, has ended.
//! - [`problem`]: the one error, a code the page words and the English.
//!
//! Nothing here depends on Tauri: the app wraps these in its own commands.
//! What happens is told through the `log` facade (`log::info!` at start and
//! end of each program, `debug` for the Lease); the app picks the logger.

pub mod detect;
pub mod envs;
pub mod install;
pub mod lease;
pub mod problem;
pub mod process;
pub mod programs;

pub use problem::Problem;

use std::sync::{Mutex, MutexGuard};

/// `m` locked, even after a holder panicked with it locked: what is kept
/// behind it is changed only in whole steps, so it is still sound.
pub(crate) fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
