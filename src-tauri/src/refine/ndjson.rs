//! Shared NDJSON line splitter for Ollama's streaming endpoints (`/api/pull`,
//! `/api/generate`) — each emits one JSON object per line.

/// Drain complete newline-terminated lines from `buf`, leaving any partial tail
/// for the next chunk. Blank lines and trailing `\r` are dropped.
pub fn take_lines(buf: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let mut line: Vec<u8> = buf.drain(..=pos).collect();
        line.pop(); // drop '\n'
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_chunk_boundaries() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"{\"a\":1}\n{\"b\":2}\n{\"c\"");
        let lines = take_lines(&mut buf);
        assert_eq!(lines.len(), 2);
        assert_eq!(buf, b"{\"c\""); // partial tail retained

        buf.extend_from_slice(b":3}\n");
        let more = take_lines(&mut buf);
        assert_eq!(more.len(), 1);
        assert_eq!(more[0], b"{\"c\":3}");
        assert!(buf.is_empty());
    }

    #[test]
    fn strips_crlf_and_skips_blanks() {
        let mut buf = b"{\"x\":1}\r\n\n{\"y\":2}\n".to_vec();
        let lines = take_lines(&mut buf);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], b"{\"x\":1}");
        assert_eq!(lines[1], b"{\"y\":2}");
    }
}
