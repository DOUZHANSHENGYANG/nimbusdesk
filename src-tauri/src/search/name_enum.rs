//! A dedicated IPC client for background filename enumeration. It never shares
//! the interactive search client's cancellation state or reply window.
use std::sync::atomic::AtomicBool;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
    pub path: String,
    pub directory: bool,
}
#[derive(Default)]
struct PageOrder {
    previous: Option<Name>,
    seen: std::collections::HashSet<String>,
}
fn constrain_page(names: &mut Vec<Name>, offset: u64, limit: u64) -> bool {
    let remaining=limit.saturating_sub(offset) as usize;
    let truncated=names.len()>remaining;
    names.truncate(remaining);
    truncated
}
impl PageOrder {
    fn check(&mut self, names: &[Name]) -> Result<(), String> {
        for name in names {
            let key = super::file_index::normalize(&name.path);
            if !self.seen.insert(key) {
                return Err("Everything 分页出现重复路径；保留快照并稍后重试".into());
            }
            self.previous = Some(name.clone());
        }
        Ok(())
    }
    fn overlap(&self, name: &Name) -> Result<(), String> {
        if self.previous.as_ref() != Some(name) {
            return Err("Everything 分页边界发生变化；保留快照并稍后重试".into());
        }
        Ok(())
    }
}

pub fn enumerate_scoped(instance:&str,cancel:&AtomicBool,roots:Option<&[String]>,hide_noise:bool,limit:u64,page:impl FnMut(Vec<Name>,u64)->Result<(),String>)->Result<u64,String>{
    if roots.is_some_and(|r|r.is_empty()) { return Ok(0); }
    let expression=super::filters::everything("", roots, hide_noise)?;
    #[cfg(windows)]
    {
        native::enumerate(instance, cancel, &expression, limit, page)
    }
    #[cfg(not(windows))]
    {
        let _ = (instance, cancel, expression, limit, page);
        Err("Everything 文件名索引仅支持 Windows".into())
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use everything_ipc::{
        IpcWindow,
        wm::{EverythingClient, RequestFlags, Sort},
    };
    use std::{
        sync::{Mutex, atomic::Ordering, mpsc::RecvTimeoutError},
        time::{Duration, Instant},
    };

    struct Client {
        handle: usize,
        client: EverythingClient,
        timed_out: bool,
    }
    static CLIENT: Mutex<Option<Client>> = Mutex::new(None);
    const PAGE: u32 = 1000;

    pub(super) fn enumerate(
        instance: &str,
        cancel: &AtomicBool,
        expression: &str,
        limit: u64,
        mut page: impl FnMut(Vec<Name>, u64) -> Result<(), String>,
    ) -> Result<u64, String> {
        if instance.len() > 256 || instance.chars().any(char::is_control) {
            return Err("Everything 实例名称无效".into());
        }
        let (_, ipc, ready, error) = crate::search::everything_app::probe(instance);
        if !ipc {
            return Err(error.unwrap_or_else(|| "Everything IPC 尚不可用；保留文件名快照".into()));
        }
        if ready == Some(false) {
            return Err("Everything 正在建立索引；稍后再枚举文件名".into());
        }
        let window = if instance.trim().is_empty() {
            IpcWindow::new()
        } else {
            IpcWindow::with_instance(Some(instance.trim()))
        }
        .ok_or("Everything 未运行，文件名索引使用所选目录")?;
        let handle = window.hwnd().0 as usize;
        let mut offset = 0;
        let mut expected = None;
        let mut total_changed = false;
        let mut order = PageOrder::default();
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err("文件索引已取消".into());
            }
            let receiver = {
                let mut current = CLIENT.lock().map_err(|_| "文件名 IPC 客户端不可用")?;
                if current.as_ref().is_none_or(|c| c.handle != handle) {
                    *current = Some(Client {
                        handle,
                        client: window.wm_client().map_err(|_| "无法连接文件名 IPC")?,
                        timed_out: false,
                    });
                }
                let current = current.as_ref().unwrap();
                if current.timed_out {
                    return Err("Everything 文件名枚举已超时，重启 Everything 后重试".into());
                }
                current
                    .client
                    .query(expression)
                    .sort(Sort::PathAscending)
                    .request_flags(RequestFlags::FullPathAndFileName | RequestFlags::Attributes)
                    // Re-read the preceding boundary in the same response.
                    // Do not approximate Everything's configurable collation:
                    // it may group folders first and sort numeric names as
                    // 1,10,100 rather than Windows' logical 1,2,10 ordering.
                    .offset(if offset == 0 { 0 } else { offset - 1 })
                    .max_results(if offset == 0 { PAGE } else { PAGE + 1 })
                    .call()
                    .map_err(|_| "文件名 IPC 查询失败")?
            };
            let started = Instant::now();
            let list = loop {
                if cancel.load(Ordering::Acquire) {
                    return Err("文件索引已取消".into());
                }
                if started.elapsed() > Duration::from_secs(2) {
                    if let Ok(mut client) = CLIENT.lock() {
                        if let Some(client) = client.as_mut() {
                            client.timed_out = true;
                        }
                    }
                    return Err("Everything 文件名枚举超时；保留先前快照".into());
                }
                match receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(list) => break list,
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        return Err("Everything 文件名枚举连接中断".into());
                    }
                }
            };
            let total = list.total_len() as u64;
            if expected.is_some_and(|v| v != total) {
                // Changes elsewhere on a live volume must not repeatedly stop
                // progress at the first pages. Still verify each page boundary
                // and never allow a changed scan to trigger snapshot pruning.
                total_changed = true;
            }
            expected = Some(total);
            let mut names: Vec<Name> = list
                .iter()
                .map(|item| {
                    let path = item
                        .get_string(RequestFlags::FullPathAndFileName)
                        .ok_or("Everything 返回了无效路径".to_string())?;
                    let attributes = item.get_u32(RequestFlags::Attributes).unwrap_or_default();
                    let path = super::super::files::indexed_path(path, attributes)
                        .ok_or("Everything 返回了无效路径；保留快照")?;
                    Ok(Name {
                        path,
                        directory: attributes & 0x10 != 0,
                    })
                })
                .collect::<Result<_, String>>()?;
            if offset > 0 {
                let overlap = names.first().ok_or("Everything 分页边界丢失；保留快照")?;
                order.overlap(overlap)?;
                names.remove(0);
            }
            let count = names.len() as u32;
            order.check(&names)?;
            let truncated = constrain_page(&mut names, offset as u64, limit);
            page(names, total)?;
            offset += count;
            if truncated {
                return Err(format!("文件名拼音索引已达 {limit} 条上限；原生 Everything 搜索仍可用"));
            }
            if offset as u64 >= total {
                return if total_changed {
                    Err("Everything 索引在枚举期间发生变化；已保留本次结果，稍后再次对账".into())
                } else {
                    Ok(total)
                };
            }
            if count == 0 {
                return Err("Everything 枚举提前结束；保留快照".into());
            }
            if offset as u64 >= limit {
                return Err(format!(
                    "文件名拼音索引已达 {limit} 条上限；原生 Everything 搜索仍可用"
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn name(path: &str) -> Name {
        Name {
            path: path.into(),
            directory: false,
        }
    }
    #[test]
    fn partial_final_page_cannot_report_complete_or_exceed_limit() {
        let mut names=(0..500).map(|i|name(&format!("C:/data/{i}"))).collect::<Vec<_>>();
        assert!(constrain_page(&mut names,10_000,10_001));
        assert_eq!(names.len(),1);
        assert!(!constrain_page(&mut names,10_000,10_001));
        assert!(constrain_page(&mut names,10_001,10_001));
        assert!(names.is_empty());
    }
    #[test]
    fn duplicate_paths_and_changed_page_boundaries_are_rejected() {
        let mut order = PageOrder::default();
        order
            .check(&[name("C:/docs/a.txt"), name("C:/docs/b.txt")])
            .unwrap();
        assert!(order.check(&[name("C:/docs/b.txt")]).is_err());
        let mut order = PageOrder::default();
        order.check(&[name("C:/docs/b.txt")]).unwrap();
        assert!(order.overlap(&name("C:/docs/a.txt")).is_err());
        assert!(order.overlap(&name("C:/docs/c.txt")).is_err());
        order.overlap(&name("C:/docs/b.txt")).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn actual_everything_lexical_numeric_order_is_valid() {
        let mut order = PageOrder::default();
        order
            .check(&[
                name("C:/docs/素材1.png"),
                name("C:/docs/素材10.png"),
                name("C:/docs/素材100.png"),
                name("C:/docs/素材1000.png"),
                name("C:/docs/素材101.png"),
            ])
            .unwrap();
    }
    #[test]
    fn folders_first_and_alternate_collations_do_not_invalidate_stable_pages() {
        let mut order = PageOrder::default();
        let mut folder = name("C:/docs/z-directory");
        folder.directory = true;
        order.check(&[folder, name("C:/docs/a.txt")]).unwrap();
        order.overlap(&name("C:/docs/a.txt")).unwrap();
        order.check(&[name("C:/docs/b.txt")]).unwrap();
        let mut changed = name("C:/docs/b.txt");
        changed.directory = true;
        assert!(order.overlap(&changed).is_err());
    }
}
