use super::{ContentIndex, SearchDocument, SearchHit};
use serde_json::json;

fn doc(id: &str, kind: &str, title: &str, body: &str) -> SearchDocument {
    SearchDocument {
        hit: SearchHit {
            id: id.into(),
            kind: kind.into(),
            title: title.into(),
            subtitle: "测试来源".into(),
            snippet: String::new(),
            path: None,
            url: None,
            route: Some("/knowledge".into()),
            score: 0.0,
        },
        body: body.into(),
    }
}

#[test]
fn chinese_short_terms_match_real_phrases_and_rank_titles_first() {
    let mut index = ContentIndex::memory().unwrap();
    index
        .replace(&[
            doc("body", "knowledge", "其他笔记", "文档路径与备份"),
            doc("title", "plan", "文档备份", "今天完成"),
            doc("false", "knowledge", "文与档", "不连续字应被排除"),
        ])
        .unwrap();
    let hits = index.query("文档", "all", 20).unwrap();
    assert_eq!(hits[0].id, "title");
    assert_eq!(
        index
            .query("文档 路径", "all", 20)
            .unwrap()
            .iter()
            .map(|h| h.id.as_str())
            .collect::<Vec<_>>(),
        vec!["body"]
    );
    assert!(
        !index
            .query("文档", "all", 20)
            .unwrap()
            .iter()
            .any(|h| h.id == "false")
    );
}

#[test]
fn replacement_removes_deleted_and_edited_content_and_respects_scopes() {
    let mut index = ContentIndex::memory().unwrap();
    index
        .replace(&[
            doc("one", "knowledge", "Alpha", "old keyword"),
            doc("two", "plan", "Beta", "keyword"),
        ])
        .unwrap();
    assert_eq!(index.query("keyword", "plan", 10).unwrap().len(), 1);
    index
        .replace(&[doc("one", "knowledge", "Alpha", "new material")])
        .unwrap();
    assert!(index.query("keyword", "all", 10).unwrap().is_empty());
    assert_eq!(index.query("new", "knowledge", 10).unwrap()[0].id, "one");
}

#[test]
fn quotes_exclusions_or_and_untrusted_match_text_are_not_sql() {
    let mut index = ContentIndex::memory().unwrap();
    index
        .replace(&[
            doc("one", "plan", "Alpha Beta", "safe"),
            doc("two", "feed", "Alpha", "Beta elsewhere"),
            doc("three", "knowledge", "Gamma", "hello"),
        ])
        .unwrap();
    assert_eq!(index.query("\"Alpha Beta\"", "all", 10).unwrap().len(), 1);
    assert_eq!(
        index
            .query("alpha !elsewhere | gamma", "all", 10)
            .unwrap()
            .len(),
        2
    );
    assert!(index.query("' OR 1=1 --", "all", 10).unwrap().is_empty());
    assert!(index.query("", "all", 10).unwrap().is_empty());
    assert!(index.query("Alpha", "all", 0).unwrap().is_empty());
}

#[test]
fn plan_subtasks_archives_and_attachment_names_keep_distinct_destinations() {
    let states = std::collections::BTreeMap::from([
        (
            "plans".into(),
            json!({"state":{"days":{"2026-10-18":[{"id":"a","title":"父任务"},{"id":"b","parentId":"a","title":"子任务","attachments":[{"name":"截图.png"}]}]}}}),
        ),
        (
            "plans-archive".into(),
            json!({"state":{"days":{"2026-10-17":{"tasks":[{"id":"a","title":"父任务"}]}}}}),
        ),
    ]);
    let docs = super::sources::from_states(&states);
    assert_eq!(docs.len(), 3);
    assert!(
        docs.iter()
            .find(|d| d.hit.id.contains(":b"))
            .unwrap()
            .body
            .contains("截图.png")
    );
    assert!(
        docs.iter()
            .find(|d| d.hit.id.contains("2026-10-17"))
            .unwrap()
            .hit
            .route
            .as_ref()
            .unwrap()
            .contains("archived=1")
    );
}

#[test]
fn content_sources_deduplicate_articles_and_never_index_provider_credentials() {
    let states = std::collections::BTreeMap::from([
        (
            "feed-cache".into(),
            json!({"state":{"entriesBySource":{"rss:x":[{"id":"1","title":"Article","url":"https://example.test/1","content":{"format":"html","value":"<p>正文</p>"}}]}}}),
        ),
        (
            "favorites".into(),
            json!({"state":{"items":[{"id":"fav","title":"Article","url":"https://example.test/1","sourceName":"来源"}]}}),
        ),
        (
            "ai-providers".into(),
            json!({"state":{"secret":"NEVER_INDEX_THIS"}}),
        ),
    ]);
    let docs = super::sources::from_states(&states);
    assert_eq!(docs.len(), 1);
    assert!(docs[0].body.contains("正文"));
    assert!(!docs[0].body.contains("NEVER_INDEX_THIS"));
}

#[test]
fn managed_note_collection_is_read_only_and_excludes_other_obsidian_notes() {
    let root = std::env::temp_dir().join(format!(
        "nimbus-search-vault-{}-{}",
        std::process::id(),
        super::runtime::now()
    ));
    std::fs::create_dir_all(root.join(".obsidian")).unwrap();
    std::fs::create_dir_all(root.join("work/experience")).unwrap();
    std::fs::create_dir_all(root.join("private")).unwrap();
    std::fs::write(
        root.join("work/experience/example.md"),
        "# 中文笔记\n\n完整正文与标签",
    )
    .unwrap();
    std::fs::write(root.join("private/secret.md"), "do not index").unwrap();
    let folders = crate::knowledge::KnowledgeFolders {
        experience: "work/experience".into(),
        recipe: "work/recipe".into(),
        resource: "resources".into(),
    };
    let files = super::sources::note_files(root.to_str().unwrap(), folders).unwrap();
    assert_eq!(files.len(), 1);
    let document = super::sources::note_document(root.to_str().unwrap(), &files[0]).unwrap();
    assert_eq!(document.hit.title, "中文笔记");
    assert!(document.body.contains("完整正文"));
    assert!(!root.join("work/recipe").exists());
    assert!(!root.join("08-收件箱").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("work/experience/example.md")).unwrap(),
        "# 中文笔记\n\n完整正文与标签"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_failed_index_replacement_retains_the_previous_searchable_snapshot() {
    let mut index = ContentIndex::memory().unwrap();
    index
        .replace(&[doc("old", "knowledge", "Previous", "keep this")])
        .unwrap();
    assert!(
        index
            .replace(&[
                doc("duplicate", "plan", "First", "x"),
                doc("duplicate", "plan", "Second", "y")
            ])
            .is_err()
    );
    assert_eq!(index.query("keep", "all", 10).unwrap()[0].id, "old");
}

#[test]
fn projects_and_their_work_items_are_searchable_with_a_focusing_route() {
    let states = std::collections::BTreeMap::from([(
        "projects".into(),
        json!({"state":{
            "areas":[{"id":"area","name":"平台"}],
            "projects":[{"id":"proj","name":"云台","areaId":"area","note":"桌面工作台"}],
            "items":[
                {"id":"doing","title":"做搜索","projectId":"proj","areaId":null,"status":"doing","note":"接入项目"},
                {"id":"done","title":"做导航","projectId":"proj","areaId":null,"status":"done"},
                {"id":"loose","title":"零散事","projectId":null,"areaId":null,"status":"todo"},
                {"id":"merged","title":"被合并","projectId":"proj","areaId":null,"status":"todo","mergedIntoId":"doing"}
            ]
        }}),
    )]);
    let docs = super::sources::from_states(&states);
    // Merged items are aliases of a surviving row and must not add a second hit.
    assert_eq!(docs.len(), 4);
    assert!(docs.iter().all(|d| d.hit.kind == "project"));
    assert!(docs.iter().all(|d| !d.hit.id.contains("merged")));

    let project = docs.iter().find(|d| d.hit.id == "project:proj").unwrap();
    assert_eq!(project.hit.title, "云台");
    assert!(project.hit.route.as_ref().unwrap().starts_with("/projects?project=proj"));
    // The area belongs in the subtitle so searching "平台" finds the project.
    assert_eq!(project.hit.subtitle, "平台");
    assert!(project.body.contains("桌面工作台"));

    let item = docs.iter().find(|d| d.hit.id == "project-item:doing").unwrap();
    assert_eq!(item.hit.title, "做搜索");
    assert_eq!(item.hit.subtitle, "云台 · 进行中");
    assert!(item.hit.route.as_ref().unwrap().starts_with("/projects?item=doing"));
    assert!(item.body.contains("接入项目"));

    // A project-less item still reports its status without inventing a name.
    let loose = docs.iter().find(|d| d.hit.id == "project-item:loose").unwrap();
    assert_eq!(loose.hit.subtitle, "待办");
}
