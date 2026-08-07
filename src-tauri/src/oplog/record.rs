//! What a change log entry says.
//!
//! Records describe **intent**, not row diffs: "page 7 moved to section 3",
//! never "row updated, column section_id changed". Intent is what lets two
//! devices' edits merge — a diff only makes sense against the exact state it
//! was taken from, which the other device does not have.
//!
//! Everything here is written to disk forever, so it is versioned from the
//! first record and additive by construction: unknown operations from a newer
//! Vellum are preserved rather than dropped (see [`Record::is_understood`]).

use serde::{Deserialize, Serialize};

use super::clock::Timestamp;

/// Bumped only for a change that older readers cannot safely interpret.
pub const FORMAT_VERSION: u32 = 1;

/// A single logged intent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Format version, on every record rather than once per file: logs are
    /// concatenated across devices and versions.
    pub v: u32,
    /// Hybrid logical clock stamp, sortable as text.
    pub hlc: String,
    /// Which device wrote it — the tie-breaker when two stamps match, and how a
    /// replay knows whose file it came from after logs are merged.
    pub dev: String,
    #[serde(flatten)]
    pub op: Op,
}

/// The operations a notebook can undergo.
///
/// Ordering-sensitive fields (a position, a parent) carry their intended value
/// rather than a delta, so replaying out of order converges.
///
/// `rename_all_fields` is needed as well as `rename_all`: the latter renames
/// variants only, which would leave field names snake_case and inconsistent
/// with every other JSON file Vellum writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    SectionCreated {
        id: String,
        name: String,
        position: i64,
    },
    SectionRenamed {
        id: String,
        name: String,
    },
    SectionMoved {
        id: String,
        position: i64,
    },
    SectionDeleted {
        id: String,
    },
    SectionRestored {
        id: String,
    },
    PageCreated {
        id: String,
        section_id: String,
        title: String,
        position: i64,
    },
    PageRetitled {
        id: String,
        title: String,
    },
    /// Covers reordering within a section and moving between sections, because
    /// they are the same intent: "this page now sits here".
    PageMoved {
        id: String,
        section_id: String,
        position: i64,
    },
    PageDeleted {
        id: String,
    },
    PageRestored {
        id: String,
    },
    /// The page's document, whole. Tiptap documents are small and replacing
    /// wholesale keeps replay honest; per-keystroke deltas are phase B's problem.
    PageContentSet {
        id: String,
        /// Tiptap document JSON.
        content: serde_json::Value,
    },
    AttachmentAdded {
        id: String,
        page_id: String,
        filename: String,
    },
    AttachmentRemoved {
        id: String,
    },
    /// An operation written by a newer Vellum. Kept verbatim so replaying and
    /// rewriting a log never silently discards someone else's work.
    #[serde(other)]
    Unknown,
}

impl Record {
    pub fn new(dev: &str, hlc: Timestamp, op: Op) -> Self {
        Self {
            v: FORMAT_VERSION,
            hlc: hlc.encode(),
            dev: dev.to_string(),
            op,
        }
    }

    /// False for an operation this build doesn't recognise, which a replay must
    /// refuse to treat as a complete picture.
    pub fn is_understood(&self) -> bool {
        self.v <= FORMAT_VERSION && self.op != Op::Unknown
    }

    /// Sort key: stamp first, then device so identical stamps break ties the
    /// same way on every machine.
    pub fn order_key(&self) -> (&str, &str) {
        (&self.hlc, &self.dev)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(ms: u64) -> Timestamp {
        Timestamp { wall_ms: ms, counter: 0 }
    }

    #[test]
    fn records_round_trip_through_json() {
        let record = Record::new(
            "dev-1",
            stamp(1_700_000_000_000),
            Op::PageMoved {
                id: "page-7".into(),
                section_id: "section-3".into(),
                position: 2,
            },
        );
        let line = serde_json::to_string(&record).unwrap();
        assert_eq!(serde_json::from_str::<Record>(&line).unwrap(), record);
        // The operation is flattened alongside the envelope, so a log line is
        // readable without unwrapping a nested object.
        assert!(line.contains("\"op\":\"pageMoved\""), "{line}");
        assert!(line.contains("\"sectionId\":\"section-3\""), "{line}");
    }

    /// A newer Vellum will write operations this build has never heard of.
    /// Failing to parse the whole log would be worse than not understanding one
    /// line, so unknown operations decode rather than error.
    #[test]
    fn an_unknown_operation_decodes_instead_of_failing() {
        let line = r#"{"v":1,"hlc":"0001700000000000-00000","dev":"d","op":"pageTagged","tag":"x"}"#;
        let record: Record = serde_json::from_str(line).expect("must not fail to parse");
        assert_eq!(record.op, Op::Unknown);
        assert!(!record.is_understood(), "an unknown op must not count as understood");
    }

    #[test]
    fn a_newer_format_version_is_not_treated_as_understood() {
        let mut record = Record::new("d", stamp(1), Op::SectionDeleted { id: "s".into() });
        assert!(record.is_understood());
        record.v = FORMAT_VERSION + 1;
        assert!(!record.is_understood());
    }

    #[test]
    fn ordering_is_by_stamp_then_device() {
        let early = Record::new("b", stamp(1_700_000_000_000), Op::PageDeleted { id: "p".into() });
        let late = Record::new("a", stamp(1_700_000_000_001), Op::PageDeleted { id: "p".into() });
        assert!(early.order_key() < late.order_key());

        // Same instant on two devices resolves the same way everywhere.
        let a = Record::new("a", stamp(5), Op::PageDeleted { id: "p".into() });
        let b = Record::new("b", stamp(5), Op::PageDeleted { id: "p".into() });
        assert!(a.order_key() < b.order_key());
    }
}
