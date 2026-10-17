use super::*;
use base64::Engine;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);

fn organize_input(root: &str, path: &str, kind: &str) -> OrganizeInput {
    OrganizeInput {
        sources: vec![OrganizeSource {
            path: path.into(),
            fingerprint: read(root, path).unwrap().fingerprint,
        }],
        title: "整理后的标题".into(),
        kind: kind.into(),
        content: "## 方法\n\n![[assets/images/example.png]]\n\n[附件](./附件.txt)".into(),
        tags: vec!["整理".into()],
    }
}

#[test]
fn source_organization_moves_once_preserves_metadata_and_retries_without_copies() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("08-收件箱")).unwrap();
    let original = "---\nauthor: someone\ntags: [old]\ncustom:\n  enabled: true\n---\n\n# 原始标题\n\noriginal";
    fs::write(vault.0.join("08-收件箱/原始.md"), original).unwrap();
    let request = organize_input(&vault.root(), "08-收件箱/原始.md", "resource");
    let saved = organize_with_folders(&vault.root(), request.clone(), &KnowledgeFolders::default())
        .unwrap();
    assert_eq!(saved.path, "04-资源收藏/原始.md");
    assert!(saved.organized);
    assert!(!vault.0.join("08-收件箱/原始.md").exists());
    let text = read(&vault.root(), &saved.path).unwrap().content;
    assert!(text.contains("author: someone\n"));
    assert!(text.contains("custom:\n  enabled: true"));
    assert!(text.contains("![[assets/images/example.png]]"));
    assert!(text.contains("[附件](../08-收件箱/附件.txt)"));
    assert_eq!(
        organize_with_folders(&vault.root(), request, &KnowledgeFolders::default())
            .unwrap()
            .path,
        saved.path
    );
    assert_eq!(scan(&vault.root()).unwrap().len(), 1);
    assert!(scan(&vault.root()).unwrap()[0].organized);
    let journal = fs::read_dir(vault.0.join(".workbench/organization"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        fs::read_to_string(journal.join("source-0.bak")).unwrap(),
        original
    );
    fs::write(vault.0.join(&saved.path), format!("{text}\nexternal edit")).unwrap();
    assert!(!scan(&vault.root()).unwrap()[0].organized);
}

#[test]
fn source_organization_never_overwrites_conflicts_or_external_edits() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("08-收件箱")).unwrap();
    fs::create_dir_all(vault.0.join("04-资源收藏")).unwrap();
    fs::write(vault.0.join("08-收件箱/原始.md"), "# original").unwrap();
    let request = organize_input(&vault.root(), "08-收件箱/原始.md", "resource");
    fs::write(vault.0.join("04-资源收藏/原始.md"), "# other note").unwrap();
    assert!(
        organize_with_folders(&vault.root(), request.clone(), &KnowledgeFolders::default())
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(vault.0.join("04-资源收藏/原始.md")).unwrap(),
        "# other note"
    );
    fs::remove_file(vault.0.join("04-资源收藏/原始.md")).unwrap();
    fs::write(vault.0.join("08-收件箱/原始.md"), "# external edit").unwrap();
    assert!(organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).is_err());
    assert_eq!(scan(&vault.root()).unwrap().len(), 1);
}

#[test]
fn source_organization_updates_in_place_and_capture_metadata_tracks_canonical_note() {
    let vault = Vault::new();
    let captured = capture(&vault.root(), input("source-organize")).unwrap();
    let request = organize_input(&vault.root(), &captured.note_path, "recipe");
    let saved =
        organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).unwrap();
    let record = captures(&vault.root()).unwrap().remove(0);
    assert_eq!(record.status, "archived");
    assert_eq!(record.note_path, saved.path);
    let mut next = organize_input(&vault.root(), &saved.path, "recipe");
    next.content = "updated".into();
    assert_eq!(
        organize_with_folders(&vault.root(), next, &KnowledgeFolders::default())
            .unwrap()
            .path,
        saved.path
    );
    assert_eq!(scan(&vault.root()).unwrap().len(), 1);
    assert!(
        read(&vault.root(), &saved.path)
            .unwrap()
            .content
            .contains("updated")
    );
}

#[test]
fn source_organization_preserves_original_embeds_and_independent_notes() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("08-收件箱/sub")).unwrap();
    fs::write(
        vault.0.join("08-收件箱/sub/first.md"),
        "# first\n![[assets/images/one.png]]\n![[../images/two.png|preview]]",
    )
    .unwrap();
    fs::write(vault.0.join("08-收件箱/sub/second.md"), "# second").unwrap();
    let mut request = organize_input(&vault.root(), "08-收件箱/sub/first.md", "resource");
    request.content = "# 整理后的标题\n\ncleaned".into();
    let saved =
        organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).unwrap();
    let content = read(&vault.root(), &saved.path).unwrap().content;
    assert_eq!(content.matches("# 整理后的标题").count(), 1);
    assert!(content.contains("![[assets/images/one.png]]"));
    assert!(content.contains("![[08-收件箱/images/two.png|preview]]"));
    let next = organize_input(&vault.root(), "08-收件箱/sub/second.md", "resource");
    organize_with_folders(&vault.root(), next, &KnowledgeFolders::default()).unwrap();
    assert_eq!(scan(&vault.root()).unwrap().len(), 2);
}

#[test]
fn source_organization_recovers_after_output_publish_and_capture_metadata_failure() {
    let vault = Vault::new();
    let captured = capture(&vault.root(), input("recover-organize")).unwrap();
    let request = organize_input(&vault.root(), &captured.note_path, "recipe");
    let blocker = vault
        .0
        .join("08-收件箱/工作台/recover-organize/条目.json.tmp");
    fs::create_dir(&blocker).unwrap();
    assert!(
        organize_with_folders(&vault.root(), request.clone(), &KnowledgeFolders::default())
            .is_err()
    );
    assert!(!vault.0.join(&captured.note_path).exists());
    fs::remove_dir(blocker).unwrap();
    let records = captures(&vault.root()).unwrap();
    assert_eq!(records[0].status, "archived");
    let result =
        organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).unwrap();
    assert_eq!(records[0].note_path, result.path);
    assert_eq!(scan(&vault.root()).unwrap().len(), 1);
}

#[test]
fn source_organization_does_not_rewrite_or_collect_links_inside_code() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("08-收件箱")).unwrap();
    let code = "```md\n[code](./keep.txt)\n![[../code.png]]\n```\n\n`[inline](./keep.txt)`";
    fs::write(vault.0.join("08-收件箱/code.md"), format!("# code\n{code}")).unwrap();
    let mut request = organize_input(&vault.root(), "08-收件箱/code.md", "resource");
    request.content = code.into();
    let result =
        organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).unwrap();
    let content = read(&vault.root(), &result.path).unwrap().content;
    assert!(content.contains(code));
    assert!(!content.contains("## 附件与引用"));
}

#[test]
fn source_organization_preserves_quoted_yaml_keys_tags_and_comments() {
    for metadata in [
        "tags: [old] # keep tag\ntype: note",
        "'tags': ['old, comma', old] # comment\n\"type\": note",
        "\"tags\": [\"old, comma\", \"escaped \\\"tag\\\"\"]\ncustom:\n  tags: nested",
        "'tags':\n  - 'old, comma' # comment\n  - old\nother: value",
    ] {
        let vault = Vault::new();
        fs::create_dir_all(vault.0.join("08-收件箱")).unwrap();
        fs::write(
            vault.0.join("08-收件箱/tags.md"),
            format!("---\n{metadata}\n---\n# source"),
        )
        .unwrap();
        let request = organize_input(&vault.root(), "08-收件箱/tags.md", "resource");
        let result =
            organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).unwrap();
        let content = read(&vault.root(), &result.path).unwrap().content;
        let tags_line = content
            .lines()
            .find_map(|line| line.strip_prefix("tags: "))
            .unwrap();
        let tags: Vec<String> = serde_json::from_str(tags_line).unwrap();
        assert!(tags.contains(&"整理".into()));
        assert!(
            !tags
                .iter()
                .any(|tag| tag.contains("# comment") || tag.contains("# keep tag"))
        );
        if metadata.contains("old, comma") {
            assert!(tags.contains(&"old, comma".into()));
        }
        assert!(!content.contains("'tags':"));
        assert!(!content.contains("\"tags\":"));
        assert_eq!(
            content
                .lines()
                .filter(|line| line.starts_with("type:"))
                .count(),
            1
        );
    }
}

#[test]
fn source_organization_rejects_unsupported_yaml_and_multiple_sources_before_writing() {
    for metadata in [
        "tags: &mytags [old]\nother: *mytags",
        "tags: [{nested: tag}]",
        "tags: [old]\n' tags ': other\n\"tags\": [second]",
    ] {
        let vault = Vault::new();
        fs::create_dir_all(vault.0.join("08-收件箱")).unwrap();
        let original = format!("---\n{metadata}\n---\n# source");
        fs::write(vault.0.join("08-收件箱/tags.md"), &original).unwrap();
        let request = organize_input(&vault.root(), "08-收件箱/tags.md", "resource");
        assert!(
            organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).is_err()
        );
        assert_eq!(
            read(&vault.root(), "08-收件箱/tags.md").unwrap().content,
            original
        );
        assert!(!vault.0.join(".workbench").exists());
    }
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("08-收件箱")).unwrap();
    fs::write(vault.0.join("08-收件箱/a.md"), "# a").unwrap();
    fs::write(vault.0.join("08-收件箱/b.md"), "# b").unwrap();
    let mut request = organize_input(&vault.root(), "08-收件箱/a.md", "resource");
    request
        .sources
        .extend(organize_input(&vault.root(), "08-收件箱/b.md", "resource").sources);
    assert!(organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).is_err());
    assert!(!vault.0.join(".workbench").exists());
    assert_eq!(scan(&vault.root()).unwrap().len(), 2);
}

#[test]
fn source_organization_rebases_angle_space_and_title_destinations_or_rejects_ambiguity() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("08-收件箱")).unwrap();
    fs::write(vault.0.join("08-收件箱/links.md"), "# source").unwrap();
    let mut request = organize_input(&vault.root(), "08-收件箱/links.md", "resource");
    request.content = "![one](<./my image.png> \"caption text\")\n[two](./readme.md \"title text\")\n[web](https://example.com \"title text\")".into();
    let result =
        organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).unwrap();
    let content = read(&vault.root(), &result.path).unwrap().content;
    assert!(content.contains("![one](<../08-收件箱/my image.png> \"caption text\")"));
    assert!(content.contains("[two](../08-收件箱/readme.md \"title text\")"));
    assert!(content.contains("[web](https://example.com \"title text\")"));
    fs::write(vault.0.join("08-收件箱/ambiguous.md"), "# source").unwrap();
    let mut request = organize_input(&vault.root(), "08-收件箱/ambiguous.md", "resource");
    request.content = "[ambiguous](./my image.png)".into();
    assert!(organize_with_folders(&vault.root(), request, &KnowledgeFolders::default()).is_err());
    assert!(vault.0.join("08-收件箱/ambiguous.md").exists());
    assert!(!vault.0.join("04-资源收藏/ambiguous.md").exists());
}
struct Vault(PathBuf);
impl Vault {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "nimbus-knowledge-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join(".obsidian")).unwrap();
        Self(path)
    }
    fn root(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}
impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn input(id: &str) -> CaptureInput {
    CaptureInput {
        id: id.into(),
        title: "端口排查".into(),
        content: "查找占用端口的进程".into(),
        project: "测试项目".into(),
        source: "https://example.com".into(),
        attachments: vec![],
    }
}
fn png() -> String {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[255, 0, 0, 255]).unwrap();
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
fn archive_input(root: &str, ids: &[&str], kind: &str) -> ArchiveInput {
    ArchiveInput {
        ids: ids.iter().map(|id| id.to_string()).collect(),
        title: "端口处理经验".into(),
        kind: kind.into(),
        content: "## 处理方法\n验证有效".into(),
        tags: vec!["开发".into()],
        fingerprints: ids
            .iter()
            .map(|id| {
                (
                    id.to_string(),
                    read(root, &format!("08-收件箱/工作台/{id}/条目.md"))
                        .unwrap()
                        .fingerprint,
                )
            })
            .collect(),
    }
}
#[test]
fn managed_scope_excludes_unbound_work_and_technology_notes() {
    let vault = Vault::new();
    for folder in [
        "01-技术",
        "02-工作/开发经验",
        "02-工作/开发配方",
        "04-资源收藏",
        "08-收件箱",
    ] {
        fs::create_dir_all(vault.0.join(folder)).unwrap();
        fs::write(vault.0.join(folder).join("笔记.md"), "# 范围测试\nneedle").unwrap();
    }
    fs::write(vault.0.join("02-工作/私人项目.md"), "# 私人\nneedle").unwrap();
    let notes = scan(&vault.root()).unwrap();
    assert_eq!(
        notes.len(),
        4,
        "only three bound categories and inbox belong to workbench"
    );
    assert!(notes.iter().all(|note| note.kind != "note"));
    assert_eq!(search(&vault.root(), "needle").unwrap().len(), 4);
}

fn custom_folders() -> KnowledgeFolders {
    KnowledgeFolders {
        experience: "我的文档/排错".into(),
        recipe: "我的文档/操作配方".into(),
        resource: "收藏/工具资料".into(),
    }
}
#[test]
fn custom_bindings_control_scan_search_and_kind() {
    let vault = Vault::new();
    let folders = custom_folders();
    for folder in [
        &folders.experience,
        &folders.recipe,
        &folders.resource,
        "02-工作/开发经验",
        "08-收件箱",
    ] {
        fs::create_dir_all(vault.0.join(folder)).unwrap();
        fs::write(
            vault.0.join(folder).join("笔记.md"),
            "# 自定义\ncustom needle",
        )
        .unwrap();
    }
    let notes = scan_with_folders(&vault.root(), &folders).unwrap();
    assert_eq!(notes.len(), 4);
    for (folder, kind) in [
        (&folders.experience, "experience"),
        (&folders.recipe, "recipe"),
        (&folders.resource, "resource"),
    ] {
        assert_eq!(
            notes
                .iter()
                .find(|note| note.path.starts_with(folder))
                .unwrap()
                .kind,
            kind
        );
    }
    assert_eq!(
        search_with_folders(&vault.root(), "custom needle", &folders)
            .unwrap()
            .len(),
        4
    );
}
#[test]
fn custom_archive_remains_readable_and_retryable_after_binding_changes() {
    let vault = Vault::new();
    let folders = custom_folders();
    capture(&vault.root(), input("custom-archive")).unwrap();
    let request = archive_input(&vault.root(), &["custom-archive"], "recipe");
    let saved = archive_with_folders(&vault.root(), request.clone(), &folders).unwrap();
    assert!(saved.path.starts_with(&format!("{}/", folders.recipe)));
    assert_eq!(saved.kind, "recipe");
    assert_eq!(
        captures(&vault.root()).unwrap()[0].archived_path.as_ref(),
        Some(&saved.path)
    );
    let changed = KnowledgeFolders::default();
    assert_eq!(
        archive_with_folders(&vault.root(), request, &changed)
            .unwrap()
            .path,
        saved.path
    );
    assert!(
        scan_with_folders(&vault.root(), &changed)
            .unwrap()
            .iter()
            .all(|note| note.path != saved.path)
    );
    assert!(read(&vault.root(), &saved.path).is_ok());
}
#[test]
fn custom_archive_recovers_old_target_after_binding_changes() {
    let vault = Vault::new();
    capture(&vault.root(), input("custom-recover")).unwrap();
    let request = archive_input(&vault.root(), &["custom-recover"], "experience");
    let blocker = vault
        .0
        .join("08-收件箱/工作台/custom-recover/条目.json.tmp");
    fs::create_dir(&blocker).unwrap();
    assert!(archive_with_folders(&vault.root(), request.clone(), &custom_folders()).is_err());
    fs::remove_dir(blocker).unwrap();
    let saved = archive_with_folders(&vault.root(), request, &KnowledgeFolders::default()).unwrap();
    assert!(saved.path.starts_with("我的文档/排错/"));
    assert_eq!(captures(&vault.root()).unwrap()[0].status, "archived");
}
#[test]
fn folder_validation_normalizes_without_creating_or_moving_files() {
    let vault = Vault::new();
    let mut folders = custom_folders();
    folders.experience = " 我的文档\\排错/ ".into();
    let normalized = validate_folders(&vault.root(), folders).unwrap();
    assert_eq!(normalized.experience, "我的文档/排错");
    assert!(!vault.0.join("我的文档").exists());
    let mut ordinary = custom_folders();
    ordinary.experience = format!("资料 [2026] #合集/{}", "长".repeat(80));
    assert!(validate_folders(&vault.root(), ordinary).is_ok());
    for path in [
        "",
        ".",
        "../escape",
        "C:/escape",
        "/absolute",
        "a//b",
        "a/./b",
        "a/../b",
        "a/.secret",
        "assets",
        "assets/images",
        "08-收件箱",
        "08-收件箱/其他",
        ".obsidian",
        "safe/CON",
        "safe/AUX.md",
        "safe/bad?name",
        "safe/trailing.",
        "safe/trailing /child",
    ] {
        let mut bad = custom_folders();
        bad.experience = path.into();
        assert!(
            validate_folders(&vault.root(), bad).is_err(),
            "accepted {path:?}"
        );
    }
    for path in ["我的文档", "我的文档/操作配方", "我的文档/操作配方/子目录"]
    {
        let mut bad = custom_folders();
        bad.experience = path.into();
        assert!(
            validate_folders(&vault.root(), bad).is_err(),
            "accepted overlapping {path}"
        );
    }
    fs::write(vault.0.join("existing-file"), "original").unwrap();
    let mut bad = custom_folders();
    bad.experience = "existing-file/child".into();
    assert!(validate_folders(&vault.root(), bad).is_err());
    assert_eq!(
        fs::read_to_string(vault.0.join("existing-file")).unwrap(),
        "original"
    );
}

#[test]
fn folder_validation_rejects_links_and_hidden_existing_parents() {
    let vault = Vault::new();
    let outside = Vault::new();
    let link = vault.0.join("linked");
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(outside.0.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(output.status.success(), "junction creation failed");
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(&outside.0, &link).unwrap();
    let mut folders = custom_folders();
    folders.experience = "linked/child".into();
    let result = validate_folders(&vault.root(), folders);
    #[cfg(windows)]
    fs::remove_dir(&link).unwrap();
    #[cfg(not(windows))]
    fs::remove_file(&link).unwrap();
    assert!(result.unwrap_err().contains("链接"));
    assert!(!outside.0.join("child").exists());
    #[cfg(windows)]
    {
        fs::create_dir(vault.0.join("hidden")).unwrap();
        let output = std::process::Command::new("attrib")
            .arg("+H")
            .arg(vault.0.join("hidden"))
            .output()
            .unwrap();
        assert!(output.status.success());
        let mut folders = custom_folders();
        folders.experience = "hidden/child".into();
        assert!(
            validate_folders(&vault.root(), folders)
                .unwrap_err()
                .contains("可见")
        );
    }
}
#[test]
fn capture_owns_image_and_markdown_without_body_in_metadata() {
    let vault = Vault::new();
    let mut item = input("capture-1");
    item.attachments.push(AttachmentInput {
        name: "端口截图.png".into(),
        mime: "image/png".into(),
        data_base64: png(),
    });
    let saved = capture(&vault.root(), item).unwrap();
    assert_eq!(saved.note_path, "08-收件箱/工作台/capture-1/条目.md");
    assert!(
        saved.attachments[0]
            .path
            .starts_with("assets/images/工作台/capture-1/端口截图-")
    );
    let note = read(&vault.root(), &saved.note_path).unwrap();
    assert!(
        note.content
            .contains(&format!("![[{}]]", saved.attachments[0].path))
    );
    assert!(note.content.contains("type: inbox"));
    let metadata =
        fs::read_to_string(vault.0.join("08-收件箱/工作台/capture-1/条目.json")).unwrap();
    assert!(!metadata.contains("查找占用端口的进程"));
    assert!(
        image(&vault.root(), &saved.attachments[0].path)
            .unwrap()
            .starts_with("data:image/png;base64,")
    );
}
#[test]
fn archive_preserves_originals_and_maps_user_directories() {
    let vault = Vault::new();
    for (i, kind, folder) in [
        (1, "experience", "02-工作/开发经验"),
        (2, "recipe", "02-工作/开发配方"),
        (3, "resource", "04-资源收藏"),
    ] {
        let id = format!("item-{i}");
        let mut source = input(&id);
        source.attachments.push(AttachmentInput {
            name: "日志".into(),
            mime: "image/png".into(),
            data_base64: png(),
        });
        let saved = capture(&vault.root(), source).unwrap();
        let before = read(&vault.root(), &saved.note_path).unwrap();
        let request = archive_input(&vault.root(), &[&id], kind);
        let archived = archive(&vault.root(), request.clone()).unwrap();
        assert!(archived.path.starts_with(folder));
        let body = read(&vault.root(), &archived.path).unwrap().content;
        assert!(body.contains(&format!("[[{}]]", saved.note_path.trim_end_matches(".md"))));
        assert!(body.contains(&format!("![[{}]]", saved.attachments[0].path)));
        assert_eq!(
            read(&vault.root(), &saved.note_path).unwrap().content,
            before.content
        );
        assert_eq!(archive(&vault.root(), request).unwrap().path, archived.path);
    }
    assert!(
        captures(&vault.root())
            .unwrap()
            .iter()
            .all(|item| item.status == "archived")
    );
}
#[test]
fn rejects_path_escape_and_invalid_vault() {
    let vault = Vault::new();
    for path in [
        "../outside.md",
        "C:/outside.md",
        "/outside.md",
        "a/../../outside.md",
        "..\\outside.md",
    ] {
        assert!(read(&vault.root(), path).is_err(), "accepted {path}");
    }
    let mut item = input("../bad");
    assert!(capture(&vault.root(), item.clone()).is_err());
    item.id = "safe".into();
    fs::remove_dir(vault.0.join(".obsidian")).unwrap();
    assert!(bind(&vault.root()).is_err());
    assert!(capture(&vault.root(), item).is_err());
}
#[test]
fn rejects_mismatched_image_and_existing_capture_without_overwrite() {
    let vault = Vault::new();
    let item = input("same-id");
    let saved = capture(&vault.root(), item.clone()).unwrap();
    assert_eq!(
        capture(&vault.root(), item).unwrap().note_path,
        saved.note_path
    );
    let mut changed = input("same-id");
    changed.content = "changed".into();
    assert!(capture(&vault.root(), changed).is_err());
    assert!(
        read(&vault.root(), &saved.note_path)
            .unwrap()
            .content
            .contains("查找占用")
    );
    let mut bad = input("bad-image");
    bad.attachments.push(AttachmentInput {
        name: "bad.png".into(),
        mime: "image/png".into(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(b"<html>not an image</html>"),
    });
    assert!(capture(&vault.root(), bad).is_err());
    assert!(
        !vault
            .0
            .join("08-收件箱/工作台/bad-image/条目.json")
            .exists()
    );
}
#[test]
fn external_edits_conflict_before_archive_and_bad_metadata_is_visible() {
    let vault = Vault::new();
    let saved = capture(&vault.root(), input("conflict")).unwrap();
    let request = archive_input(&vault.root(), &["conflict"], "experience");
    fs::write(vault.0.join(&saved.note_path), "external edit").unwrap();
    assert!(archive(&vault.root(), request).is_err());
    assert!(!vault.0.join("02-工作/开发经验").exists());
    fs::write(
        vault.0.join("08-收件箱/工作台/conflict/条目.json"),
        "bad json",
    )
    .unwrap();
    assert!(captures(&vault.root()).is_err());
}
#[test]
fn scanning_limits_scope_and_reports_failures() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("02-工作/开发经验/skills")).unwrap();
    fs::create_dir_all(vault.0.join("02-工作/开发经验/.hidden")).unwrap();
    fs::create_dir_all(vault.0.join("private")).unwrap();
    for path in [
        "02-工作/开发经验/skills/skip.md",
        "02-工作/开发经验/.hidden/skip.md",
        "private/skip.md",
        "02-工作/开发经验/经验.md",
    ] {
        fs::write(vault.0.join(path), "# 标题\n正文").unwrap();
    }
    let notes = scan(&vault.root()).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].title, "标题");
    fs::write(vault.0.join("02-工作/开发经验/broken.md"), [0xff, 0xff]).unwrap();
    assert!(scan(&vault.root()).is_err());
}

#[test]
fn archive_recovers_status_after_target_was_written() {
    let vault = Vault::new();
    let saved = capture(&vault.root(), input("recover")).unwrap();
    let original = read(&vault.root(), &saved.note_path).unwrap().content;
    let request = archive_input(&vault.root(), &["recover"], "experience");
    let blocker = vault.0.join("08-收件箱/工作台/recover/条目.json.tmp");
    fs::create_dir(&blocker).unwrap();
    assert!(archive(&vault.root(), request.clone()).is_err());
    assert_eq!(
        read(&vault.root(), &saved.note_path).unwrap().content,
        original
    );
    assert_eq!(
        fs::read_dir(vault.0.join("02-工作/开发经验"))
            .unwrap()
            .filter(|e| e
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "md"))
            .count(),
        1
    );
    fs::remove_dir(&blocker).unwrap();
    let recovered = captures(&vault.root()).unwrap();
    assert_eq!(recovered[0].status, "archived");
    let result = archive(&vault.root(), request).unwrap();
    assert_eq!(Some(&result.path), recovered[0].archived_path.as_ref());
}

#[test]
fn capture_retry_preserves_staged_material_after_image_publish_failure() {
    let vault = Vault::new();
    fs::create_dir(vault.0.join("assets")).unwrap();
    fs::write(vault.0.join("assets/images"), "block directory creation").unwrap();
    let mut request = input("retry-images");
    request.attachments.push(AttachmentInput {
        name: "截图".into(),
        mime: "image/png".into(),
        data_base64: png(),
    });
    assert!(capture(&vault.root(), request.clone()).is_err());
    assert!(
        vault
            .0
            .join("08-收件箱/工作台/.staging-retry-images/条目.md")
            .exists()
    );
    assert!(captures(&vault.root()).unwrap().is_empty());
    fs::remove_file(vault.0.join("assets/images")).unwrap();
    let saved = capture(&vault.root(), request).unwrap();
    assert!(vault.0.join(&saved.note_path).exists());
    assert!(image(&vault.root(), &saved.attachments[0].path).is_ok());
}

#[test]
fn rejects_oversized_image_and_disallowed_content_type() {
    let vault = Vault::new();
    let mut request = input("bad-mime");
    request.attachments.push(AttachmentInput {
        name: "image.svg".into(),
        mime: "image/svg+xml".into(),
        data_base64: png(),
    });
    assert!(capture(&vault.root(), request.clone()).is_err());
    request.id = "too-large".into();
    request.attachments[0].mime = "image/png".into();
    request.attachments[0].data_base64 = "A".repeat(28 * 1024 * 1024);
    assert!(capture(&vault.root(), request).is_err());
    assert!(!vault.0.join("08-收件箱").exists());
}

#[test]
fn refuses_junction_or_symlink_escape() {
    let vault = Vault::new();
    let outside = Vault::new();
    fs::write(outside.0.join("secret.md"), "outside vault").unwrap();
    fs::create_dir_all(vault.0.join("02-工作/开发经验")).unwrap();
    fs::write(vault.0.join("02-工作/开发经验/正常笔记.md"), "# 正常笔记").unwrap();
    let link = vault.0.join("02-工作/开发经验/linked");
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(outside.0.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "junction creation failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(&outside.0, &link).unwrap();
    assert!(read(&vault.root(), "02-工作/开发经验/linked/secret.md").is_err());
    assert!(
        update(
            &vault.root(),
            UpdateNoteInput {
                path: "02-工作/开发经验/linked/secret.md".into(),
                content: "must stay inside".into(),
                fingerprint: read(&outside.root(), "secret.md").unwrap().fingerprint,
            }
        )
        .is_err()
    );
    // A discovered link must not hide all the ordinary notes in the vault.
    let notes = scan(&vault.root()).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].path, "02-工作/开发经验/正常笔记.md");
    assert!(search(&vault.root(), "outside vault").unwrap().is_empty());
    #[cfg(windows)]
    fs::remove_dir(&link).unwrap();
    #[cfg(not(windows))]
    fs::remove_file(&link).unwrap();
    assert_eq!(
        fs::read_to_string(outside.0.join("secret.md")).unwrap(),
        "outside vault"
    );
}

#[test]
fn full_text_search_matches_after_preview_and_binding_is_shell_usable() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("02-工作/开发经验")).unwrap();
    fs::write(
        vault.0.join("02-工作/开发经验/普通标题.md"),
        format!(
            "# 普通标题\n{}\nVeryUniqueSearchTerm",
            "前置正文".repeat(150)
        ),
    )
    .unwrap();
    let notes = search(&vault.root(), "veryuniquesearchterm").unwrap();
    assert_eq!(notes.len(), 1);
    assert!(!notes[0].preview.contains("VeryUniqueSearchTerm"));
    assert!(search(&vault.root(), "missing-term").unwrap().is_empty());
    assert!(!bind(&vault.root()).unwrap().root.starts_with("\\\\?\\"));
}

#[test]
fn capture_recovers_missing_or_partial_metadata_without_discarding_material() {
    for partial in [false, true] {
        let vault = Vault::new();
        let stage = vault.0.join("08-收件箱/工作台/.staging-incomplete");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("条目.md"), "previous partial material").unwrap();
        if partial {
            fs::write(stage.join("条目.json"), "{broken").unwrap();
        }
        let saved = capture(&vault.root(), input("incomplete")).unwrap();
        assert!(
            read(&vault.root(), &saved.note_path)
                .unwrap()
                .content
                .contains("查找占用")
        );
        let preserved: Vec<_> = fs::read_dir(vault.0.join("08-收件箱/工作台"))
            .unwrap()
            .filter_map(|entry| {
                let entry = entry.unwrap();
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".recovery-incomplete-")
                    .then_some(entry.path())
            })
            .collect();
        assert_eq!(preserved.len(), 1);
        assert_eq!(
            fs::read_to_string(preserved[0].join("条目.md")).unwrap(),
            "previous partial material"
        );
    }
}

#[test]
fn archive_recovers_complete_staged_target_without_published_target() {
    let vault = Vault::new();
    capture(&vault.root(), input("recover-stage")).unwrap();
    let request = archive_input(&vault.root(), &["recover-stage"], "experience");
    let blocker = vault.0.join("08-收件箱/工作台/recover-stage/条目.json.tmp");
    fs::create_dir(&blocker).unwrap();
    assert!(archive(&vault.root(), request.clone()).is_err());
    let journal_path = fs::read_dir(vault.0.join("08-收件箱/工作台/.transactions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let journal: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(journal_path).unwrap()).unwrap();
    let target = journal["target"].as_str().unwrap();
    let staged = journal["stagedTarget"]
        .as_str()
        .expect("journal identifies staged archive target");
    fs::rename(vault.0.join(target), vault.0.join(staged)).unwrap();
    fs::remove_dir(blocker).unwrap();
    let result = archive(&vault.root(), request).unwrap();
    assert_eq!(result.path, target);
    assert!(!vault.0.join(staged).exists());
    assert_eq!(captures(&vault.root()).unwrap()[0].status, "archived");
}

#[test]
fn capture_recovers_half_written_body_with_complete_request_journal() {
    let vault = Vault::new();
    let request = input("half-body");
    let saved = capture(&vault.root(), request.clone()).unwrap();
    let stage = vault.0.join("08-收件箱/工作台/.staging-half-body");
    fs::rename(vault.0.join("08-收件箱/工作台/half-body"), &stage).unwrap();
    fs::write(stage.join("条目.md"), "---\ntype: inbox\npartial").unwrap();
    let retry = capture(&vault.root(), request).unwrap();
    assert_eq!(saved.created_at, retry.created_at);
    assert!(
        read(&vault.root(), &retry.note_path)
            .unwrap()
            .content
            .contains("查找占用端口")
    );
    let recovery = fs::read_dir(vault.0.join("08-收件箱/工作台"))
        .unwrap()
        .find(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".recovery-half-body-")
        })
        .unwrap()
        .unwrap()
        .path();
    assert!(
        fs::read_to_string(recovery.join("条目.md"))
            .unwrap()
            .contains("partial")
    );
}

#[test]
fn archive_escapes_windows_device_names_before_first_dot() {
    let vault = Vault::new();
    for (index, title) in ["CON.txt", "aux.log", "LPT1.notes", "com9.config"]
        .iter()
        .enumerate()
    {
        let id = format!("device-{index}");
        capture(&vault.root(), input(&id)).unwrap();
        let mut request = archive_input(&vault.root(), &[&id], "experience");
        request.title = (*title).into();
        let result = archive(&vault.root(), request).unwrap();
        assert!(
            result
                .path
                .starts_with(&format!("02-工作/开发经验/_{title}-"))
        );
        assert!(read(&vault.root(), &result.path).is_ok());
    }
}

#[test]
fn summaries_ignore_frontmatter_with_lf_or_crlf_without_changing_content() {
    for newline in ["\n", "\r\n"] {
        let vault = Vault::new();
        fs::create_dir_all(vault.0.join("02-工作/开发经验")).unwrap();
        let content = [
            "---",
            "description: |",
            "# YAML 中的标题",
            "---",
            "",
            "# 正文标题",
            "正文摘要",
            "",
        ]
        .join(newline);
        fs::write(vault.0.join("02-工作/开发经验/笔记.md"), &content).unwrap();
        let notes = scan(&vault.root()).unwrap();
        assert_eq!(notes[0].title, "正文标题");
        assert_eq!(notes[0].preview, "正文摘要");
        assert_eq!(
            read(&vault.root(), "02-工作/开发经验/笔记.md")
                .unwrap()
                .content,
            content
        );
    }
}

#[test]
fn summaries_return_raw_frontmatter_with_lf_crlf_and_bom() {
    for newline in ["\n", "\r\n"] {
        for bom in ["", "\u{feff}"] {
            let vault = Vault::new();
            fs::create_dir_all(vault.0.join("02-工作/开发经验")).unwrap();
            let yaml = format!(
                "tags: [开发, '测试']{newline}description: |{newline}  # 元数据标题{newline}"
            );
            let body = format!("# 正文标题{newline}正文摘要{newline}");
            let content = format!("{bom}---{newline}{yaml}---{newline}{body}");
            fs::write(vault.0.join("02-工作/开发经验/笔记.md"), &content).unwrap();
            let notes = scan(&vault.root()).unwrap();
            let serialized = serde_json::to_value(&notes[0]).unwrap();
            assert_eq!(serialized["frontmatter"], yaml);
            assert_eq!(notes[0].title, "正文标题");
            assert_eq!(notes[0].preview, "正文摘要");
            assert_eq!(
                read(&vault.root(), "02-工作/开发经验/笔记.md")
                    .unwrap()
                    .content,
                content
            );
        }
    }
}

#[test]
fn summaries_require_a_complete_leading_frontmatter_block() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("02-工作/开发经验")).unwrap();
    for content in [
        "# 普通标题\ntags: [正文]\n",
        "\u{feff}# 普通标题\n正文\n",
        "---\ntags: [未闭合]\n# 普通标题\n",
        "# 普通标题\n---\ntags: [正文]\n---\n",
        "---suffix\ntags: [正文]\n---\n# 普通标题\n",
    ] {
        fs::write(vault.0.join("02-工作/开发经验/笔记.md"), content).unwrap();
        let notes = scan(&vault.root()).unwrap();
        assert_eq!(serde_json::to_value(&notes[0]).unwrap()["frontmatter"], "");
        assert_eq!(notes[0].title, "普通标题");
        assert_eq!(
            read(&vault.root(), "02-工作/开发经验/笔记.md")
                .unwrap()
                .content,
            content
        );
    }
}

#[test]
fn summaries_accept_empty_frontmatter_and_a_closing_delimiter_at_eof() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("02-工作/开发经验")).unwrap();
    for (content, expected) in [
        ("---\n---\n# 正文", ""),
        ("---\r\ntags: []\r\n---", "tags: []\r\n"),
    ] {
        fs::write(vault.0.join("02-工作/开发经验/笔记.md"), content).unwrap();
        let notes = scan(&vault.root()).unwrap();
        assert_eq!(
            serde_json::to_value(&notes[0]).unwrap()["frontmatter"],
            expected
        );
        assert_eq!(
            read(&vault.root(), "02-工作/开发经验/笔记.md")
                .unwrap()
                .content,
            content
        );
    }
}

#[test]
fn knowledge_notes_deserialize_legacy_shapes_without_frontmatter() {
    let note: KnowledgeNote = serde_json::from_value(serde_json::json!({
        "path": "02-工作/旧笔记.md", "title": "旧笔记", "kind": "note", "modifiedAt": 0, "preview": "正文"
    })).unwrap();
    assert_eq!(serde_json::to_value(note).unwrap()["frontmatter"], "");
}

#[test]
fn templates_list_only_ordinary_markdown_in_the_template_scope() {
    let vault = Vault::new();
    assert!(templates(&vault.root()).unwrap().is_empty());
    for folder in [
        "07-模板/写作",
        "07-模板/.hidden",
        "07-模板/skills",
        "02-工作/开发经验",
    ] {
        fs::create_dir_all(vault.0.join(folder)).unwrap();
    }
    for path in ["07-模板/开发经验.md", "07-模板/写作/收藏.MD"] {
        fs::write(
            vault.0.join(path),
            "---\ntags: [模板]\n---\n# 模板标题\n待填写\n",
        )
        .unwrap();
    }
    for path in [
        "07-模板/.hidden/忽略.md",
        "07-模板/skills/忽略.md",
        "07-模板/.忽略.md",
        "07-模板/说明.txt",
    ] {
        fs::write(vault.0.join(path), [0xff, 0xff]).unwrap();
    }
    fs::write(vault.0.join("02-工作/开发经验/普通.md"), "# 普通笔记").unwrap();
    let notes = templates(&vault.root()).unwrap();
    assert_eq!(notes.len(), 2);
    assert!(
        notes
            .iter()
            .all(|note| note.path.starts_with("07-模板/") && note.title == "模板标题")
    );
    assert!(
        notes
            .iter()
            .all(|note| serde_json::to_value(note).unwrap()["frontmatter"] == "tags: [模板]\n")
    );
    assert_eq!(scan(&vault.root()).unwrap().len(), 1);
    assert!(search(&vault.root(), "模板标题").unwrap().is_empty());
}

#[test]
fn templates_return_at_most_one_hundred_items() {
    let vault = Vault::new();
    fs::create_dir(vault.0.join("07-模板")).unwrap();
    for index in 0..105 {
        fs::write(vault.0.join(format!("07-模板/{index:03}.md")), "# 模板").unwrap();
    }
    assert_eq!(templates(&vault.root()).unwrap().len(), 100);
}

#[test]
fn templates_skip_linked_directories_including_the_scope_root() {
    let vault = Vault::new();
    let outside = Vault::new();
    fs::write(outside.0.join("secret.md"), [0xff, 0xff]).unwrap();
    fs::create_dir(vault.0.join("07-模板")).unwrap();
    fs::write(vault.0.join("07-模板/普通.md"), "# 普通模板").unwrap();
    for relative in ["07-模板/linked", "07-模板"] {
        let link = vault.0.join(relative);
        if relative == "07-模板" {
            fs::rename(&link, vault.0.join("templates-backup")).unwrap();
        }
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link.to_string_lossy().replace('/', "\\"))
                .arg(outside.0.to_string_lossy().replace('/', "\\"))
                .output()
                .unwrap();
            assert!(output.status.success(), "junction creation failed");
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&outside.0, &link).unwrap();
        let result = templates(&vault.root());
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
        #[cfg(not(windows))]
        fs::remove_file(link).unwrap();
        let notes = result.unwrap();
        assert_eq!(notes.len(), usize::from(relative != "07-模板"));
    }
    assert_eq!(fs::read(outside.0.join("secret.md")).unwrap(), [0xff, 0xff]);
}

#[cfg(windows)]
#[test]
fn templates_skip_windows_hidden_directories() {
    let vault = Vault::new();
    fs::create_dir_all(vault.0.join("07-模板/hidden")).unwrap();
    fs::write(vault.0.join("07-模板/hidden/忽略.md"), [0xff, 0xff]).unwrap();
    let output = std::process::Command::new("attrib")
        .arg("+H")
        .arg(vault.0.join("07-模板/hidden"))
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(templates(&vault.root()).unwrap().is_empty());
}

#[test]
fn update_existing_markdown_preserves_bytes_and_returns_new_fingerprint() {
    let vault = Vault::new();
    fs::write(vault.0.join("笔记.md"), "# 原文\n原始内容\n").unwrap();
    let original = read(&vault.root(), "笔记.md").unwrap();
    let content = "---\r\ntags: [测试]\r\n---\r\n# 更新\r\n正文\r\n";
    let updated = update(
        &vault.root(),
        UpdateNoteInput {
            path: original.path.clone(),
            content: content.into(),
            fingerprint: original.fingerprint.clone(),
        },
    )
    .unwrap();
    assert_eq!(updated.path, original.path);
    assert_eq!(updated.content, content);
    assert_ne!(updated.fingerprint, original.fingerprint);
    assert_eq!(
        read(&vault.root(), "笔记.md").unwrap().fingerprint,
        updated.fingerprint
    );
    assert_eq!(
        fs::read(vault.0.join("笔记.md")).unwrap(),
        content.as_bytes()
    );
    assert_eq!(
        fs::read_to_string(vault.0.join("笔记.md.bak")).unwrap(),
        original.content
    );
    assert!(!vault.0.join("笔记.md.tmp").exists());
}

#[test]
fn update_rejects_stale_fingerprints_without_overwriting_external_edits() {
    let vault = Vault::new();
    fs::write(vault.0.join("笔记.md"), "original").unwrap();
    let original = read(&vault.root(), "笔记.md").unwrap();
    fs::write(vault.0.join("笔记.md"), "external edit").unwrap();
    let error = update(
        &vault.root(),
        UpdateNoteInput {
            path: original.path,
            content: "editor draft".into(),
            fingerprint: original.fingerprint,
        },
    )
    .unwrap_err();
    assert!(
        error.contains("修改"),
        "conflict must explain external changes: {error}"
    );
    assert_eq!(
        fs::read_to_string(vault.0.join("笔记.md")).unwrap(),
        "external edit"
    );
    assert!(!vault.0.join("笔记.md.bak").exists());
    assert!(!vault.0.join("笔记.md.tmp").exists());
}

#[test]
fn update_rejects_missing_non_markdown_outside_and_oversized_content() {
    let vault = Vault::new();
    let outside = Vault::new();
    fs::write(vault.0.join("笔记.md"), "original").unwrap();
    fs::write(vault.0.join("配置.json"), "original").unwrap();
    fs::write(outside.0.join("笔记.md"), "outside").unwrap();
    let original = read(&vault.root(), "笔记.md").unwrap();
    for path in [
        "missing.md",
        "配置.json",
        "../escape.md",
        &outside.0.join("笔记.md").to_string_lossy(),
    ] {
        assert!(
            update(
                &vault.root(),
                UpdateNoteInput {
                    path: path.into(),
                    content: "changed".into(),
                    fingerprint: original.fingerprint.clone(),
                }
            )
            .is_err(),
            "must reject {path}"
        );
    }
    assert!(!vault.0.join("missing.md").exists());
    assert_eq!(
        fs::read_to_string(vault.0.join("配置.json")).unwrap(),
        "original"
    );
    assert_eq!(
        fs::read_to_string(outside.0.join("笔记.md")).unwrap(),
        "outside"
    );
    assert!(
        update(
            &vault.root(),
            UpdateNoteInput {
                path: original.path,
                content: "字".repeat(8 * 1024 * 1024 / 3 + 1),
                fingerprint: original.fingerprint,
            }
        )
        .unwrap_err()
        .contains("8 MiB")
    );
    assert_eq!(
        fs::read_to_string(vault.0.join("笔记.md")).unwrap(),
        "original"
    );
}

#[test]
fn update_allows_empty_markdown_and_the_eight_mib_boundary() {
    let vault = Vault::new();
    fs::write(vault.0.join("笔记.MD"), "original").unwrap();
    let original = read(&vault.root(), "笔记.MD").unwrap();
    let empty = update(
        &vault.root(),
        UpdateNoteInput {
            path: original.path,
            content: String::new(),
            fingerprint: original.fingerprint,
        },
    )
    .unwrap();
    assert_eq!(empty.content, "");
    let boundary = "x".repeat(8 * 1024 * 1024);
    let updated = update(
        &vault.root(),
        UpdateNoteInput {
            path: empty.path,
            content: boundary.clone(),
            fingerprint: empty.fingerprint,
        },
    )
    .unwrap();
    assert_eq!(updated.content, boundary);
    assert_eq!(
        read(&vault.root(), "笔记.MD").unwrap().fingerprint,
        updated.fingerprint
    );
}

#[test]
fn update_rejects_linked_atomic_write_auxiliary_paths() {
    for suffix in ["tmp", "bak"] {
        let vault = Vault::new();
        let outside = Vault::new();
        fs::write(vault.0.join("笔记.md"), "original").unwrap();
        let original = read(&vault.root(), "笔记.md").unwrap();
        let link = vault.0.join(format!("笔记.md.{suffix}"));
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(link.to_string_lossy().replace('/', "\\"))
                .arg(outside.0.to_string_lossy().replace('/', "\\"))
                .output()
                .unwrap();
            assert!(status.status.success(), "junction creation failed");
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&outside.0, &link).unwrap();
        let result = update(
            &vault.root(),
            UpdateNoteInput {
                path: original.path,
                content: "changed".into(),
                fingerprint: original.fingerprint,
            },
        );
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
        #[cfg(not(windows))]
        fs::remove_file(link).unwrap();
        assert!(result.unwrap_err().contains("链接"));
        assert_eq!(
            fs::read_to_string(vault.0.join("笔记.md")).unwrap(),
            "original"
        );
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
    }
}
