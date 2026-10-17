pub mod selection;
pub mod worker;

#[derive(Clone, serde::Serialize)]
pub struct SelectionSnapshot {
    pub text: String,
    pub source: String,
    pub error: Option<String>,
    pub revision: u64,
}

#[derive(Default)]
struct SelectionState {
    revision: u64,
    snapshot: Option<SelectionSnapshot>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl SelectionState {
    fn begin(&mut self) -> u64 {
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        self.cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.revision = self.revision.saturating_add(1);
        // Pending work has no completed snapshot. Publishing this new revision
        // early could make the frontend discard its eventual completion event.
        self.snapshot = None;
        self.revision
    }
    fn finish(&mut self, revision: u64, result: Result<String, String>) -> bool {
        if revision != self.revision {
            return false;
        }
        let (text, source, error) = match result {
            Ok(text) => {
                let source = if text.is_empty() { "manual" } else { "uia" };
                (text, source.into(), None)
            }
            Err(error) => (String::new(), "manual".into(), Some(error)),
        };
        self.snapshot = Some(SelectionSnapshot {
            text,
            source,
            error,
            revision,
        });
        true
    }
}

fn state() -> &'static std::sync::Mutex<SelectionState> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<SelectionState>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(Default::default)
}

pub fn begin_capture() -> Result<u64, String> {
    Ok(state().lock().map_err(|_| "选区临时状态不可用")?.begin())
}

pub fn finish_capture(revision: u64, result: Result<String, String>) -> Result<bool, String> {
    Ok(state()
        .lock()
        .map_err(|_| "选区临时状态不可用")?
        .finish(revision, result))
}

pub fn snapshot() -> Result<SelectionSnapshot, String> {
    Ok(state()
        .lock()
        .map_err(|_| "选区临时状态不可用")?
        .snapshot
        .clone()
        .unwrap_or(SelectionSnapshot {
            text: String::new(),
            source: "manual".into(),
            error: None,
            revision: 0,
        }))
}

pub fn cancellation(
    revision: u64,
) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>, String> {
    let state = state().lock().map_err(|_| "选区临时状态不可用")?;
    if state.revision == revision {
        Ok(state.cancel.clone())
    } else {
        Ok(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
            true,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::selection::*;

    #[test]
    fn password_selection_is_refused_even_if_provider_returned_text() {
        assert!(validate_selection(vec!["private".into()], true).is_err());
    }

    #[test]
    fn selection_keeps_whitespace_and_rejects_oversize_instead_of_truncating() {
        assert_eq!(
            validate_selection(vec!["  a\n".into()], false).unwrap(),
            "  a\n"
        );
        assert!(validate_selection(vec!["x".repeat(MAX_SELECTION_CHARS + 1)], false).is_err());
        assert!(validate_selection(vec!["".into()], false).is_err());
    }

    #[test]
    fn supplementary_unicode_cannot_hide_provider_truncation_at_utf16_limit() {
        assert!(validate_selection(vec!["😀".repeat(MAX_SELECTION_CHARS / 2 + 1)], false).is_err());
    }

    #[test]
    fn source_identity_requires_both_original_process_and_top_level_window() {
        let target = CaptureTarget {
            hwnd: 10,
            process_id: 23,
        };
        assert!(target.matches(10, 23));
        assert!(!target.matches(11, 23));
        assert!(!target.matches(10, 24));
        assert!(
            !CaptureTarget {
                hwnd: 0,
                process_id: 0
            }
            .matches(0, 0)
        );
    }

    #[test]
    fn older_capture_cannot_overwrite_newer_selection_and_failures_clear_text() {
        let mut state = super::SelectionState::default();
        let old = state.begin();
        let new = state.begin();
        assert!(new > old);
        assert!(state.finish(new, Ok("latest".into())));
        assert!(!state.finish(old, Ok("stale".into())));
        assert_eq!(state.snapshot.as_ref().unwrap().text, "latest");
        let failed = state.begin();
        assert!(state.finish(failed, Err("paste manually".into())));
        assert!(state.snapshot.as_ref().unwrap().text.is_empty());
        assert_eq!(state.snapshot.as_ref().unwrap().source, "manual");
    }

    #[test]
    fn a_new_invocation_cancels_old_worker_before_it_can_publish() {
        let mut state = super::SelectionState::default();
        let old = state.begin();
        let old_cancel = state.cancel.clone();
        let current = state.begin();
        assert!(old_cancel.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.cancel.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.finish(old, Ok("old".into())));
        assert!(state.finish(current, Ok(String::new())));
        assert_eq!(state.snapshot.as_ref().unwrap().source, "manual");
    }

    #[test]
    fn pending_snapshot_cannot_mask_completion_of_the_same_capture() {
        let mut state = super::SelectionState::default();
        let revision = state.begin();
        let pending_revision = state
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.revision)
            .unwrap_or(0);
        assert!(pending_revision < revision);
        assert!(state.finish(revision, Ok("selected text".into())));
        let completed = state.snapshot.as_ref().unwrap();
        assert!(completed.revision > pending_revision);
        assert_eq!(completed.text, "selected text");
    }
}
