pub mod codemod;
pub mod journal;
pub mod jsx;
pub mod patch;
pub mod policy;
pub mod srcloc;
pub mod style;
pub mod tailwind;
pub mod theme;

pub mod contracts {
    #![allow(clippy::all, clippy::pedantic)]
    include!(concat!(env!("OUT_DIR"), "/contracts.rs"));
}

use contracts::ContentHash;

/// The `VariantSet` schema as provider CLIs receive it: self-contained, no `$schema`.
pub const VARIANT_SET_PROVIDER_SCHEMA: &str =
    include_str!("../../../contracts/generated/variant-set.provider.schema.json");

#[must_use]
pub fn content_hash(content: &[u8]) -> ContentHash {
    let hex = blake3::hash(content).to_hex().to_string();
    ContentHash::try_from(hex).expect("blake3 hex is always 64 lowercase hex digits")
}
