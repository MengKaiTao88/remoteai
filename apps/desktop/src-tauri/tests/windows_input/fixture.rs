use std::{
    cell::Cell,
    sync::mpsc::{self, Receiver, Sender},
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            CallNextHookEx, SendNotifyMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK,
            PM_NOREMOVE, WH_GETMESSAGE, WM_KILLFOCUS,
        },
    },
};

const SUBCLASS_ID: usize = 188;
const QUEUE_TIMEOUT: Duration = Duration::from_secs(3);

thread_local! {
    static ACTIVE: Cell<*const FocusReentry> = const { Cell::new(std::ptr::null()) };
}

/// A second thread sends focus loss while Tao is processing an input message.
/// Only Win32's internal PeekMessage dispatch can deliver it during that callback.
pub struct FocusReentry {
    hwnd: HWND,
    message: u32,
    at_ime_peek: bool,
    armed: Cell<bool>,
    inside_input: Cell<bool>,
    queued: Cell<bool>,
    nested_focus: Cell<bool>,
    hook_armed: Cell<bool>,
    sender: Sender<()>,
    enqueued: Receiver<bool>,
    worker: Option<JoinHandle<bool>>,
    hook: Option<HHOOK>,
}

impl FocusReentry {
    pub fn install(hwnd: HWND, message: u32, at_ime_peek: bool) -> Box<Self> {
        let (sender, receiver) = mpsc::channel();
        let (notify, enqueued) = mpsc::channel();
        let raw_hwnd = hwnd.0 as usize;
        let worker = thread::spawn(move || {
            if receiver.recv_timeout(QUEUE_TIMEOUT).is_err() {
                return false;
            }
            // SAFETY: The fixture retains the window through verification. WM_KILLFOCUS has
            // no pointer parameters; cross-thread notification queues it without waiting for dispatch.
            let sent = unsafe {
                SendNotifyMessageW(HWND(raw_hwnd as _), WM_KILLFOCUS, WPARAM(0), LPARAM(0)).is_ok()
            };
            notify.send(sent).is_ok() && sent
        });
        let mut fixture = Box::new(Self {
            hwnd,
            message,
            at_ime_peek,
            sender,
            enqueued,
            armed: Cell::new(true),
            inside_input: Cell::new(false),
            queued: Cell::new(false),
            nested_focus: Cell::new(false),
            hook_armed: Cell::new(false),
            worker: Some(worker),
            hook: None,
        });
        fixture.attach();
        fixture
    }

    fn attach(&mut self) {
        let pointer = self as *const Self;
        ACTIVE.with(|active| assert!(active.replace(pointer).is_null()));
        // SAFETY: The boxed fixture stays at this address until both callbacks are removed.
        // The hook is thread-local and the subclass is installed on this thread's window.
        unsafe {
            assert!(
                SetWindowSubclass(self.hwnd, Some(subclass), SUBCLASS_ID, pointer as usize)
                    .as_bool()
            );
            self.hook = Some(
                SetWindowsHookExW(
                    WH_GETMESSAGE,
                    Some(message_hook),
                    None,
                    GetCurrentThreadId(),
                )
                .unwrap(),
            );
        }
    }

    fn queue_focus(&self) {
        if self.sender.send(()).is_err() {
            return;
        }
        // QS_SENDMESSAGE describes every sender, so unrelated Windows messages can make it
        // true before this worker queues focus loss. Acknowledge our exact enqueue operation
        // without pumping the target thread; Tao's next PeekMessage must still dispatch it.
        self.queued
            .set(self.enqueued.recv_timeout(QUEUE_TIMEOUT) == Ok(true));
    }

    pub fn verify(&mut self) {
        assert!(self.queued.get(), "focus message was not queued");
        assert!(
            self.nested_focus.get(),
            "focus loss did not reenter the input callback"
        );
        assert!(
            self.worker.take().unwrap().join().unwrap(),
            "focus delivery timed out"
        );
    }
}

impl Drop for FocusReentry {
    fn drop(&mut self) {
        // SAFETY: Both registrations belong to this thread and their window is still alive.
        unsafe {
            assert!(RemoveWindowSubclass(self.hwnd, Some(subclass), SUBCLASS_ID).as_bool());
            if let Some(hook) = self.hook.take() {
                UnhookWindowsHookEx(hook).unwrap();
            }
        }
        ACTIVE.with(|active| active.set(std::ptr::null()));
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

// The six-argument signature is required by SUBCLASSPROC. Never panic across this ABI.
unsafe extern "system" fn subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    // SAFETY: attach registers the stable boxed pointer; Drop unregisters before freeing it.
    let fixture = unsafe { &*(data as *const FocusReentry) };
    if message == WM_KILLFOCUS && fixture.inside_input.get() {
        fixture.nested_focus.set(true);
    }
    let inject = message == fixture.message && fixture.armed.replace(false);
    if inject {
        fixture.inside_input.set(true);
        if fixture.at_ime_peek {
            fixture.hook_armed.set(true);
        } else {
            fixture.queue_focus();
        }
    }
    // SAFETY: Forward the original parameters to the rest of this window's subclass chain.
    let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    if inject {
        fixture.inside_input.set(false);
    }
    result
}

unsafe extern "system" fn message_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && wparam.0 == PM_NOREMOVE.0 as usize {
        ACTIVE.with(|active| {
            // SAFETY: ACTIVE points to the boxed fixture for the lifetime of this thread's hook.
            if let Some(fixture) = unsafe { active.get().as_ref() } {
                // The keyboard peek has already dispatched sent messages. Queue focus now,
                // so the following IME peek (formerly under window_state) dispatches it.
                if fixture.inside_input.get() && fixture.hook_armed.replace(false) {
                    fixture.queue_focus();
                }
            }
        });
    }
    // SAFETY: These are the unchanged parameters of a thread-local WH_GETMESSAGE callback.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
