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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use harper_core::linting::{LintGroup, LintKind, Linter, Suggestion};
use harper_core::spell::{Dictionary, FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{Dialect, DictWordMetadata, Document};
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
    /// True for misspellings (`LintKind::Spelling`). The frontend renders these
    /// with a distinct underline + spelling context menu and gates them on the
    /// spell-check toggle rather than the grammar toggle (spec Section 10 design
    /// note: spelling is sourced from Harper, not WebView2).
    pub is_spelling: bool,
    /// Replacement strings for the span; an empty string means "remove". Only
    /// whole-span replacements are surfaced (insert-after suggestions are rare
    /// and don't fit the click-to-replace model, so they're omitted in v1).
    pub suggestions: Vec<String>,
}

thread_local! {
    // (generation, dictionary, linter): rebuilt when the global dictionary
    // generation changes (a word was added/removed). The merged dictionary is
    // kept alongside the linter so the document is parsed with the SAME
    // dictionary the linter checks against — otherwise a freshly added word is
    // still tagged "unknown" at parse time and flagged as a misspelling.
    static LINTER: RefCell<Option<(u64, Arc<MergedDictionary>, LintGroup)>> =
        const { RefCell::new(None) };
}

/// The user's custom dictionary words (spec Section 10), shared across worker
/// threads. Set at startup from `app.json` and whenever the user adds/removes a
/// word; bumping `DICT_GEN` invalidates every thread's cached linter.
static USER_WORDS: RwLock<Vec<String>> = RwLock::new(Vec::new());
static DICT_GEN: AtomicU64 = AtomicU64::new(0);

/// Replace the set of user dictionary words and invalidate cached linters so the
/// next lint on every thread rebuilds with the new dictionary.
pub fn set_user_words(words: Vec<String>) {
    if let Ok(mut w) = USER_WORDS.write() {
        *w = words;
    }
    DICT_GEN.fetch_add(1, Ordering::SeqCst);
}

/// Build the dictionary (curated merged with the user's custom words) and a
/// `LintGroup` over it, so added words (product names, jargon) stop being
/// flagged as misspellings. The curated dictionary is inserted first so its
/// richer metadata wins on any overlap. The dictionary is returned too so the
/// caller can parse documents with it.
fn build_linter() -> (Arc<MergedDictionary>, LintGroup) {
    let mut merged = MergedDictionary::new();
    let curated: Arc<dyn Dictionary> = FstDictionary::curated();
    merged.add_dictionary(curated);

    if let Ok(words) = USER_WORDS.read() {
        if !words.is_empty() {
            let mut user = MutableDictionary::new();
            for w in words.iter() {
                user.append_word_str(w, DictWordMetadata::default());
            }
            let user: Arc<dyn Dictionary> = Arc::new(user);
            merged.add_dictionary(user);
        }
    }

    let merged = Arc::new(merged);
    let group = LintGroup::new_curated(merged.clone(), Dialect::American);
    (merged, group)
}

/// Lint `text` and return spans with suggestions. English-only (v1).
pub fn check(text: &str) -> Vec<GrammarSpan> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let lints = LINTER.with(|cell| {
        let mut opt = cell.borrow_mut();
        let generation = DICT_GEN.load(Ordering::SeqCst);
        let stale = match opt.as_ref() {
            Some((g, _, _)) => *g != generation,
            None => true,
        };
        if stale {
            let (dict, group) = build_linter();
            *opt = Some((generation, dict, group));
        }
        let (_, dict, group) = opt.as_mut().expect("linter built above");
        // Parse with the merged dictionary so custom words are known at parse
        // time (otherwise the spell linter re-flags them).
        let doc = Document::new_plain_english(text, &**dict);
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
                is_spelling: matches!(l.lint_kind, LintKind::Spelling),
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
    fn custom_dictionary_suppresses_spelling_lint() {
        // A nonsense token is flagged as a misspelling...
        let sentence = "I really like Qwertzuiop today.";
        set_user_words(Vec::new());
        let flagged_before = check(sentence).iter().any(|s| s.is_spelling);
        // ...until the user adds it to their dictionary.
        set_user_words(vec!["Qwertzuiop".to_string()]);
        let flagged_after = check(sentence).iter().any(|s| s.is_spelling);
        // Restore global state first so a failed assertion can't leave the
        // shared dictionary dirty for other tests.
        set_user_words(Vec::new());
        assert!(flagged_before, "expected the nonsense word to be flagged first");
        assert!(!flagged_after, "expected no spelling lint after adding the word");
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

    #[test]
    fn blank_line_breaks_a_colon_terminated_paragraph() {
        // Regression (execution-plan GRAMMARBUG): a paragraph ending in a colon
        // followed by another paragraph must not be merged into one sentence.
        // The frontend (grammar.ts extractText) joins blocks with a blank line
        // (two newlines) so Harper's tokenizer sees a paragraph boundary. Each
        // part below is under Harper's ~40-word readability threshold; only
        // their 49-word merge trips it.
        let a = "When you are planning the upcoming release you should carefully review each of the following important considerations before you make any final decision";
        let b = "The team has already agreed that shipping early is better than waiting for every single feature to be completely polished and thoroughly tested by everyone involved";

        // A single newline is too weak a break after a colon: the two paragraphs
        // merge and Harper flags the combined 49-word "sentence".
        let single = check(&format!("{a}:\n{b}."));
        assert!(
            single.iter().any(|s| s.kind == "Readability"),
            "single-newline colon join should merge into one over-long sentence"
        );

        // A blank line (what extractText actually emits) is a hard paragraph
        // break: the two sentences are checked independently and neither is long.
        let double = check(&format!("{a}:\n\n{b}."));
        assert!(
            double.is_empty(),
            "blank-line paragraph break should not be flagged as a run-on: {double:?}"
        );
    }
}
