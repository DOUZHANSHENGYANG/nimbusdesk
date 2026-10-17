use serde::{Deserialize, Serialize};

pub const MAX_SELECTION_CHARS: usize = 32_768;

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct CaptureTarget {
    pub hwnd: usize,
    pub process_id: u32,
}

impl CaptureTarget {
    pub fn matches(self, hwnd: usize, process_id: u32) -> bool {
        self.hwnd != 0 && self.process_id != 0 && self.hwnd == hwnd && self.process_id == process_id
    }
}

pub fn validate_selection(ranges: Vec<String>, password: bool) -> Result<String, String> {
    if password {
        return Err("密码控件不读取选区，请手动输入需要处理的内容".into());
    }
    if ranges.len() > 16 {
        return Err("选区过多，请缩小选择范围或手动粘贴".into());
    }
    let mut text = String::new();
    for range in ranges {
        if !text.is_empty() && !range.is_empty() {
            text.push('\n');
        }
        text.push_str(&range);
        // UIA GetText counts UTF-16 units; count the same units to detect truncation
        // even when a selection contains supplementary Unicode characters.
        if text.len() > MAX_SELECTION_CHARS * 4 || text.encode_utf16().count() > MAX_SELECTION_CHARS
        {
            return Err("选中文字超过 32768 字，请缩小选区或手动粘贴".into());
        }
    }
    if text.is_empty() {
        return Err("没有可读取的选中文字，请先选择文字或在面板中粘贴".into());
    }
    Ok(text)
}

#[cfg(windows)]
pub fn foreground_target() -> Result<CaptureTarget, String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    let hwnd = unsafe { GetForegroundWindow() };
    let mut process_id = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    let target = CaptureTarget {
        hwnd: hwnd.0 as usize,
        process_id,
    };
    if !target.matches(target.hwnd, target.process_id) {
        return Err("当前窗口不可读取，请在面板中粘贴".into());
    }
    Ok(target)
}

#[cfg(not(windows))]
pub fn foreground_target() -> Result<CaptureTarget, String> {
    Err("当前平台不支持读取选中文字，请在面板中粘贴".into())
}

#[cfg(windows)]
pub fn capture(target: CaptureTarget) -> Result<String, String> {
    use windows::Win32::{
        Foundation::HWND,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize,
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
            },
            WindowsAndMessaging::{GA_ROOT, GetAncestor, GetWindowThreadProcessId},
        },
    };
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
        .map_err(|_| "无法初始化选区读取，请手动粘贴")?;
    let _com = Com;
    let foreground = foreground_target()?;
    if !target.matches(foreground.hwnd, foreground.process_id) {
        return Err("原窗口已切换，请重新选择文字后呼出，或手动粘贴".into());
    }
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|_| "无法启动辅助功能读取，请手动粘贴")?;
    let focused =
        unsafe { automation.GetFocusedElement() }.map_err(|_| "无法读取当前焦点，请手动粘贴")?;
    let walker =
        unsafe { automation.ControlViewWalker() }.map_err(|_| "无法验证选区来源，请手动粘贴")?;
    let mut element = focused;
    let mut pattern = None;
    let mut verified = false;
    // Walk only the focused element's ancestry. Never scan documents or other controls.
    for _ in 0..64 {
        let password = unsafe { element.CurrentIsPassword() }
            .map_err(|_| "无法确认控件隐私状态，已停止读取，请手动粘贴")?;
        if password.as_bool() {
            return validate_selection(Vec::new(), true);
        }
        if pattern.is_none() {
            pattern = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            }
            .ok();
        }
        let hwnd = unsafe { element.CurrentNativeWindowHandle() }
            .map_err(|_| "无法验证选区窗口，请手动粘贴")?;
        if !hwnd.0.is_null() {
            let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
            let mut process_id = 0;
            unsafe {
                GetWindowThreadProcessId(root, Some(&mut process_id));
            }
            if !target.matches(root.0 as usize, process_id) {
                return Err("焦点不属于原窗口，已停止读取，请手动粘贴".into());
            }
            if hwnd == HWND(target.hwnd as *mut _) {
                verified = true;
                break;
            }
        }
        element = match unsafe { walker.GetParentElement(&element) } {
            Ok(parent) => parent,
            Err(_) => break,
        };
    }
    if !verified {
        return Err("无法验证选区来源，已停止读取，请手动粘贴".into());
    }
    let foreground = foreground_target()?;
    if !target.matches(foreground.hwnd, foreground.process_id) {
        return Err("原窗口已切换，请重新呼出或手动粘贴".into());
    }
    let pattern = pattern.ok_or("此应用未提供可读取的选区，请使用面板粘贴或手动输入")?;
    let ranges = unsafe { pattern.GetSelection() }.map_err(|_| "此应用无法返回选区，请手动粘贴")?;
    let count = unsafe { ranges.Length() }.map_err(|_| "选区状态不可用，请手动粘贴")?;
    if !(0..=16).contains(&count) {
        return Err("选区过多或状态无效，请手动粘贴".into());
    }
    let mut text = Vec::new();
    for index in 0..count {
        let range = unsafe { ranges.GetElement(index) }.map_err(|_| "无法读取选区，请手动粘贴")?;
        // The limit is never -1: providers may only return selected ranges, bounded per range.
        text.push(
            unsafe { range.GetText(MAX_SELECTION_CHARS as i32 + 1) }
                .map_err(|_| "此应用不支持读取选中文字，请手动粘贴")?
                .to_string(),
        );
    }
    validate_selection(text, false)
}

#[cfg(not(windows))]
pub fn capture(_target: CaptureTarget) -> Result<String, String> {
    Err("当前平台不支持读取选中文字，请在面板中粘贴".into())
}
