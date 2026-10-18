//! GSX receipt parsing (S2-05). Read-only and not yet wired to a command or the database: the
//! ledger slice that calls it needs separate owner approval.
#![cfg_attr(not(test), allow(dead_code))]

pub mod fuel;
pub mod gsx_fuel;
pub mod import;
pub mod money;

#[cfg(test)]
mod tests;
