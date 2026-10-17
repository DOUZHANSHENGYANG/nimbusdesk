//! Standalone regression harness: compile with rustc --test and the root-built
//! everything_ipc rlib. No upstream dev dependencies or installed engine needed.
use everything_ipc::IpcWindow;
use std::{ffi::c_void, ptr};

#[repr(C)]
struct WindowClass {
    style: u32,
    procedure: Option<unsafe extern "system" fn(*mut c_void, u32, usize, isize) -> isize>,
    class_extra: i32,
    window_extra: i32,
    instance: *mut c_void,
    icon: *mut c_void,
    cursor: *mut c_void,
    brush: *mut c_void,
    menu_name: *const u16,
    class_name: *const u16,
}
#[link(name = "user32")]
unsafe extern "system" {
    fn RegisterClassW(class: *const WindowClass) -> u16;
    fn UnregisterClassW(class: *const u16, instance: *mut c_void) -> i32;
    fn CreateWindowExW(
        ex_style: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: *mut c_void,
        menu: *mut c_void,
        instance: *mut c_void,
        param: *mut c_void,
    ) -> *mut c_void;
    fn DestroyWindow(window: *mut c_void) -> i32;
    fn DefWindowProcW(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
}

unsafe extern "system" fn procedure(
    window: *mut c_void,
    message: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}
struct HiddenWindow {
    window: *mut c_void,
    instance: *mut c_void,
    class: Vec<u16>,
}
impl HiddenWindow {
    fn named(instance_name: &str) -> Self {
        let class: Vec<u16> = format!("EVERYTHING_TASKBAR_NOTIFICATION_({instance_name})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let instance = unsafe { GetModuleHandleW(ptr::null()) };
        let definition = WindowClass {
            style: 0,
            procedure: Some(procedure),
            class_extra: 0,
            window_extra: 0,
            instance,
            icon: ptr::null_mut(),
            cursor: ptr::null_mut(),
            brush: ptr::null_mut(),
            menu_name: ptr::null(),
            class_name: class.as_ptr(),
        };
        assert_ne!(
            unsafe { RegisterClassW(&definition) },
            0,
            "register unique synthetic IPC class"
        );
        let window = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                0,
                0,
                0,
                0,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            )
        };
        if window.is_null() {
            unsafe { UnregisterClassW(class.as_ptr(), instance) };
            panic!("create hidden synthetic IPC window");
        }
        Self {
            window,
            instance,
            class,
        }
    }
}
impl Drop for HiddenWindow {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.window);
            UnregisterClassW(self.class.as_ptr(), self.instance);
        }
    }
}

#[test]
fn named_instance_finds_real_win32_class_with_underscore_separator() {
    let instance = format!("NimbusDeskIPC 测试-{}", std::process::id());
    let fixture = HiddenWindow::named(&instance);
    let found = IpcWindow::with_instance(Some(&instance))
        .expect("the official named IPC class includes an underscore before '('");
    assert_eq!(found.hwnd().0, fixture.window);
    assert_eq!(
        found.class_name(),
        format!("EVERYTHING_TASKBAR_NOTIFICATION_({instance})")
    );
    assert_eq!(found.instance_name(), Some(instance.as_str()));
}

#[test]
#[ignore = "requires a caller-owned named Everything process; never launches or stops it"]
fn finds_existing_named_everything_instance() {
    let instance = std::env::var("NIMBUS_IPC_VERIFY_INSTANCE")
        .expect("set a caller-owned Everything instance name");
    let found = IpcWindow::with_instance(Some(&instance))
        .expect("caller-owned named Everything should be detected");
    assert_eq!(found.instance_name(), Some(instance.as_str()));
    assert!(!found.hwnd().is_invalid());
}
