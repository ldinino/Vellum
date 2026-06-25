//! Best-effort page-title lookup for pasted links (UX polish): when the user
//! pastes a bare URL, the renderer asks for the page's `<title>` so the link
//! can read "Google" instead of "https://google.com".
//!
//! The fetch is deliberately conservative — http/https only, a short timeout, a
//! capped read that stops at `</title>` — so a slow or hostile page can't hang
//! the editor or stream an unbounded body. Any failure returns `Ok(None)`/`Err`
//! and the renderer simply keeps the raw URL as the label.

use std::time::Duration;

use futures_util::StreamExt;

/// Stop reading the body after this much: a `<title>` lives in `<head>`, so we
/// never need the whole page. Also the hard ceiling for a title-less page.
const MAX_BYTES: usize = 512 * 1024;

/// Overall request budget. Title lookup is a nicety, not worth a long stall.
const TIMEOUT: Duration = Duration::from_secs(10);

/// Clamp the returned label so a pathological `<title>` can't bloat the doc.
const MAX_TITLE_CHARS: usize = 300;

/// Fetch `url` and return its `<title>`, or `None` when there isn't a usable
/// one (non-HTML response, empty title, etc.). Only http/https is fetched.
pub async fn fetch_title(url: &str) -> Result<Option<String>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: {other}")),
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; Vellum)")
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(parsed)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    // Only parse markup; a PDF/image/zip URL has no <title> worth scraping and
    // its bytes shouldn't be decoded as text. A missing header → assume HTML.
    let is_markup = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| {
            let ct = ct.to_ascii_lowercase();
            ct.contains("text/html") || ct.contains("application/xhtml")
        })
        .unwrap_or(true);
    if !is_markup {
        return Ok(None);
    }

    // Stream the body, stopping at the closing tag or the byte cap so a huge or
    // never-ending response can't be buffered whole.
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        let tail = buf.len().saturating_sub(b"</title>".len() - 1);
        buf.extend_from_slice(&chunk);
        // Only rescan the newly arrived region (plus a small overlap) so the
        // scan stays linear in the body size rather than quadratic in chunks.
        if contains_ci(&buf[tail..], b"</title>") {
            break;
        }
        if buf.len() >= MAX_BYTES {
            buf.truncate(MAX_BYTES);
            break;
        }
    }

    let html = String::from_utf8_lossy(&buf);
    Ok(extract_title(&html))
}

/// Pull the text between the first `<title …>` and `</title>`, decode its HTML
/// entities, and collapse whitespace. `None` when there's no usable title.
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let tag = lower.find("<title")?;
    // Skip past the rest of the opening tag (it may carry attributes).
    let open_end = lower[tag..].find('>')? + tag + 1;
    let close = lower[open_end..].find("</title>")? + open_end;
    let decoded = decode_entities(&html[open_end..close]);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(MAX_TITLE_CHARS).collect())
}

/// Case-insensitive (ASCII) substring test over raw bytes.
fn contains_ci(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|w| w.eq_ignore_ascii_case(needle))
}

/// Decode the small set of HTML entities that show up in titles — the five
/// named XML ones plus numeric (`&#8217;` / `&#x2019;`) references, which
/// publishers lean on for typographic punctuation. Unknown sequences are left
/// verbatim.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < s.len() {
        if bytes[i] == b'&' {
            // An entity body is short; bound the scan so a stray '&' in prose
            // doesn't trigger a long search to a far-off ';'.
            if let Some(rel) = s[i + 1..].char_indices().find_map(|(j, c)| {
                if c == ';' {
                    Some(j)
                } else if j > 10 {
                    Some(usize::MAX) // sentinel: too long to be an entity
                } else {
                    None
                }
            }) {
                if rel != usize::MAX {
                    if let Some(ch) = decode_one(&s[i + 1..i + 1 + rel]) {
                        out.push(ch);
                        i += 1 + rel + 1;
                        continue;
                    }
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Resolve one entity body (the text between `&` and `;`) to a char.
fn decode_one(body: &str) -> Option<char> {
    match body {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some('\u{00A0}'),
        _ => {
            let code = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                body.strip_prefix('#')?.parse::<u32>().ok()?
            };
            char::from_u32(code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_basic_title() {
        let html = "<html><head><title>Google</title></head><body>…";
        assert_eq!(extract_title(html).as_deref(), Some("Google"));
    }

    #[test]
    fn case_insensitive_tag_and_attributes() {
        let html = r#"<HEAD><TITLE lang="en">  Hello   World  </TITLE>"#;
        assert_eq!(extract_title(html).as_deref(), Some("Hello World"));
    }

    #[test]
    fn decodes_named_and_numeric_entities() {
        let html = "<title>Tom &amp; Jerry &#8217;s &#x201C;quote&#x201D;</title>";
        assert_eq!(
            extract_title(html).as_deref(),
            Some("Tom & Jerry \u{2019}s \u{201C}quote\u{201D}"),
        );
    }

    #[test]
    fn leaves_unknown_ampersand_intact() {
        let html = "<title>Fish & Chips Co; Ltd</title>";
        assert_eq!(extract_title(html).as_deref(), Some("Fish & Chips Co; Ltd"));
    }

    #[test]
    fn none_when_missing_or_empty() {
        assert_eq!(extract_title("<html><body>no title</body></html>"), None);
        assert_eq!(extract_title("<title>   </title>"), None);
    }
}
