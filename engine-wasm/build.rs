fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let target = std::env::var("TARGET").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    if target_arch == "x86_64" && !target.contains("wasm") {
        #[cfg(target_arch = "x86_64")]
        {
            if is_x86_feature_detected!("avx2") {
                println!("cargo:rustc-cfg=native_avx2");
            }
            if is_x86_feature_detected!("bmi2") {
                println!("cargo:rustc-cfg=native_bmi2");
            }
        }
    } else if target_arch == "wasm32" {
        println!("cargo:rustc-cfg=wasm_target");
    }
}
