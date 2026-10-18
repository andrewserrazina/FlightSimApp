//! GSX receipt parsing, read-only discovery (S2-05) and the automatic receipt watcher (S2-06). The ledger (store/ledger.rs) imports through
//! `scan` and `fuel`; nothing here writes to GSX's files.
#![cfg_attr(not(test), allow(dead_code))]

pub mod fuel;
pub mod gsx_fuel;
pub mod import;
pub mod money;
pub mod review;
pub mod scan;
pub mod watch;
pub mod watch_fs;
pub mod watch_service;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod watch_tests;
