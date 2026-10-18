//! GSX receipt parsing and read-only discovery (S2-05). The ledger (store/ledger.rs) imports through
//! `scan` and `fuel`; nothing here writes to GSX's files.
#![cfg_attr(not(test), allow(dead_code))]

pub mod fuel;
pub mod gsx_fuel;
pub mod import;
pub mod money;
pub mod review;
pub mod scan;

#[cfg(test)]
mod tests;
