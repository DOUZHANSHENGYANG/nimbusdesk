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

/// 批量安装。逐个下载到临时 ZIP，再交给 `import_skill_zip`（防护一致）。
pub fn install(
    app: &AppH,
    targets: &[InstallTarget],
    overwrite: bool,
) -> Vec<MarketInstallReport> {
    let stamp = crate::ahub::models::now_iso().replace([':', '-', '.'], "");
    targets
        .iter()
        .map(|t| {
            let mut rep = MarketInstallReport {
                slug: t.slug.clone(),
                name: t.name.clone(),
                version: t.version.clone(),
                dir_name: String::new(),
                ok: false,
                error: String::new(),
            };
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
        })
        .collect()
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
