use crate::error::{Error, Result};
use calamine::{Reader, Xlsx};
use quick_xml::{events::Event, Reader as XmlReader};
use std::io::{Cursor, Read};

const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

pub fn extract(name: &str, bytes: &[u8]) -> Result<String> {
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
        return Err(Error::Limit);
    }
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let text = match extension.as_str() {
        "txt" | "md" | "markdown" | "csv" | "json" | "tsv" => {
            String::from_utf8(bytes.to_vec()).map_err(|_| Error::Format)?
        }
        "pdf" => pdf_extract::extract_text_from_mem(bytes).map_err(|_| Error::Format)?,
        "docx" => docx(bytes)?,
        "xlsx" => xlsx(bytes)?,
        _ => return Err(Error::Format),
    };
    if text.len() > MAX_TEXT_BYTES {
        return Err(Error::Limit);
    }
    let text = text.replace('\0', "").replace("\r\n", "\n");
    if text.trim().is_empty() {
        return Err(Error::EmptyDocument);
    }
    Ok(text)
}

fn docx(bytes: &[u8]) -> Result<String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| Error::Format)?;
    let file = archive
        .by_name("word/document.xml")
        .map_err(|_| Error::Format)?;
    if file.size() > MAX_TEXT_BYTES as u64 {
        return Err(Error::Limit);
    }
    let mut xml = String::new();
    file.take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_string(&mut xml)?;
    let mut reader = XmlReader::from_str(&xml);
    let mut output = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event().map_err(|_| Error::Format)? {
            Event::Start(tag) if tag.local_name().as_ref() == b"t" => in_text = true,
            Event::Text(text) if in_text => {
                output.push_str(&text.unescape().map_err(|_| Error::Format)?)
            }
            Event::End(tag) => {
                in_text = false;
                if tag.local_name().as_ref() == b"p" {
                    output.push('\n');
                }
            }
            Event::DocType(_) => return Err(Error::Format),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(output)
}

fn xlsx(bytes: &[u8]) -> Result<String> {
    let archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| Error::Format)?;
    let total = archive.decompressed_size().ok_or(Error::Limit)?;
    if total > (MAX_TEXT_BYTES * 4) as u128 {
        return Err(Error::Limit);
    }
    let mut workbook = Xlsx::new(Cursor::new(bytes)).map_err(|_| Error::Format)?;
    let mut output = String::new();
    for (name, range) in workbook.worksheets() {
        output.push_str(&format!("\n{name}\n"));
        for row in range.rows() {
            output.push_str(
                &row.iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\t"),
            );
            output.push('\n');
            if output.len() > MAX_TEXT_BYTES {
                return Err(Error::Limit);
            }
        }
    }
    Ok(output)
}
