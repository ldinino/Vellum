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

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: Option<u16>,
}

impl ManagedChild {
    pub fn spawn(mut command: Command) -> Result<Self, String> {
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command
            .spawn()
            .map_err(|e| format!("spawn {:?}: {e}", command.get_program()))?;
        let pid = child.id();
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
