//! "The person has gone" signals from the operating system
//! (docs/satchels-and-sync.md 5.2).
//!
//! Locking the workstation and suspending the machine both mean *gone*
//! unambiguously, so they hand the Satchel back immediately rather than waiting
//! out the idle timer. Neither reaches a WebView, so both are read from Win32
//! and forwarded to the window as one event.
//!
//! The decision — which message means gone — is [`classify`], a plain function
//! with no Windows types in its signature, so it is compiled and tested on
//! every platform CI builds. Only the plumbing is `#[cfg(windows)]`.

use serde::Serialize;

/// Why this device is about to stop being used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GoneReason {
    Locked,
    Suspending,
}

/// The event the window listens for.
pub const GONE_EVENT: &str = "sync://device-gone";

// Declared here rather than imported so this file, and its tests, build on
// macOS and Linux too.
const WM_POWERBROADCAST: u32 = 0x0218;
const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const PBT_APMSUSPEND: usize = 0x0004;
const WTS_SESSION_LOCK: usize = 0x7;

/// Whether a Windows notification means the person has gone.
///
/// Everything else is deliberately `None`: unlocking and resuming are handled
/// by the ordinary return-to-the-window path, which re-takes the Satchel
/// optimistically, so acting on them here would only duplicate it.
pub fn classify(msg: u32, wparam: usize) -> Option<GoneReason> {
    match (msg, wparam) {
        (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK) => Some(GoneReason::Locked),
        (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some(GoneReason::Suspending),
        _ => None,
    }
}

#[cfg(windows)]
pub use win::watch;

/// Nothing to watch off Windows: v1 ships Windows only, and the idle timer is
/// the portable half of YIELD.
#[cfg(not(windows))]
pub fn watch(_app: tauri::AppHandle) {}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    };
    use windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, DEVICE_NOTIFY_CALLBACK, HWND_MESSAGE, MSG, WINDOW_EX_STYLE,
        WINDOW_STYLE, WNDCLASSW,
    };

    use super::{classify, GoneReason, GONE_EVENT, WM_POWERBROADCAST};

    /// Only this session's lock and unlock, not every session on the machine.
    const NOTIFY_FOR_THIS_SESSION: u32 = 0;

    /// The window proc is a bare `extern "system"` function with nowhere to put
    /// a handle, and there is exactly one app, so it lives here.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    const CLASS_NAME: PCWSTR = windows::core::w!("VellumPresenceWatcher");

    fn announce(reason: GoneReason) {
        if let Some(app) = APP.get() {
            let _ = app.emit(GONE_EVENT, reason);
        }
    }

    /// Start watching. Best-effort: if any of this fails the idle timer still
    /// yields, just not instantly, so nothing here is worth failing launch over.
    pub fn watch(app: AppHandle) {
        if APP.set(app).is_err() {
            return;
        }
        std::thread::spawn(|| unsafe { pump() });
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if let Some(reason) = classify(msg, wparam.0) {
            announce(reason);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Power notifications are registered with a callback rather than a window:
    /// `WM_POWERBROADCAST` is broadcast to *top-level* windows, which a
    /// message-only window is not, so the window route would silently never
    /// fire.
    unsafe extern "system" fn on_power(
        _context: *const c_void,
        kind: u32,
        _setting: *const c_void,
    ) -> u32 {
        if let Some(reason) = classify(WM_POWERBROADCAST, kind as usize) {
            announce(reason);
        }
        0 // ERROR_SUCCESS
    }

    /// A message-only window of our own, deliberately: subclassing Tauri's
    /// window would put this in the middle of the message stream the entire UI
    /// depends on, and session notifications need nothing from that window.
    unsafe fn pump() {
        let Ok(instance) = GetModuleHandleW(None) else {
            return;
        };
        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return;
        }
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            CLASS_NAME,
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        ) else {
            return;
        };

        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        // Leaked on purpose: the callback dereferences it for the life of the
        // process, and this thread only ends when the process does.
        let params = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power),
            Context: std::ptr::null_mut(),
        }));
        let mut registration: *mut c_void = std::ptr::null_mut();
        let _ = PowerRegisterSuspendResumeNotification(
            DEVICE_NOTIFY_CALLBACK,
            HANDLE(params as *mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS as *mut c_void),
            &mut registration,
        );

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_locking_and_suspending_mean_the_person_has_gone() {
        assert_eq!(classify(WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK), Some(GoneReason::Locked));
        assert_eq!(classify(WM_POWERBROADCAST, PBT_APMSUSPEND), Some(GoneReason::Suspending));
    }

    #[test]
    fn coming_back_is_not_a_gone_signal() {
        const WTS_SESSION_UNLOCK: usize = 0x8;
        const WTS_SESSION_LOGON: usize = 0x5;
        const PBT_APMRESUMEAUTOMATIC: usize = 0x12;
        const PBT_APMRESUMESUSPEND: usize = 0x7;
        // Returning is handled by the window regaining focus, which re-takes
        // the Satchel optimistically. Yielding on any of these would be a bug.
        assert_eq!(classify(WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK), None);
        assert_eq!(classify(WM_WTSSESSION_CHANGE, WTS_SESSION_LOGON), None);
        assert_eq!(classify(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC), None);
        assert_eq!(classify(WM_POWERBROADCAST, PBT_APMRESUMESUSPEND), None);
    }

    #[test]
    fn the_two_messages_do_not_bleed_into_each_other() {
        // Same numeric payload, different message: PBT_APMSUSPEND is 0x4 and
        // WTS_SESSION_LOCK is 0x7, so a classifier that ignored `msg` would
        // read a session logoff as a suspend.
        assert_eq!(classify(WM_WTSSESSION_CHANGE, PBT_APMSUSPEND), None);
        assert_eq!(classify(WM_POWERBROADCAST, WTS_SESSION_LOCK), None);
        assert_eq!(classify(0, WTS_SESSION_LOCK), None);
    }
}
