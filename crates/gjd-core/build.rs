use std::{env, fs, path::PathBuf};

fn main() {
    let bundle_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/generated/contracts.bundle.schema.json");
    println!("cargo::rerun-if-changed={}", bundle_path.display());

    let bundle = fs::read_to_string(&bundle_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", bundle_path.display()));

    let draft07 = bundle
        .replace("\"#/$defs/", "\"#/definitions/")
        .replace("\"$defs\":", "\"definitions\":");
    let root: schemars08::schema::RootSchema =
        serde_json::from_str(&draft07).expect("contracts bundle is not a valid root schema");

    let mut space = typify::TypeSpace::new(&typify::TypeSpaceSettings::default());
    space
        .add_root_schema(root)
        .expect("typify rejected the contracts bundle");

    let tokens = space.to_stream();
    let file: syn::File = syn::parse2(tokens).expect("typify produced unparsable tokens");
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    fs::write(out.join("contracts.rs"), prettyplease::unparse(&file))
        .expect("write generated contracts");
}
