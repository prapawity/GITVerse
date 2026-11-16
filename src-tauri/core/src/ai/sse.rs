//! Minimal Server-Sent Events parser for streaming API responses.

/// Feed bytes in, get complete `(event, data)` pairs out.
#[derive(Default)]
pub struct SseParser {
    buf: String,
    pending: Vec<u8>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<(String, String)> {
        self.pending.extend_from_slice(bytes);
        // keep an incomplete UTF-8 tail for the next chunk
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        self.buf
            .push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
        self.pending.drain(..valid);
        let mut out = Vec::new();
        loop {
            let normalized = self.buf.replace("\r\n", "\n");
            let Some(end) = normalized.find("\n\n") else {
                self.buf = normalized;
                break;
            };
            let block = normalized[..end].to_owned();
            self.buf = normalized[end + 2..].to_owned();
            let (mut event, mut data) = (String::from("message"), Vec::new());
            for line in block.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim().to_owned();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v).to_owned());
                }
            }
            if !data.is_empty() {
                out.push((event, data.join("\n")));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::SseParser;

    #[test]
    fn splits_events_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: a\r\ndata: {\"x\"").is_empty());
        let events = p.push(b":1}\r\n\r\nevent: b\ndata: 2\n\n");
        assert_eq!(
            events,
            vec![("a".into(), "{\"x\":1}".into()), ("b".into(), "2".into())]
        );
    }
}
