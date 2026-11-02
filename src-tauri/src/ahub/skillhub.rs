//! 腾讯 SkillHub 市场（skillhub.cn）接入。
//!
//! 该站点是 SPA，没有 git 仓库可克隆；真实数据来自其后端 REST API：
//! - 列表：`GET {base}/api/skills?page&pageSize&sortBy&order&keyword&category&source`
//! - 分类：`GET {base}/api/v1/categories`
//! - 下载：`GET {base}/api/v1/download?slug=&version=&namespace=` → ZIP（内含 SKILL.md）
//!
//! 安装复用 `skills::import_skill_zip`，因此 zip-slip / zip-bomb 防护与本地导入完全一致。

use std::io::Read;

use crate::ahub::store::AppH;
use serde::Serialize;

/// 与站点前端 `getApiBaseUrl()` 保持一致
const API_BASE: &str = "https://api.skillhub.cn";
const UA: &str = "AgentHub/0.1 (+desktop)";
/// 单个技能包下载上限（解压后的总量上限由 import_skill_zip 再校验）
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;
const TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSkill {
    /// 短标识，如 `dev-god`
    pub slug: String,
    /// 归属命名空间，如 `ake`（用于消歧与精确下载）
    pub namespace: String,
    /// 完整坐标，如 `@ake/dev-god`
    pub coordinate: String,
    pub name: String,
    /// 中文描述优先，回落到通用描述
    pub description: String,
    pub version: String,
    pub category: String,
    pub source: String,
    pub downloads: u64,
    pub stars: u64,
    pub icon_url: String,
    pub verified: bool,
    /// 发布方显示名（个人 handle 或机构名）
    pub publisher: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPage {
    pub total: u64,
    pub page: u64,
    pub page_size: u64,
    pub skills: Vec<MarketSkill>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCategory {
    pub key: String,
    pub name: String,
    pub name_en: String,
}

/// 单次要安装的目标（来自前端已勾选的行）
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTarget {
    pub slug: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub name: String,
    /// 空 / `skillhub` = 腾讯 SkillHub；`deepskill` = DeepSkill 市场；`github` = GitHub 仓库
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstallReport {
    pub slug: String,
    pub name: String,
    pub version: String,
    /// 落库后的技能目录名（安装成功时）
    pub dir_name: String,
    pub ok: bool,
    pub error: String,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .user_agent(UA)
        .build()
}

/// 站点要求带 referer 才返回 JSON（否则给 SPA 的 HTML fallback）
fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let resp = agent()
        .get(url)
        .set("Accept", "application/json")
        .set("Referer", "https://skillhub.cn/")
        .call()
        .map_err(|e| format!("无法连接 SkillHub：{e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("SkillHub 返回了无法解析的内容：{e}"))
}

fn as_u64(v: &serde_json::Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

fn first_non_empty(a: &serde_json::Value, b: &serde_json::Value) -> String {
    let s = a.as_str().unwrap_or("").trim();
    if !s.is_empty() {
        return s.to_string();
    }
    b.as_str().unwrap_or("").trim().to_string()
}

/// `namespace` 字段在不同接口里可能是对象也可能是字符串
fn namespace_of(sk: &serde_json::Value) -> (String, String) {
    let ns = &sk["namespace"];
    if let Some(obj) = ns.as_object() {
        let handle = obj.get("handle").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let canon = obj
            .get("canonicalName")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let coord = if !canon.is_empty() {
            canon
        } else if !handle.is_empty() {
            format!("@{handle}/{}", sk["slug"].as_str().unwrap_or(""))
        } else {
            sk["slug"].as_str().unwrap_or("").to_string()
        };
        (handle, coord)
    } else {
        let s = ns.as_str().unwrap_or("").to_string();
        let slug = sk["slug"].as_str().unwrap_or("");
        let coord = if s.is_empty() { slug.to_string() } else { format!("@{s}/{slug}") };
        (s, coord)
    }
}

fn publisher_of(sk: &serde_json::Value) -> String {
    let p = &sk["publisher"];
    if let Some(obj) = p.as_object() {
        let n = obj.get("name").and_then(|x| x.as_str()).unwrap_or("").trim();
        if !n.is_empty() {
            return n.to_string();
        }
        let c = obj.get("certifiedName").and_then(|x| x.as_str()).unwrap_or("").trim();
        if !c.is_empty() {
            return c.to_string();
        }
    }
    sk["ownerName"].as_str().unwrap_or("").to_string()
}

fn parse_skill(sk: &serde_json::Value) -> MarketSkill {
    let (namespace, coordinate) = namespace_of(sk);
    MarketSkill {
        slug: sk["slug"].as_str().unwrap_or("").to_string(),
        namespace,
        coordinate,
        name: sk["name"].as_str().unwrap_or("").to_string(),
        description: first_non_empty(&sk["description_zh"], &sk["description"]),
        version: sk["version"].as_str().unwrap_or("").to_string(),
        category: sk["category"].as_str().unwrap_or("").to_string(),
        source: sk["source"].as_str().unwrap_or("").to_string(),
        downloads: as_u64(&sk["downloads"]),
        stars: as_u64(&sk["stars"]),
        icon_url: sk["iconUrl"].as_str().unwrap_or("").to_string(),
        verified: sk["verified"].as_bool().unwrap_or(false),
        publisher: publisher_of(sk),
    }
}

/// 搜索 / 浏览市场。
/// `sort` 可取 `score` / `downloads` / `updated_at`；`source` 为空或 `all` 表示不筛选。
pub fn search(
    keyword: &str,
    category: &str,
    source: &str,
    sort: &str,
    page: u32,
    page_size: u32,
) -> Result<MarketPage, String> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 50);
    let sort = if sort.is_empty() { "score" } else { sort };

    let mut q: Vec<String> = vec![
        format!("page={page}"),
        format!("pageSize={page_size}"),
        format!("sortBy={}", urlencode(sort)),
        "order=desc".into(),
    ];
    if !keyword.trim().is_empty() {
        q.push(format!("keyword={}", urlencode(keyword.trim())));
    }
    if !category.trim().is_empty() && category != "all" {
        q.push(format!("category={}", urlencode(category.trim())));
    }
    if !source.trim().is_empty() && source != "all" {
        q.push(format!("source={}", urlencode(source.trim())));
    }

    let url = format!("{API_BASE}/api/skills?{}", q.join("&"));
    let v = get_json(&url)?;
    let code = v["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        return Err(format!(
            "SkillHub 搜索失败：{}",
            v["message"].as_str().unwrap_or("未知错误")
        ));
    }
    let data = &v["data"];
    let skills = data["skills"]
        .as_array()
        .map(|a| a.iter().map(parse_skill).collect())
        .unwrap_or_default();
    Ok(MarketPage {
        total: as_u64(&data["total"]),
        page: page as u64,
        page_size: page_size as u64,
        skills,
    })
}

/// 一级分类。`{"count":13,"items":[{key,name,nameEn,...}]}`
pub fn categories() -> Result<Vec<MarketCategory>, String> {
    let v = get_json(&format!("{API_BASE}/api/v1/categories"))?;
    let items = v["items"].as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .filter(|it| it["active"].as_bool().unwrap_or(true))
        .map(|it| MarketCategory {
            key: it["key"].as_str().unwrap_or("").to_string(),
            name: it["name"].as_str().unwrap_or("").to_string(),
            name_en: it["nameEn"].as_str().unwrap_or("").to_string(),
        })
        .collect())
}

/// 多来源搜索：统一返回 `MarketPage`，前端卡片与安装流程都不用分叉。
/// `source`：空 / `skillhub` / `deepskill` / `github`。
pub fn search_source(
    keyword: &str,
    page: u32,
    page_size: u32,
    source: &str,
) -> Result<MarketPage, String> {
    match source {
        "deepskill" => search_deepskill(keyword, page, page_size),
        "github" => search_github(keyword, page, page_size),
        _ => search(keyword, "", "all", "score", page, page_size),
    }
}

fn get_json_plain(url: &str) -> Result<serde_json::Value, String> {
    let resp = agent()
        .get(url)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("请求失败：{e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("返回内容无法解析：{e}"))
}

/// DeepSkill 市场：接口是「场景分组 → 技能」，这里压平成一页卡片；翻页在本地切。
fn search_deepskill(keyword: &str, page: u32, page_size: u32) -> Result<MarketPage, String> {
    let url = format!(
        "https://www.deepskill.market/api/v1/skills/search/deep?query={}&ref=skillhub",
        urlencode(keyword.trim())
    );
    let value = get_json_plain(&url)?;
    let mut out: Vec<MarketSkill> = Vec::new();
    for group in value
        .pointer("/data/items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let scene = group.get("scene").and_then(|v| v.as_str()).unwrap_or("").to_string();
        for skill in group
            .get("skills")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
        {
            let name = skill.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if name.is_empty() || out.iter().any(|item| item.slug == name) {
                continue;
            }
            let creator = skill.get("creator").and_then(|v| v.as_str()).unwrap_or("").to_string();
            out.push(MarketSkill {
                slug: name.clone(),
                namespace: creator.clone(),
                coordinate: name.clone(),
                name,
                description: skill
                    .get("description")
                    .and_then(|v| v.as_str())
                    .or_else(|| skill.get("alias").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string(),
                version: String::new(),
                category: scene.clone(),
                source: "deepskill".into(),
                downloads: skill.get("downloadCount").and_then(|v| v.as_u64()).unwrap_or(0),
                stars: 0,
                icon_url: String::new(),
                verified: false,
                publisher: creator,
            });
        }
    }
    let total = out.len() as u64;
    let page_size = page_size.clamp(1, 50) as usize;
    let start = ((page.max(1) - 1) as usize) * page_size;
    let skills = out.into_iter().skip(start).take(page_size).collect();
    Ok(MarketPage { total, page: page.max(1) as u64, page_size: page_size as u64, skills })
}

/// GitHub 仓库搜索：结果就是仓库坐标 `owner/repo`，安装时整仓 clone 再挑出技能目录。
fn search_github(keyword: &str, page: u32, page_size: u32) -> Result<MarketPage, String> {
    let query = if keyword.trim().is_empty() {
        "claude skills".to_string()
    } else {
        format!("{} skill", keyword.trim())
    };
    let page = page.max(1);
    let page_size = page_size.clamp(1, 50);
    let url = format!(
        "https://api.github.com/search/repositories?q={}&sort=stars&order=desc&per_page={page_size}&page={page}",
        urlencode(&query)
    );
    let value = get_json_plain(&url)?;
    if let Some(message) = value.get("message").and_then(|v| v.as_str()) {
        return Err(format!("GitHub 搜索受限：{message}"));
    }
    let skills = value
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let full = item.get("full_name").and_then(|v| v.as_str())?.to_string();
            let owner = item
                .pointer("/owner/login")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(MarketSkill {
                slug: full.clone(),
                namespace: owner.clone(),
                coordinate: full.clone(),
                name: full,
                description: item.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                version: String::new(),
                category: "github".into(),
                source: "github".into(),
                downloads: 0,
                stars: item.get("stargazers_count").and_then(|v| v.as_u64()).unwrap_or(0),
                icon_url: item.pointer("/owner/avatar_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                verified: false,
                publisher: owner,
            })
        })
        .collect();
    Ok(MarketPage {
        total: value.get("total_count").and_then(|v| v.as_u64()).unwrap_or(0),
        page: page as u64,
        page_size: page_size as u64,
        skills,
    })
}

/// 下载一个技能包（ZIP 字节）。`namespace` / `version` 为空时由服务端取默认。
fn download_zip(slug: &str, namespace: &str, version: &str) -> Result<Vec<u8>, String> {
    let mut url = format!("{API_BASE}/api/v1/download?slug={}", urlencode(slug));
    if !version.trim().is_empty() {
        url.push_str(&format!("&version={}", urlencode(version.trim())));
    }
    if !namespace.trim().is_empty() {
        url.push_str(&format!("&namespace={}", urlencode(namespace.trim())));
    }

    let resp = agent()
        .get(&url)
        .set("Accept", "application/zip, application/octet-stream")
        .set("Referer", "https://skillhub.cn/")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => "该技能在市场中已不存在（404）".to_string(),
            ureq::Error::Status(code, _) => format!("下载失败（HTTP {code}）"),
            other => format!("下载失败：{other}"),
        })?;

    if let Some(len) = resp.header("Content-Length").and_then(|s| s.parse::<u64>().ok()) {
        if len > MAX_DOWNLOAD {
            return Err(format!(
                "技能包过大（{:.1} MB），已超过 {} MB 上限",
                len as f64 / 1_048_576.0,
                MAX_DOWNLOAD / 1_048_576
            ));
        }
    }

    let mut buf = Vec::new();
    let mut reader = resp.into_reader().take(MAX_DOWNLOAD + 1);
    std::io::Read::read_to_end(&mut reader, &mut buf).map_err(|e| format!("读取下载内容失败：{e}"))?;
    if buf.len() as u64 > MAX_DOWNLOAD {
        return Err(format!("技能包过大，已超过 {} MB 上限", MAX_DOWNLOAD / 1_048_576));
    }
    if buf.is_empty() {
        return Err("下载到空内容".into());
    }
    Ok(buf)
}

/// 批量安装。按来源分派：SkillHub 走官方 ZIP，DeepSkill 走公开下载，GitHub 走 clone。
pub fn install(
    app: &AppH,
    targets: &[InstallTarget],
    overwrite: bool,
) -> Vec<MarketInstallReport> {
    let stamp = crate::ahub::models::now_iso().replace([':', '-', '.'], "");
    targets
        .iter()
        .map(|t| match t.source.as_str() {
            "deepskill" => install_deepskill(app, t, overwrite),
            "github" => install_github(app, t, overwrite),
            _ => install_skillhub(app, t, overwrite, &stamp),
        })
        .collect()
}

fn install_skillhub(app: &AppH, t: &InstallTarget, overwrite: bool, stamp: &str) -> MarketInstallReport {
    let mut rep = report_for(t);
    match download_zip(&t.slug, &t.namespace, &t.version) {
        Ok(bytes) => {
            let tmp = std::env::temp_dir()
                .join(format!("agenthub-skillhub-{}-{stamp}-{}.zip", std::process::id(), t.slug));
            if let Err(e) = std::fs::write(&tmp, &bytes) {
                rep.error = format!("写入临时文件失败：{e}");
                return rep;
            }
            let r = crate::ahub::skills::import_skill_zip(app, &tmp.to_string_lossy(), overwrite);
            let _ = std::fs::remove_file(&tmp);
            match r {
                Ok(dir) => {
                    rep.dir_name = dir;
                    rep.ok = true;
                }
                Err(e) => rep.error = e,
            }
        }
        Err(e) => rep.error = e,
    }
    rep
}

fn report_for(t: &InstallTarget) -> MarketInstallReport {
    MarketInstallReport {
        slug: t.slug.clone(),
        name: t.name.clone(),
        version: t.version.clone(),
        dir_name: String::new(),
        ok: false,
        error: String::new(),
    }
}

/// DeepSkill 市场：`download/public?name=` 给 ZIP 或单文件 SKILL.md。
fn install_deepskill(app: &AppH, t: &InstallTarget, overwrite: bool) -> MarketInstallReport {
    let mut rep = report_for(t);
    let url = format!(
        "https://www.deepskill.market/api/v1/skills/download/public?name={}",
        urlencode(&t.slug)
    );
    let bytes = match download_bytes(&url) {
        Ok(bytes) => bytes,
        Err(e) => {
            rep.error = e;
            return rep;
        }
    };
    let stamp = crate::ahub::models::now_iso().replace([':', '-', '.'], "");
    let result = if bytes.starts_with(b"PK\x03\x04") {
        let tmp = std::env::temp_dir()
            .join(format!("agenthub-deepskill-{}-{stamp}-{}.zip", std::process::id(), t.slug.replace('/', "_")));
        match std::fs::write(&tmp, &bytes) {
            Ok(()) => {
                let r = crate::ahub::skills::import_skill_zip(app, &tmp.to_string_lossy(), overwrite);
                let _ = std::fs::remove_file(&tmp);
                r
            }
            Err(e) => Err(format!("写入临时文件失败：{e}")),
        }
    } else {
        let dir = std::env::temp_dir().join(format!(
            "agenthub-deepskill-{}-{stamp}-{}",
            std::process::id(),
            t.slug.replace('/', "_")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let written = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(dir.join("SKILL.md"), &bytes));
        match written {
            Ok(()) => {
                let r = crate::ahub::skills::import_skill_dir(app, &dir, overwrite);
                let _ = std::fs::remove_dir_all(&dir);
                r
            }
            Err(e) => Err(format!("写入临时技能目录失败：{e}")),
        }
    };
    match result {
        Ok(dir_name) => {
            rep.dir_name = dir_name.clone();
            rep.ok = true;
            let root = crate::ahub::store::data_root(app).join("skills").join(&dir_name);
            let page = format!("https://www.deepskill.market/skill/skill?name={}", urlencode(&t.slug));
            let _ = crate::ahub::upstream::stamp(&root, &page, "web", "", "", "");
        }
        Err(e) => rep.error = e,
    }
    rep
}

/// GitHub：按 `owner/repo` 克隆一次，把里面所有含 SKILL.md 的目录都装进来，
/// 并落下 revision / 子目录树指纹 —— 装完就是可跟踪的。
fn install_github(app: &AppH, t: &InstallTarget, overwrite: bool) -> MarketInstallReport {
    let mut rep = report_for(t);
    let full = if t.slug.contains('/') {
        t.slug.clone()
    } else if !t.namespace.is_empty() {
        format!("{}/{}", t.namespace, t.slug)
    } else {
        t.slug.clone()
    };
    let repo_url = format!("https://github.com/{full}");
    let stamp = crate::ahub::models::now_iso().replace([':', '-', '.'], "");
    let tmp = std::env::temp_dir().join(format!(
        "agenthub-gh-{}-{stamp}-{}",
        std::process::id(),
        full.replace('/', "-")
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    let cloned = crate::ahub::store::silent_command("git")
        .args(["clone", "--depth", "1", &repo_url])
        .arg(&tmp)
        .output();
    let ok = matches!(&cloned, Ok(out) if out.status.success());
    if !ok {
        let note = match &cloned {
            Ok(out) => format!("clone 失败：{}", String::from_utf8_lossy(&out.stderr).trim()),
            Err(_) => "git 不可用（未安装或不在 PATH）".into(),
        };
        let _ = std::fs::remove_dir_all(&tmp);
        rep.error = note;
        return rep;
    }
    let revision = crate::ahub::store::silent_command("git")
        .args(["-C"])
        .arg(&tmp)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();

    let mut installed: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for dir in skill_dirs(&tmp) {
        let rel = dir
            .strip_prefix(&tmp)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        match crate::ahub::skills::import_skill_dir(app, &dir, overwrite) {
            Ok(dir_name) => {
                let root = crate::ahub::store::data_root(app).join("skills").join(&dir_name);
                let subtree = if revision.is_empty() || rel.is_empty() {
                    String::new()
                } else {
                    crate::ahub::store::silent_command("git")
                        .args(["-C"])
                        .arg(&tmp)
                        .args(["rev-parse", &format!("{revision}:{rel}")])
                        .output()
                        .ok()
                        .filter(|out| out.status.success())
                        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                        .unwrap_or_default()
                };
                let _ = crate::ahub::upstream::stamp(&root, &repo_url, "git-scan", &revision, &rel, &subtree);
                installed.push(dir_name);
            }
            Err(e) => errors.push(format!("{rel}: {e}")),
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    rep.ok = !installed.is_empty();
    rep.dir_name = installed.join(", ");
    rep.error = errors.join("；");
    rep
}

/// 仓库里含 SKILL.md 的目录（跳过 .git，限深 4、最多 20 个）。
fn skill_dirs(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    fn walk(dir: &std::path::Path, depth: u32, out: &mut Vec<std::path::PathBuf>) {
        if depth > 4 || out.len() >= 20 {
            return;
        }
        if dir.join("SKILL.md").is_file() {
            out.push(dir.to_path_buf());
            return;
        }
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" || name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(&path, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out
}

fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = agent()
        .get(url)
        .set("Accept", "application/zip, application/octet-stream, text/markdown, */*")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => "该技能在市场里已不存在（404）".to_string(),
            ureq::Error::Status(code, _) => format!("下载失败（HTTP {code}）"),
            other => format!("下载失败：{other}"),
        })?;
    let mut buf = Vec::new();
    let mut reader = resp.into_reader().take(MAX_DOWNLOAD + 1);
    std::io::Read::read_to_end(&mut reader, &mut buf).map_err(|e| format!("读取下载内容失败：{e}"))?;
    if buf.len() as u64 > MAX_DOWNLOAD {
        return Err(format!("技能包过大，已超过 {} MB 上限", MAX_DOWNLOAD / 1_048_576));
    }
    if buf.is_empty() {
        return Err("下载到空内容".into());
    }
    Ok(buf)
}

/// 最小 percent-encoding（只编码查询参数里真正需要转义的字符）
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_dirs_finds_nested_skills_and_skips_git() {
        let root = std::env::temp_dir().join(format!(
            "ah-skilldirs-{}-{}",
            std::process::id(),
            crate::ahub::models::new_id()
        ));
        std::fs::create_dir_all(root.join("skills/a")).unwrap();
        std::fs::create_dir_all(root.join("plugins/x/skills/b")).unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("skills/a/SKILL.md"), "a").unwrap();
        std::fs::write(root.join("plugins/x/skills/b/SKILL.md"), "b").unwrap();
        std::fs::write(root.join("SKILL.md"), "root").unwrap();
        std::fs::write(root.join(".git/objects/SKILL.md"), "fake").unwrap();
        let dirs = skill_dirs(&root);
        assert_eq!(dirs.len(), 1, "根目录有 SKILL.md 就只算根：{dirs:?}");
        assert_eq!(dirs[0], root);
        let _ = std::fs::remove_file(root.join("SKILL.md"));
        let dirs = skill_dirs(&root);
        let names: Vec<String> = dirs
            .iter()
            .map(|d| d.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(names, vec!["plugins/x/skills/b".to_string(), "skills/a".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "联网冒烟：cargo test --lib market_sources_smoke -- --ignored --nocapture"]
    fn market_sources_smoke() {
        for source in ["deepskill", "github"] {
            match search_source("pdf", 1, 5, source) {
                Ok(page) => println!(
                    "{source}: total={} first={:?}",
                    page.total,
                    page.skills.first().map(|s| (s.slug.clone(), s.publisher.clone(), s.downloads))
                ),
                Err(error) => println!("{source}: 失败 {error}"),
            }
        }
        match download_bytes("https://www.deepskill.market/api/v1/skills/download/public?name=pdf") {
            Ok(bytes) => println!("deepskill 下载 {} 字节，zip={}", bytes.len(), bytes.starts_with(b"PK")),
            Err(error) => println!("deepskill 下载失败：{error}"),
        }
    }

    #[test]
    fn urlencode_escapes_non_ascii() {
        assert_eq!(urlencode("爬虫"), "%E7%88%AC%E8%99%AB");
        assert_eq!(urlencode("dev-god"), "dev-god");
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("a/b?c=d"), "a%2Fb%3Fc%3Dd");
    }

    #[test]
    fn namespace_handles_object_and_string() {
        let obj: serde_json::Value = serde_json::json!({
            "slug": "dev-god",
            "namespace": {"canonicalName": "@ake/dev-god", "handle": "ake"}
        });
        assert_eq!(namespace_of(&obj), ("ake".into(), "@ake/dev-god".into()));

        let s: serde_json::Value = serde_json::json!({ "slug": "x", "namespace": "foo" });
        assert_eq!(namespace_of(&s), ("foo".into(), "@foo/x".into()));

        let none: serde_json::Value = serde_json::json!({ "slug": "y", "namespace": null });
        assert_eq!(namespace_of(&none), ("".into(), "y".into()));
    }

    #[test]
    fn prefers_chinese_description_and_reads_certified_publisher() {
        let sk: serde_json::Value = serde_json::json!({
            "slug": "dev-god",
            "name": "编程大神",
            "description": "EN desc",
            "description_zh": "中文描述",
            "downloads": 4171444,
            "stars": 22,
            "version": "1.2.4",
            "namespace": {"canonicalName": "@ake/dev-god", "handle": "ake"},
            "publisher": {"name": "", "certifiedName": "某科技有限公司", "verified": true}
        });
        let m = parse_skill(&sk);
        assert_eq!(m.description, "中文描述");
        assert_eq!(m.publisher, "某科技有限公司");
        assert_eq!(m.downloads, 4_171_444);
        assert_eq!(m.coordinate, "@ake/dev-god");
    }

    #[test]
    fn falls_back_to_generic_description_when_zh_missing() {
        let sk: serde_json::Value = serde_json::json!({
            "slug": "x", "description": "Only EN", "namespace": "n"
        });
        assert_eq!(parse_skill(&sk).description, "Only EN");
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// 真实打 SkillHub 接口，验证 search → download 整条链路。
    /// 默认 #[ignore]（需要网络，不能进 CI）；用 `cargo test --lib -- --ignored live_` 手动跑。
    #[test]
    #[ignore]
    fn live_search_and_download() {
        let page = search("爬虫", "", "all", "score", 1, 5).expect("search failed");
        assert!(page.total > 0, "expected results");
        assert!(!page.skills.is_empty(), "expected at least one skill");
        let first = &page.skills[0];
        println!(
            "found {} total; first = [{}] {} v{} by {} ({} downloads)",
            page.total, first.coordinate, first.name, first.version, first.publisher, first.downloads
        );
        assert!(!first.slug.is_empty());
        assert!(!first.coordinate.is_empty());

        let bytes = download_zip(&first.slug, &first.namespace, &first.version).expect("download failed");
        assert!(bytes.len() > 100, "zip too small: {}", bytes.len());
        // ZIP magic 'PK\x03\x04'
        assert_eq!(&bytes[..4], b"PK\x03\x04", "not a zip archive");
        println!("downloaded {} bytes for {}", bytes.len(), first.coordinate);

        // 必须含 SKILL.md，否则 import_skill_zip 会拒绝
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("unreadable zip");
        let names: Vec<String> = (0..zip.len())
            .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().unwrap_or_default().to_string()))
            .collect();
        assert!(
            names.iter().any(|n| n.ends_with("SKILL.md")),
            "no SKILL.md in archive; entries = {:?}",
            &names[..names.len().min(10)]
        );
        println!("zip has {} entries, SKILL.md present", names.len());
    }

    #[test]
    #[ignore]
    fn live_categories() {
        let cats = categories().expect("categories failed");
        assert!(!cats.is_empty(), "no categories");
        println!("{} categories: {}", cats.len(), cats.iter().map(|c| c.key.as_str()).collect::<Vec<_>>().join(", "));
    }

    #[test]
    #[ignore]
    fn live_404_is_clean_error() {
        let e = download_zip("definitely-not-a-real-skill-xyz-999", "", "").unwrap_err();
        println!("404 error message: {e}");
        assert!(e.contains("不存在") || e.contains("404"), "unhelpful error: {e}");
    }
}
