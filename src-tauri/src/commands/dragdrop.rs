//! OLE 拖出：把本地路径作为 CF_HDROP 发起真实系统拖拽（可拖进资源管理器/桌面）。
//! 阻塞在 spawn_blocking 线程内直到用户释放/取消。
//! trait 签名对齐 windows 0.62 生成源码（GetData 返回 STGMEDIUM、
//! QueryGetData/Next 返回 HRESULT、GiveFeedback 为安全 fn 等）。

use windows::Win32::Foundation::{
    DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, E_NOTIMPL,
    HGLOBAL, OLE_E_ADVISENOTSUPPORTED, POINT, S_FALSE,
};
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, DVASPECT_CONTENT, FORMATETC, IAdviseSink,
    IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl, IEnumSTATDATA, STGMEDIUM,
    STGMEDIUM_0, TYMED_HGLOBAL,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::{
    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE, DoDragDrop, IDropSource,
    IDropSource_Impl,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::DROPFILES;
use windows::core::{BOOL, Error, HRESULT, Result as WinResult, implement};

const CF_HDROP: u16 = 15;

/* ── IDataObject：只支持 CF_HDROP ─────────────────────── */

#[implement(IDataObject)]
struct HdropData {
    bytes: Vec<u8>,
}

impl IDataObject_Impl for HdropData_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
        let f = unsafe { &*pformatetcin };
        if f.cfFormat != CF_HDROP || (f.tymed & TYMED_HGLOBAL.0 as u32) == 0 {
            return Err(Error::from_hresult(DV_E_FORMATETC));
        }
        unsafe {
            let h = alloc_hglobal(&self.bytes)?;
            Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: h },
                pUnkForRelease: std::mem::ManuallyDrop::new(None),
            })
        }
    }

    fn GetDataHere(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *mut STGMEDIUM,
    ) -> WinResult<()> {
        Err(Error::from_hresult(E_NOTIMPL))
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        let f = unsafe { &*pformatetc };
        if f.cfFormat == CF_HDROP {
            HRESULT(0)
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatectin: *const FORMATETC,
        _pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        DV_E_FORMATETC
    }

    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: BOOL,
    ) -> WinResult<()> {
        Err(Error::from_hresult(E_NOTIMPL))
    }

    fn EnumFormatEtc(&self, _dwdirection: u32) -> WinResult<IEnumFORMATETC> {
        let fmt = FORMATETC {
            cfFormat: CF_HDROP,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
            ptd: std::ptr::null_mut(),
        };
        Ok(FmtEnum {
            items: [fmt],
            pos: std::cell::Cell::new(0),
        }
        .into())
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: windows::core::Ref<'_, IAdviseSink>,
    ) -> WinResult<u32> {
        Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }

    fn DUnadvise(&self, _dwconnection: u32) -> WinResult<()> {
        Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }

    fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
        Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
    }
}

unsafe fn alloc_hglobal(bytes: &[u8]) -> WinResult<HGLOBAL> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(Error::from)?;
        let ptr = GlobalLock(h);
        if ptr.is_null() {
            return Err(Error::from_hresult(DV_E_FORMATETC));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

/* ── IEnumFORMATETC：单格式枚举器 ─────────────────────── */

#[implement(IEnumFORMATETC)]
struct FmtEnum {
    items: [FORMATETC; 1],
    pos: std::cell::Cell<usize>,
}

impl IEnumFORMATETC_Impl for FmtEnum_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
        if celt == 0 {
            return HRESULT(0);
        }
        let pos = self.pos.get();
        let fetched = if pos < self.items.len() && !rgelt.is_null() {
            unsafe { *rgelt = std::ptr::read(&self.items[pos]) };
            self.pos.set(pos + 1);
            1
        } else {
            0
        };
        if !pceltfetched.is_null() {
            unsafe { *pceltfetched = fetched };
        }
        if fetched == 1 { HRESULT(0) } else { S_FALSE }
    }

    fn Skip(&self, celt: u32) -> WinResult<()> {
        let pos = self.pos.get();
        self.pos.set(pos + celt as usize);
        if pos + celt as usize > self.items.len() {
            Err(Error::from_hresult(S_FALSE))
        } else {
            Ok(())
        }
    }

    fn Reset(&self) -> WinResult<()> {
        self.pos.set(0);
        Ok(())
    }

    fn Clone(&self) -> WinResult<IEnumFORMATETC> {
        Ok(FmtEnum {
            items: self.items,
            pos: std::cell::Cell::new(self.pos.get()),
        }
        .into())
    }
}

/* ── IDropSource ──────────────────────────────────────── */

#[implement(IDropSource)]
struct DropSource;

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        // MK_LBUTTON(0x1) / MK_RBUTTON(0x2) 均已释放 → 落下
        if grfkeystate.0 & 0x3 == 0 {
            return DRAGDROP_S_DROP;
        }
        HRESULT(0)
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/* ── 入口 ─────────────────────────────────────────────── */

pub fn do_drag_out(paths: &[String]) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // DROPFILES 头 + 双 \0 结尾的 UTF-16 路径表
        let mut wide: Vec<u16> = paths.iter().flat_map(|p| p.encode_utf16()).collect();
        wide.push(0);
        wide.push(0);
        let header_size = std::mem::size_of::<DROPFILES>();
        let mut bytes = vec![0u8; header_size + wide.len() * 2];
        let df = DROPFILES {
            pFiles: header_size as u32,
            pt: POINT::default(),
            fNC: BOOL(0),
            fWide: BOOL(1),
        };
        bytes[..header_size].copy_from_slice(std::slice::from_raw_parts(
            &df as *const DROPFILES as *const u8,
            header_size,
        ));
        for (i, w) in wide.iter().enumerate() {
            bytes[header_size + i * 2..header_size + i * 2 + 2].copy_from_slice(&w.to_le_bytes());
        }

        let data: IDataObject = HdropData { bytes }.into();
        let source: IDropSource = DropSource.into();
        let mut effect = DROPEFFECT(0);
        let hr = DoDragDrop(
            &data,
            &source,
            DROPEFFECT(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0 | DROPEFFECT_LINK.0),
            &mut effect,
        );
        if hr.is_err() {
            return Err(hr.to_string());
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn drag_out(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || do_drag_out(&paths))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}
