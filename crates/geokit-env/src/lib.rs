//! The Environment manager and the GPU Lease an app's desktop core shares.
//!
//! - [`envs`]: the Environments the app may start its Python in, a list with
//!   a default, kept in its data folder.
//! - [`programs`]: what is started — a Python in an Environment, the steps
//!   that install the app's own from its [`programs::Recipe`], the questions
//!   put to WSL — each value checked and passed as one argument.
//! - [`process`]: starting those programs and relaying what they say.
//! - [`lease`]: the one GPU Lease, held by at most one GPU Job at a time.
//!
//! Nothing here depends on Tauri: the app wraps these in its own commands.

pub mod envs;
pub mod lease;
pub mod process;
pub mod programs;
