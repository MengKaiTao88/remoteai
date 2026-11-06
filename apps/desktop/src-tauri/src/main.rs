// Installed local builds also use the dev profile; neither the app nor its STDIO helpers need a console.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    codex_switch_lib::run();
}
