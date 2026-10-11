use super::*;
use std::io::Write;

fn archive(entries: &[(&str, &[u8])]) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("test.zip");
    let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    for (name, bytes) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
    (directory, archive)
}

#[test]
fn archive_paths_cannot_escape_or_alias_windows_streams() {
    for name in ["../escape", "/absolute", "C:/absolute", "ui/file:stream"] {
        let (directory, archive) = archive(&[(name, b"data")]);
        assert!(
            extract(&archive, &directory.path().join("output")).is_err(),
            "{name}"
        );
    }
}

#[test]
fn nested_assets_extract_and_case_collisions_fail() {
    let (directory, archive_path) = archive(&[("ui/assets/app.js", b"ok")]);
    let output = directory.path().join("output");
    extract(&archive_path, &output).unwrap();
    assert_eq!(fs::read(output.join("ui/assets/app.js")).unwrap(), b"ok");
    let (directory, archive_path) = archive(&[("ui/app.js", b"one"), ("ui/APP.js", b"two")]);
    assert!(extract(&archive_path, &directory.path().join("output")).is_err());
}

#[test]
fn unsigned_packages_are_never_accepted() {
    assert!(verify(b"forged executable", "invalid-signature").is_err());
    assert!(registry().unwrap().release_tag.starts_with("coze-v"));
}

#[test]
fn incomplete_packages_are_not_marked_installed() {
    let root = tempfile::tempdir().unwrap();
    let package = directory(root.path()).unwrap();
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join(platform::executable()), b"partial").unwrap();
    fs::write(package.join("complete.json"), b"{}").unwrap();
    assert!(!installed(root.path()).unwrap());
}

#[test]
fn replacement_rolls_back_on_failure_and_preserves_user_data() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("packages/current");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("old"), b"old").unwrap();
    fs::write(root.path().join("user-data"), b"keep").unwrap();
    let staging = tempfile::tempdir_in(root.path()).unwrap();
    assert!(replace_package(
        &staging.path().join("missing"),
        &destination,
        staging.path()
    )
    .is_err());
    assert_eq!(fs::read(destination.join("old")).unwrap(), b"old");
    let next = staging.path().join("next");
    fs::create_dir(&next).unwrap();
    fs::write(next.join("new"), b"new").unwrap();
    replace_package(&next, &destination, staging.path()).unwrap();
    assert_eq!(fs::read(destination.join("new")).unwrap(), b"new");
    assert_eq!(fs::read(root.path().join("user-data")).unwrap(), b"keep");
}
