#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

pub mod storage;
pub mod types;
pub mod errors;
pub mod events;
pub mod helpers;
pub mod contract;

#[cfg(test)]
mod test;

pub use contract::*;
