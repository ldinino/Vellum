//! Grammar checking via Harper (`harper-core`), compiled in-process (spec
//! Section 10). No separate runtime, no server, no download — the curated
//! dictionary and the rule set are embedded in the binary.
//!
//! The renderer sends the current page's plain text; we return lint spans the
//! frontend maps back onto ProseMirror positions. Offsets are returned in
//! **UTF-16 code units** so they index a JavaScript string directly (Harper
//! works in Unicode scalar values, which differ for astral chars like emoji).
//!
//! The `LintGroup` (and the dictionary it loads) is built once per worker thread
//! and reused: the first lint on a thread pays for loading the embedded
//! dictionary + POS model, later calls are cheap. It can't be a shared global —
//! `LintGroup` holds `Box<dyn ExprLinter>` and isn't `Send`/`Sync` — so it lives
//! in a `thread_local!` (the command runs `check` on a small `spawn_blocking`
//! pool, so only a handful of threads ever build one).

use std::cell::RefCell;

use harper_core::linting::{LintGroup, Linter, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarSpan {
    /// UTF-16 offsets into the submitted text (end exclusive).
    pub start: usize,
    pub end: usize,
    pub message: String,
    /// Lint category (e.g. "Agreement", "Spelling"). Used as the rule identifier
    /// for the "Ignore Rule" action.
    pub kind: String,
    /// Replacement strings for the span; an empty string means "remove". Only
    /// whole-span replacements are surfaced (insert-after suggestions are rare
    /// and don't fit the click-to-replace model, so they're omitted in v1).
    pub suggestions: Vec<String>,
}

thread_local! {
    static LINTER: RefCell<Option<LintGroup>> = const { RefCell::new(None) };
}

/// Lint `text` and return spans with suggestions. English-only (v1).
pub fn check(text: &str) -> Vec<GrammarSpan> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let doc = Document::new_plain_english_curated(text);
    let lints = LINTER.with(|cell| {
        let mut opt = cell.borrow_mut();
        let group = opt.get_or_insert_with(|| {
            LintGroup::new_curated(FstDictionary::curated(), Dialect::American)
        });
        group.lint(&doc)
    });

    // Prefix sums: char index -> UTF-16 offset, so we can convert Harper's
    // char-indexed spans to the JS string indices the frontend expects.
    let chars: Vec<char> = text.chars().collect();
    let mut utf16_at = Vec::with_capacity(chars.len() + 1);
    let mut acc = 0usize;
    utf16_at.push(0);
    for c in &chars {
        acc += c.len_utf16();
        utf16_at.push(acc);
    }
    let to_u16 = |char_idx: usize| utf16_at[char_idx.min(chars.len())];

    lints
        .into_iter()
        .map(|l| {
            let suggestions = l
                .suggestions
                .iter()
                .filter_map(|s| match s {
                    Suggestion::ReplaceWith(chs) => Some(chs.iter().collect::<String>()),
                    Suggestion::Remove => Some(String::new()),
                    Suggestion::InsertAfter(_) => None,
                })
                .collect();
            GrammarSpan {
                start: to_u16(l.span.start),
                end: to_u16(l.span.end),
                message: l.message,
                kind: l.lint_kind.to_string(),
                suggestions,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_repeated_word_with_suggestion() {
        // "the the" is an obvious repetition Harper catches.
        let spans = check("I went to the the store.");
        assert!(!spans.is_empty(), "expected at least one lint");
        let rep = spans
            .iter()
            .find(|s| !s.suggestions.is_empty())
            .expect("expected a lint with a suggestion");
        // Span offsets must be within the text and well-ordered.
        assert!(rep.start < rep.end && rep.end <= "I went to the the store.".len());
        assert!(!rep.kind.is_empty());
    }

    #[test]
    fn clean_text_has_no_lints() {
        assert!(check("The quick brown fox jumps over the lazy dog.").is_empty());
    }

    #[test]
    fn empty_text_is_safe() {
        assert!(check("   ").is_empty());
    }

    #[test]
    fn utf16_offsets_account_for_astral_chars() {
        // A leading emoji is 2 UTF-16 units; a misspelling after it must report
        // UTF-16 offsets, not scalar-char offsets.
        let text = "😀 teh end";
        let spans = check(text);
        let teh = spans.iter().find(|s| !s.suggestions.is_empty());
        if let Some(s) = teh {
            // "teh" starts at scalar index 2 but UTF-16 index 3 (emoji = 2 units).
            assert_eq!(&utf16_slice(text, s.start, s.end).to_lowercase(), "teh");
        }
    }

    /// Slice a string by UTF-16 offsets (mirrors how JS would index it).
    fn utf16_slice(s: &str, start: usize, end: usize) -> String {
        let units: Vec<u16> = s.encode_utf16().collect();
        String::from_utf16_lossy(&units[start..end])
    }
}
