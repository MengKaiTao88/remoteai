use super::*;
use std::path::PathBuf;

const PREVIOUS_IMAGE_LIMIT: u64 = 20 * 1024 * 1024;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("draft-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn preview(&self, name: &str, variant: ImageVariant) -> Result<AttachmentPreviewResponse> {
        preview(AttachmentPreviewRequest {
            path: self.0.join(name).to_string_lossy().into_owned(),
            variant,
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn previews_external_draft_images_with_spaces_and_unicode_without_a_thread() {
    let fixture = Fixture::new();
    let name = "QQ 截图.PNG";
    image::RgbImage::new(2048, 457)
        .save(fixture.0.join(name))
        .unwrap();
    let thumbnail = fixture.preview(name, ImageVariant::Thumbnail).unwrap().url;
    assert!(thumbnail.starts_with("data:image/jpeg;base64,"));
    assert!(thumbnail.len() < 100_000);
    let original = fixture.preview(name, ImageVariant::Original).unwrap().url;
    let bytes = super::super::images::decode_data_url(&original, u64::MAX).unwrap();
    assert_eq!(bytes, std::fs::read(fixture.0.join(name)).unwrap());
}

#[test]
fn rejects_non_images_missing_empty_and_non_local_files() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("fake.png"), "not an image").unwrap();
    std::fs::write(fixture.0.join("empty.png"), "").unwrap();
    image::RgbImage::new(1, 1)
        .save(fixture.0.join("valid.png"))
        .unwrap();
    std::fs::copy(fixture.0.join("valid.png"), fixture.0.join("data.txt")).unwrap();
    std::fs::File::create(fixture.0.join("large.png"))
        .unwrap()
        .set_len(PREVIOUS_IMAGE_LIMIT + 1)
        .unwrap();
    for name in [
        "fake.png",
        "empty.png",
        "missing.png",
        "large.png",
        "data.txt",
    ] {
        assert!(fixture.preview(name, ImageVariant::Thumbnail).is_err());
    }
    for path in [
        "relative.png",
        "//server/share/image.png",
        "https://example.com/image.png",
    ] {
        assert!(preview(AttachmentPreviewRequest {
            path: path.into(),
            variant: ImageVariant::Thumbnail,
        })
        .is_err());
    }
}

#[test]
fn previews_jpeg_above_twenty_megabytes_and_returns_original_only_when_requested() {
    let fixture = Fixture::new();
    let path = fixture.0.join("large.jpg");
    image::RgbImage::new(2048, 1536).save(&path).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(PREVIOUS_IMAGE_LIMIT + 1)
        .unwrap();
    let thumbnail = fixture
        .preview("large.jpg", ImageVariant::Thumbnail)
        .unwrap()
        .url;
    assert!(thumbnail.starts_with("data:image/jpeg;base64,"));
    assert!(thumbnail.len() < 100_000);
    let original = fixture
        .preview("large.jpg", ImageVariant::Original)
        .unwrap()
        .url;
    let bytes = super::super::images::decode_data_url(&original, u64::MAX).unwrap();
    assert_eq!(bytes, std::fs::read(&path).unwrap());
    assert!(super::super::images::input(path.to_string_lossy().into_owned()).is_ok());
}

#[test]
fn reports_resource_limit_for_small_files_with_excessive_dimensions() {
    let fixture = Fixture::new();
    image::RgbImage::new(16_385, 1)
        .save(fixture.0.join("wide.png"))
        .unwrap();
    assert!(matches!(
        fixture.preview("wide.png", ImageVariant::Thumbnail),
        Err(GuiError::ImagePreviewResources)
    ));
}

/// Optional end-to-end decoder check without committing a user's private image to the repository.
#[test]
#[ignore = "set CODEX_IMAGE_PREVIEW_FIXTURE to a local image larger than 20 MiB"]
fn previews_large_local_image_fixture() {
    let path = std::env::var("CODEX_IMAGE_PREVIEW_FIXTURE").unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() > PREVIOUS_IMAGE_LIMIT);
    let thumbnail = preview(AttachmentPreviewRequest {
        path: path.clone(),
        variant: ImageVariant::Thumbnail,
    })
    .unwrap()
    .url;
    assert!(thumbnail.len() < 100_000);
    let original = preview(AttachmentPreviewRequest {
        path: path.clone(),
        variant: ImageVariant::Original,
    })
    .unwrap()
    .url;
    let bytes = super::super::images::decode_data_url(&original, u64::MAX).unwrap();
    assert_eq!(bytes, std::fs::read(path).unwrap());
    if let Ok(output) = std::env::var("CODEX_IMAGE_PREVIEW_OUTPUT") {
        std::fs::write(
            output,
            serde_json::json!({ "thumbnail": thumbnail, "original": original }).to_string(),
        )
        .unwrap();
    }
}
