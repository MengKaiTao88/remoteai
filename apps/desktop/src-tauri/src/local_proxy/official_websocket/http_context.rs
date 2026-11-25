//! Observe official HTTP output while forwarding the original response bytes.
use super::{
    super::{is_event_stream, quota_sse, status_ok, UpstreamBody, UpstreamPayload},
    context_store::ContextStore,
};
use serde_json::Value;
use std::io::{self, Read};

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn watch(context: ContextStore, mut payload: UpstreamPayload) -> UpstreamPayload {
    if !status_ok(payload.status) {
        return payload;
    }
    payload.body = match payload.body {
        UpstreamBody::Buffered(bytes) => {
            observe_json(&context, &bytes);
            UpstreamBody::Buffered(bytes)
        }
        UpstreamBody::Streaming(reader) => UpstreamBody::Streaming(Box::new(ObservedReader {
            context,
            reader,
            frames: Frames::default(),
            sse: is_event_stream(payload.content_type.as_deref()),
        })),
    };
    payload
}

struct ObservedReader {
    context: ContextStore,
    reader: Box<dyn Read + Send>,
    frames: Frames,
    sse: bool,
}

impl Read for ObservedReader {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        if target.is_empty() {
            return Ok(0);
        }
        let count = self.reader.read(target)?;
        if self.sse {
            let observe = |event: &[u8]| observe_event(&self.context, event);
            if count == 0 {
                self.frames.finish(observe);
            } else {
                self.frames.observe_lines(&target[..count], observe);
            }
        } else if count == 0 {
            self.frames
                .finish(|document| observe_json(&self.context, document));
        } else {
            self.frames.append(&target[..count]);
        }
        Ok(count)
    }
}

#[derive(Default)]
struct Frames {
    bytes: Vec<u8>,
    truncated: bool,
    line_bytes: usize,
    ends_in_cr: bool,
}

impl Frames {
    fn append(&mut self, bytes: &[u8]) {
        if bytes.len() > MAX_FRAME_BYTES.saturating_sub(self.bytes.len()) {
            self.truncated = true;
        }
        if !self.truncated {
            self.bytes.extend_from_slice(bytes);
        }
    }

    fn finish(&mut self, observe: impl FnOnce(&[u8])) {
        if !self.truncated && !self.bytes.is_empty() {
            observe(&self.bytes);
        }
        self.truncated = false;
        self.bytes.clear();
    }

    fn observe_lines(&mut self, bytes: &[u8], observe: impl Fn(&[u8])) {
        for segment in bytes.split_inclusive(|byte| *byte == b'\n') {
            self.append(segment);
            if let Some(line) = segment.strip_suffix(b"\n") {
                self.observe_line_segment(line);
                if self.line_bytes == 0 || (self.line_bytes == 1 && self.ends_in_cr) {
                    self.finish(&observe);
                }
                self.line_bytes = 0;
                self.ends_in_cr = false;
            } else {
                self.observe_line_segment(segment);
            }
        }
    }

    fn observe_line_segment(&mut self, segment: &[u8]) {
        self.line_bytes = self.line_bytes.saturating_add(segment.len());
        if let Some(last) = segment.last() {
            self.ends_in_cr = *last == b'\r';
        }
    }
}

fn observe_event(context: &ContextStore, bytes: &[u8]) {
    let Ok(event) = std::str::from_utf8(bytes) else {
        return;
    };
    let Ok(Some((value, kind))) = quota_sse::event_payload(event) else {
        return;
    };
    if !kind
        .zip(value.get("type").and_then(Value::as_str))
        .is_some_and(|(name, kind)| name != kind)
    {
        context.record(&value);
    }
}

fn observe_json(context: &ContextStore, bytes: &[u8]) {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        context.record(&value);
    }
}
