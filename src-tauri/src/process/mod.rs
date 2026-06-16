//! Background process management for Ollama.
//! Spawned hidden (no console window), tracked in app state, and killed
//! (process tree) on app exit. Grammar (Harper) is in-process — not here.

pub mod ollama;

use serde::Serialize;
use std::process::{Child, Command, Stdio};

pub struct ManagedChild {
    child: Child,
    pub pid: u32,
}

/// Per-line callback for a child's stderr. Kept generic (not tied to Tauri or
/// the log buffer) so `process` stays decoupled — the caller decides what a line
/// means. Runs on a dedicated reader thread, so it must be `Send`.
pub type LogSink = Box<dyn FnMut(String) + Send>;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: Option<u16>,
}

impl ManagedChild {
    /// Spawn hidden. When `on_line` is `Some`, stderr is piped and each line is
    /// delivered to the callback on a detached reader thread (the thread ends at
    /// EOF when the child dies). With `None`, stderr is discarded — identical to
    /// the old `spawn`. The hidden-window flag and tree-kill are unaffected.
    pub fn spawn_with_stderr(
        mut command: Command,
        on_line: Option<LogSink>,
    ) -> Result<Self, String> {
        command.stdin(Stdio::null()).stdout(Stdio::null());
        if on_line.is_some() {
            command.stderr(Stdio::piped());
        } else {
            command.stderr(Stdio::null());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("spawn {:?}: {e}", command.get_program()))?;
        let pid = child.id();

        if let (Some(mut sink), Some(stderr)) = (on_line, child.stderr.take()) {
            std::thread::spawn(move || {
                use std::io::{BufRead, BufReader};
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(l) => sink(l),
                        Err(_) => break,
                    }
                }
            });
        }
        Ok(Self { child, pid })
    }

    /// True if the process has not exited.
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Kill the whole process tree — Ollama spawns model-runner children that
    /// plain Child::kill would orphan.
    pub fn kill(&mut self) {
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags_no_window()
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl NoWindow for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000)
    }
}

/// Poll a localhost port until something accepts, or time out.
pub fn wait_for_port(port: u16, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            std::time::Duration::from_millis(250),
        )
        .is_ok()
        {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stderr sink receives the child's stderr lines end-to-end (reader
    /// thread → callback). Windows-only: it shells out to cmd.
    #[cfg(windows)]
    #[test]
    fn stderr_sink_receives_lines() {
        use std::sync::mpsc;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel::<String>();
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "echo VELLUM_TEST 1>&2"]);
        let sink: LogSink = Box::new(move |line| {
            let _ = tx.send(line);
        });
        let mut child = ManagedChild::spawn_with_stderr(cmd, Some(sink)).expect("spawn");
        let got = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a stderr line within 5s");
        assert!(got.contains("VELLUM_TEST"), "unexpected stderr line: {got:?}");
        child.kill();
    }
}
