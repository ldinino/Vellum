//! Hybrid logical clock.
//!
//! Ordering edits by wall clock alone breaks the moment two machines disagree
//! about the time — and they always do. An HLC keeps wall-clock meaning (a
//! stamp still tells you roughly *when*) while guaranteeing that causally
//! ordered events compare correctly even if a clock jumps backwards.
//!
//! Stamps are stored as a fixed-width sortable string, so ordering a log is a
//! plain lexicographic sort with no parsing.

use std::sync::Mutex;

/// Milliseconds since the Unix epoch, zero-padded so string order matches
/// numeric order until the year 33658.
const WALL_WIDTH: usize = 13;
/// Ticks within a millisecond. Five digits is ~65k events in one millisecond,
/// far beyond what a note editor can produce.
const COUNTER_WIDTH: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Timestamp {
    pub wall_ms: u64,
    pub counter: u32,
}

impl Timestamp {
    /// Sortable text form: `<wall>-<counter>`. Node identity is carried by the
    /// record itself, not the stamp, so an identical stamp from two devices
    /// stays a tie the merge rules resolve rather than an ordering accident.
    pub fn encode(&self) -> String {
        format!(
            "{:0wall$}-{:0counter$}",
            self.wall_ms,
            self.counter,
            wall = WALL_WIDTH,
            counter = COUNTER_WIDTH
        )
    }

    pub fn decode(text: &str) -> Option<Self> {
        let (wall, counter) = text.split_once('-')?;
        Some(Self {
            wall_ms: wall.parse().ok()?,
            counter: counter.parse().ok()?,
        })
    }
}

/// A clock that never goes backwards, whatever the operating system says.
#[derive(Debug, Default)]
pub struct Clock {
    last: Mutex<Timestamp>,
}

impl Clock {
    /// Stamp a locally generated event.
    pub fn now(&self) -> Timestamp {
        self.tick(wall_now_ms())
    }

    /// Fold in a stamp seen from another device, so our clock is at least as
    /// advanced as anything we have observed. Returns our new stamp.
    pub fn observe(&self, remote: Timestamp) -> Timestamp {
        let wall = wall_now_ms().max(remote.wall_ms);
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        let next = if wall > last.wall_ms && wall > remote.wall_ms {
            Timestamp { wall_ms: wall, counter: 0 }
        } else {
            // Same millisecond as our last, or as the remote's: step past
            // whichever counter is higher so ours sorts after both.
            Timestamp {
                wall_ms: wall,
                counter: last.counter.max(remote.counter).saturating_add(1),
            }
        };
        *last = next;
        next
    }

    fn tick(&self, wall: u64) -> Timestamp {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        // A clock that jumped backwards must not produce a stamp that sorts
        // before work we have already recorded.
        let next = if wall > last.wall_ms {
            Timestamp { wall_ms: wall, counter: 0 }
        } else {
            Timestamp {
                wall_ms: last.wall_ms,
                counter: last.counter.saturating_add(1),
            }
        };
        *last = next;
        next
    }
}

fn wall_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_lexicographically_ordered() {
        let a = Timestamp { wall_ms: 1_700_000_000_000, counter: 0 };
        let b = Timestamp { wall_ms: 1_700_000_000_000, counter: 1 };
        let c = Timestamp { wall_ms: 1_700_000_000_001, counter: 0 };
        assert!(a.encode() < b.encode());
        assert!(b.encode() < c.encode());
        // Padding is what makes string order match numeric order.
        let small = Timestamp { wall_ms: 999, counter: 0 };
        assert!(small.encode() < a.encode(), "{} !< {}", small.encode(), a.encode());
    }

    #[test]
    fn stamps_round_trip() {
        let t = Timestamp { wall_ms: 1_700_000_000_123, counter: 42 };
        assert_eq!(Timestamp::decode(&t.encode()), Some(t));
        assert_eq!(Timestamp::decode("nonsense"), None);
    }

    #[test]
    fn a_burst_within_one_millisecond_still_orders() {
        let clock = Clock::default();
        let stamps: Vec<String> = (0..1000).map(|_| clock.now().encode()).collect();
        let mut sorted = stamps.clone();
        sorted.sort();
        assert_eq!(stamps, sorted, "stamps from one burst came out unordered");
        assert_eq!(
            stamps.iter().collect::<std::collections::HashSet<_>>().len(),
            stamps.len(),
            "duplicate stamps in a burst"
        );
    }

    #[test]
    fn a_clock_moving_backwards_cannot_rewrite_history() {
        let clock = Clock::default();
        let first = clock.tick(1_700_000_000_000);
        // The operating system reports an earlier time — NTP correction, or a
        // laptop resuming with a stale clock.
        let second = clock.tick(1_600_000_000_000);
        assert!(
            second.encode() > first.encode(),
            "a backwards clock produced a stamp that sorts before earlier work"
        );
        assert_eq!(second.wall_ms, first.wall_ms);
    }

    #[test]
    fn observing_a_future_stamp_advances_us_past_it() {
        let clock = Clock::default();
        let ours = clock.now();
        let theirs = Timestamp { wall_ms: ours.wall_ms + 60_000, counter: 7 };
        let merged = clock.observe(theirs);
        assert!(
            merged.encode() > theirs.encode(),
            "we must sort after a stamp we have seen"
        );
        // And we stay ahead afterwards.
        assert!(clock.now().encode() > merged.encode());
    }
}
