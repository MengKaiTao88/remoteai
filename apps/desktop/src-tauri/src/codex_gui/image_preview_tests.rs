use super::*;

#[test]
fn rejects_images_above_the_configured_limit_before_rendering() {
    let source = "data:image/png;base64,YWI=".to_string();
    let options = |limit| PreviewOptions {
        variant: super::super::image_thumbnail::ImageVariant::Original,
        max_bytes: Some(limit),
    };
    assert!(render_limited(source.clone(), options(1)).is_err());
    assert_eq!(render_limited(source.clone(), options(2)).unwrap(), source);
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("gui-preview-{}", uuid::Uuid::new_v4()));
        for dir in ["workspace", "generated", "outside"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        Self(root)
    }

    fn write_image(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, include_bytes!("../../icons/32x32.png")).unwrap();
        path
    }

    fn read(&self, source: &str) -> Result<String> {
        self.read_with_references(source, &[])
    }

    fn read_with_references(&self, source: &str, references: &[String]) -> Result<String> {
        read_image(
            source,
            &self.0.join("workspace"),
            ReadOptions {
                generated: &self.0.join("generated"),
                references,
                preview: PreviewOptions {
                    variant: ImageVariant::Original,
                    max_bytes: Some(DEFAULT_IMAGE_BYTES),
                },
            },
        )
    }
}

#[test]
fn previews_only_the_external_image_recorded_in_the_current_thread() {
    let fixture = Fixture::new();
    let screenshot = fixture.write_image("outside/页面 截图.png");
    let sibling = fixture.write_image("outside/unrelated.png");
    let file_url = url::Url::from_file_path(&screenshot).unwrap();
    let thread = json!({"turns": [{"items": [
        {"type": "imageView", "path": file_url.as_str()}
    ]}]});
    let references = image_references(&thread);
    for source in [screenshot.to_str().unwrap(), file_url.as_str()] {
        assert!(fixture.read(source).is_err());
        assert!(fixture
            .read_with_references(source, &references)
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
    assert!(fixture
        .read_with_references(sibling.to_str().unwrap(), &references)
        .is_err());
}

#[test]
fn collects_structured_image_references_without_trusting_message_text_or_tool_arguments() {
    let thread = json!({"turns": [{"items": [
        {"type": "userMessage", "content": [
            {"type": "localImage", "path": "attached.png"},
            {"type": "text", "text": "secret.png", "path": "secret.png"}
        ]},
        {"type": "imageGeneration", "savedPath": "generated.png"},
        {"type": "agentMessage", "text": "![image](secret.png)", "path": "secret.png"},
        {"type": "mcpToolCall", "arguments": {"path": "secret.png"}}
    ]}]});
    assert_eq!(image_references(&thread), ["attached.png", "generated.png"]);
    assert!(image_references(&json!({})).is_empty());
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn previews_workspace_and_generated_images_in_supported_path_forms() {
    let fixture = Fixture::new();
    let image = fixture.write_image("workspace/页面 截图.png");
    let expected = format!(
        "data:image/png;base64,{}",
        STANDARD.encode(include_bytes!("../../icons/32x32.png"))
    );
    assert_eq!(fixture.read("页面 截图.png").unwrap(), expected);
    assert_eq!(fixture.read(image.to_str().unwrap()).unwrap(), expected);
    assert_eq!(
        fixture
            .read(url::Url::from_file_path(&image).unwrap().as_str())
            .unwrap(),
        expected
    );
    let generated = fixture.write_image("generated/bird.png");
    assert_eq!(fixture.read(generated.to_str().unwrap()).unwrap(), expected);
}

#[test]
fn rejects_traversal_other_tasks_network_and_device_paths() {
    let fixture = Fixture::new();
    let outside = fixture.write_image("outside/secret.png");
    for source in [
        outside.to_str().unwrap(),
        "../outside/secret.png",
        "missing.png",
        "file://server/share/image.png",
        r"\\server\share\image.png",
        r"\\?\C:\image.png",
        "https://example.com/image.png",
        "/__codex_switch__/api/invoke",
        "image.png\0",
    ] {
        assert!(
            fixture.read(source).is_err(),
            "unexpectedly accepted {source}"
        );
    }
}

#[test]
fn rejects_non_images_empty_files_directories_and_oversized_files() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("workspace/fake.png"), b"not an image").unwrap();
    std::fs::write(fixture.0.join("workspace/vector.svg"), b"<svg/>").unwrap();
    File::create(fixture.0.join("workspace/empty.png")).unwrap();
    std::fs::create_dir(fixture.0.join("workspace/directory.png")).unwrap();
    File::create(fixture.0.join("workspace/large.png"))
        .unwrap()
        .set_len(DEFAULT_IMAGE_BYTES + 1)
        .unwrap();
    for source in [
        "fake.png",
        "vector.svg",
        "empty.png",
        "directory.png",
        "large.png",
    ] {
        assert!(
            fixture.read(source).is_err(),
            "unexpectedly accepted {source}"
        );
    }
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_outside_the_allowed_directories() {
    let fixture = Fixture::new();
    let outside = fixture.write_image("outside/secret.png");
    std::os::unix::fs::symlink(outside, fixture.0.join("workspace/link.png")).unwrap();
    assert!(fixture.read("link.png").is_err());
}

#[test]
fn configured_image_limit_can_exceed_the_previous_twenty_megabyte_cap() {
    let fixture = Fixture::new();
    let path = fixture.write_image("workspace/large.png");
    let size = DEFAULT_IMAGE_BYTES + 1;
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(size)
        .unwrap();
    assert!(encode_image(&path, DEFAULT_IMAGE_BYTES).is_err());
    let original = encode_image(&path, size).unwrap();
    super::super::images::input_limited(original.clone(), size).unwrap();
    let options = PreviewOptions {
        variant: super::super::image_thumbnail::ImageVariant::Original,
        max_bytes: Some(size),
    };
    assert_eq!(render_limited(original.clone(), options).unwrap(), original);
}

#[test]
fn local_history_thumbnails_ignore_upload_limits_but_respect_explicit_preview_policy() {
    let fixture = Fixture::new();
    let path = fixture.write_image("workspace/large.png");
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(DEFAULT_IMAGE_BYTES + 1)
        .unwrap();
    let read = |variant, max_bytes| {
        read_image(
            "large.png",
            &fixture.0.join("workspace"),
            ReadOptions {
                generated: &fixture.0.join("generated"),
                references: &[],
                preview: PreviewOptions { variant, max_bytes },
            },
        )
    };
    let thumbnail = read(ImageVariant::Thumbnail, None).unwrap();
    assert!(thumbnail.len() < 100_000);
    assert!(read(ImageVariant::Original, None).is_ok());
    for variant in [ImageVariant::Thumbnail, ImageVariant::Original] {
        assert!(read(variant, Some(DEFAULT_IMAGE_BYTES)).is_err());
    }
}

#[test]
fn previews_tool_screenshots_outside_workspace_without_granting_sibling_access() {
    let fixture = Fixture::new();
    let screenshot = fixture.write_image("outside/tool screenshot.png");
    let sibling = fixture.write_image("outside/unrelated.png");
    let result = json!({"structuredContent": {"screenshot_path": screenshot}});
    for item in [
        json!({"type": "mcpToolCall", "result": result}),
        json!({"type": "dynamicToolCall", "success": true, "contentItems": [
            {"type": "inputText", "text": result.to_string()}
        ]}),
        json!({"type": "functionCallOutput", "output": result.to_string()}),
        json!({"type": "mcpToolCall", "result": {"content": [
            {"type": "resource_link", "uri": url::Url::from_file_path(&screenshot).unwrap()}
        ]}}),
    ] {
        let thread = json!({"turns": [{"items": [item]}]});
        let references = image_references(&thread);
        assert!(fixture
            .read_with_references(screenshot.to_str().unwrap(), &references)
            .is_ok());
        assert!(fixture
            .read_with_references(sibling.to_str().unwrap(), &references)
            .is_err());
    }
}

#[test]
fn failed_tools_and_unstructured_text_do_not_authorize_image_reads() {
    let thread = json!({"turns": [{"items": [
        {"type": "mcpToolCall", "arguments": {"path": "input.png"}},
        {"type": "mcpToolCall", "result": {"isError": true, "path": "failed.png"}},
        {"type": "dynamicToolCall", "success": false, "contentItems": [{"path": "failed.png"}]},
        {"type": "mcpToolCall", "result": {"content": [
            {"type": "text", "text": "Screenshot: unstructured.png"}
        ]}},
        {"type": "mcpToolCall", "result": {"path": "//server/share/image.png"}},
        {"type": "mcpToolCall", "result": {"path": "config.toml"}}
    ]}]});
    assert!(image_references(&thread).is_empty());
}

#[cfg(windows)]
#[test]
fn previews_canonical_windows_paths_returned_by_computer_use() {
    let fixture = Fixture::new();
    let screenshot = fixture.write_image("outside/computer-use.png");
    let canonical = screenshot.canonicalize().unwrap();
    let result = json!({"structuredContent": {"screenshot_file_path": canonical}});
    let thread = json!({"turns": [{"items": [{
        "type": "dynamicToolCall", "success": true,
        "contentItems": [{"type": "inputText", "text": result.to_string()}]
    }]}]});
    let references = image_references(&thread);
    assert!(fixture.read(screenshot.to_str().unwrap()).is_err());
    assert!(fixture
        .read_with_references(screenshot.to_str().unwrap(), &references)
        .is_ok());
    let forbidden = json!({"turns": [{"items": [{"type": "mcpToolCall", "result": {
        "screenshot_file_path": r"\\?\UNC\server\share\image.png"
    }}]}]});
    assert!(image_references(&forbidden).is_empty());
}
