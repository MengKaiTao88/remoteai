use super::IMAGE_PROMPT;
use crate::{
    error::{Error, Result},
    jobs::JobControl,
    proxy::{ModelProxy, VisionImage, VisionRequest},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hayro::{
    hayro_interpret::InterpreterSettings,
    hayro_syntax::{object::Object, Pdf},
    vello_cpu::color::palette::css::WHITE,
    RenderCache, RenderSettings,
};

const MAX_PAGES: usize = 50;
const MAX_PAGE_EDGE: f32 = 1800.0;
const MAX_IMAGE_PIXELS: i64 = 40_000_000;

pub(super) fn recognize(
    proxy: &ModelProxy,
    model: &str,
    bytes: &[u8],
    control: &JobControl,
) -> Result<String> {
    control.check()?;
    let pdf = load(bytes)?;
    let mut text = String::new();
    for (index, page) in pdf.pages().iter().enumerate() {
        control.emit(serde_json::json!({"type":"progress","stage":"recognize", "completed":index,"total":pdf.pages().len()}))?;
        // A page-local cache releases decoded image buffers before rendering the next page.
        let image = render(page)?;
        let content = proxy.vision_controlled(
            VisionRequest {
                model,
                images: &[image],
                prompt: IMAGE_PROMPT,
            },
            &control.without_events(),
        )?;
        text.push_str(&format!("\n## 第 {} 页\n{}\n", index + 1, content));
        if text.len() > 2 * 1024 * 1024 {
            return Err(Error::Limit);
        }
    }
    Ok(text)
}

fn load(bytes: &[u8]) -> Result<Pdf> {
    let pdf = Pdf::new(bytes.to_vec()).map_err(|_| Error::Format)?;
    if pdf.pages().is_empty() || pdf.pages().len() > MAX_PAGES || pdf.len() > 100_000 {
        return Err(Error::Limit);
    }
    for object in pdf.objects() {
        let Object::Stream(stream) = object else {
            continue;
        };
        let width = stream.dict().get::<i64>(b"Width").unwrap_or(0);
        let height = stream.dict().get::<i64>(b"Height").unwrap_or(0);
        if width < 0 || height < 0 || width.saturating_mul(height) > MAX_IMAGE_PIXELS {
            return Err(Error::Limit);
        }
    }
    Ok(pdf)
}

fn render(page: &hayro::hayro_syntax::page::Page<'_>) -> Result<VisionImage> {
    let (width, height) = page.render_dimensions();
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(Error::Format);
    }
    let scale = (MAX_PAGE_EDGE / width.max(height)).min(2.0);
    let settings = RenderSettings {
        x_scale: scale,
        y_scale: scale,
        bg_color: WHITE,
        ..Default::default()
    };
    let pixels = hayro::render(
        page,
        &RenderCache::new(),
        &InterpreterSettings::default(),
        &settings,
    );
    let mut bytes = Vec::new();
    {
        let mut encoder =
            png::Encoder::new(&mut bytes, pixels.width().into(), pixels.height().into());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|_| Error::Format)?;
        writer
            .write_image_data(pixels.data_as_u8_slice())
            .map_err(|_| Error::Format)?;
    }
    Ok(VisionImage {
        mime_type: "image/png".into(),
        content_base64: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanned_pdf_page_renders_without_external_binaries() {
        // A page made of an image XObject, with no selectable text.
        let source = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n\
            2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n\
            3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]\
            /Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>endobj\n\
            4 0 obj<</Length 30>>stream\nq 200 0 0 100 0 0 cm /Im0 Do Q\nendstream\nendobj\n\
            5 0 obj<</Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceRGB\
            /BitsPerComponent 8/Length 3>>stream\n\xff\x00\x00\nendstream\nendobj\n\
            trailer<</Root 1 0 R>>\n%%EOF";
        let pdf = load(source).unwrap();
        let image = render(&pdf.pages()[0]).unwrap();
        let png = STANDARD.decode(image.content_base64).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(png))
            .read_info()
            .unwrap();
        assert_eq!(reader.info().width, 400);
        assert_eq!(reader.info().height, 200);
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut pixels).unwrap();
        assert!(pixels
            .chunks_exact(4)
            .any(|pixel| pixel[0] > 240 && pixel[1] < 10 && pixel[2] < 10));
    }
}
