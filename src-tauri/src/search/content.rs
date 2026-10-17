use super::{SearchDocument, SearchHit};
use rusqlite::{Connection, params};
use std::{collections::BTreeSet, path::Path, time::Duration};

pub struct ContentIndex(Connection);
type Result<T> = std::result::Result<T, String>;

impl ContentIndex {
    pub fn open(root: &Path) -> Result<Self> {
        let directory = root.join("modules/search");
        crate::database::reject_link_components(&directory)?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join("index.sqlite3");
        crate::database::reject_link_components(&path)?;
        Self::init(Connection::open(path).map_err(|e| e.to_string())?)
    }
    #[cfg(test)]
    pub fn memory() -> Result<Self> {
        Self::init(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }
    fn init(connection: Connection) -> Result<Self> {
        connection
            .busy_timeout(Duration::from_millis(1500))
            .map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,hit TEXT NOT NULL,normalized TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS search_terms USING fts5(tokens); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e|e.to_string())?;
        let has_pinyin = connection
            .prepare("PRAGMA table_info(documents)")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(std::result::Result::ok)
            .any(|column| column == "pinyin");
        if !has_pinyin {
            connection
                .execute_batch("ALTER TABLE documents ADD COLUMN pinyin TEXT NOT NULL DEFAULT ''")
                .map_err(|e| e.to_string())?;
        }
        Ok(Self(connection))
    }
    pub fn count(&self) -> Result<u64> {
        self.0
            .query_row("SELECT count(*) FROM documents", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }
    pub fn stamp(&self) -> Option<String> {
        self.0
            .query_row("SELECT value FROM metadata WHERE key='stamp'", [], |r| {
                r.get(0)
            })
            .ok()
    }
    pub fn set_stamp(&self, stamp: &str) -> Result<()> {
        self.0
            .execute(
                "INSERT OR REPLACE INTO metadata VALUES('stamp',?1)",
                [stamp],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn replace(&mut self, documents: &[SearchDocument]) -> Result<()> {
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch("DELETE FROM documents; DELETE FROM search_terms;")
            .map_err(|e| e.to_string())?;
        for document in documents {
            let normalized = format!(
                "{}\n{}\n{}",
                document.hit.title, document.hit.subtitle, document.body
            )
            .to_lowercase();
            let json = serde_json::to_string(&document.hit).map_err(|e| e.to_string())?;
            let pinyin = super::pinyin::keys(&document.hit.title);
            tx.execute(
                "INSERT INTO documents(id,kind,hit,normalized,pinyin) VALUES(?1,?2,?3,?4,?5)",
                params![document.hit.id, document.hit.kind, json, normalized, pinyin],
            )
            .map_err(|e| e.to_string())?;
            let rowid = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO search_terms(rowid,tokens) VALUES(?1,?2)",
                params![rowid, grams(&format!("{normalized}\n{pinyin}")).join(" ")],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn query(&self, query: &str, scope: &str, limit: usize) -> Result<Vec<SearchHit>> {
        self.query_with_pinyin(query, scope, limit, true)
    }
    pub fn query_with_pinyin(
        &self,
        query: &str,
        scope: &str,
        limit: usize,
        pinyin_enabled: bool,
    ) -> Result<Vec<SearchHit>> {
        if query.trim().is_empty() || limit == 0 {
            return Ok(vec![]);
        }
        let branches = parse(query);
        if branches.is_empty() {
            return Ok(vec![]);
        }
        // Character-token candidates work for one/two Chinese characters too;
        // literal verification rejects reordered or non-contiguous candidates.
        let expressions: Vec<_> = branches
            .iter()
            .map(|terms| {
                terms
                    .iter()
                    .filter(|(_, negative)| !*negative)
                    .flat_map(|(word, _)| grams(word))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join(" AND ")
            })
            .collect();
        let narrowed = expressions.iter().all(|s| !s.is_empty());
        let rows: Vec<(String, String, String)> = if narrowed {
            let expression = expressions
                .iter()
                .map(|s| format!("({s})"))
                .collect::<Vec<_>>()
                .join(" OR ");
            let mut statement=self.0.prepare("SELECT d.hit,d.normalized,d.pinyin FROM documents d JOIN search_terms f ON f.rowid=d.rowid WHERE search_terms MATCH ?1 AND (?2='all' OR d.kind=?2) LIMIT 20000").map_err(|e|e.to_string())?;
            statement
                .query_map(params![expression, scope], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<_, _>>()
                .map_err(|e| e.to_string())?
        } else {
            let mut statement = self
                .0
                .prepare(
                    "SELECT hit,normalized,pinyin FROM documents WHERE (?1='all' OR kind=?1) LIMIT 20000",
                )
                .map_err(|e| e.to_string())?;
            statement
                .query_map([scope], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<_, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut hits = vec![];
        for (json, text, pinyin) in rows {
            if !branches.iter().any(|terms| {
                terms.iter().all(|(word, negative)| {
                    (text.contains(word)
                        || (pinyin_enabled && super::pinyin::matches(&pinyin, word)))
                        != *negative
                })
            }) {
                continue;
            }
            let mut hit: SearchHit = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            let title = hit.title.to_lowercase();
            hit.score = branches
                .iter()
                .map(|terms| {
                    terms
                        .iter()
                        .filter(|(_, negative)| !*negative)
                        .map(|(word, _)| {
                            if title == *word {
                                1000.0
                            } else if title.starts_with(word) {
                                800.0
                            } else if title.contains(word) {
                                600.0
                            } else if pinyin_enabled && super::pinyin::matches(&pinyin, word) {
                                250.0
                            } else {
                                50.0
                            }
                        })
                        .sum::<f64>()
                })
                .fold(0.0, f64::max);
            let needle = branches
                .iter()
                .flatten()
                .find(|(_, n)| !*n)
                .map(|(w, _)| w.as_str())
                .unwrap_or("");
            hit.snippet = snippet(&text, needle);
            hits.push(hit);
        }
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(a.title.cmp(&b.title))
                .then(a.id.cmp(&b.id))
        });
        hits.truncate(limit.min(100));
        Ok(hits)
    }
}

pub(super) fn grams(text: &str) -> Vec<String> {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .map(|c| format!("u{:x}", c as u32))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
pub(super) fn parse(query: &str) -> Vec<Vec<(String, bool)>> {
    let mut branches = vec![vec![]];
    let mut token = String::new();
    let mut quoted = false;
    let push = |token: &mut String, branch: &mut Vec<(String, bool)>| {
        if token.is_empty() {
            return;
        }
        let negative = token.starts_with('!');
        let word = token.trim_start_matches('!').to_lowercase();
        if !word.is_empty() {
            branch.push((word, negative));
        }
        token.clear();
    };
    for c in query.chars().take(512) {
        if c == '"' {
            quoted = !quoted;
        } else if !quoted && (c.is_whitespace() || c == '|') {
            push(&mut token, branches.last_mut().unwrap());
            if c == '|' {
                branches.push(vec![]);
            }
        } else {
            token.push(c);
        }
    }
    push(&mut token, branches.last_mut().unwrap());
    branches.retain(|b| !b.is_empty());
    branches
}
pub fn snippet(text: &str, needle: &str) -> String {
    let offset = text
        .find(needle)
        .map(|i| text[..i].chars().count().saturating_sub(24))
        .unwrap_or(0);
    let value: String = text.chars().skip(offset).take(150).collect();
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod pinyin_tests {
    use super::*;
    #[test]
    fn business_titles_support_pinyin_but_original_matches_rank_first() {
        let mut index = ContentIndex::memory().unwrap();
        let document = |id: &str, title: &str| SearchDocument {
            hit: SearchHit {
                id: id.into(),
                kind: "plan".into(),
                title: title.into(),
                subtitle: String::new(),
                snippet: String::new(),
                path: None,
                url: None,
                route: None,
                score: 0.0,
            },
            body: "正文不建立拼音索引".into(),
        };
        index
            .replace(&[
                document("chinese", "文档API"),
                document("literal", "wendangapi"),
            ])
            .unwrap();
        let hits = index.query("wendangapi", "all", 10).unwrap();
        assert_eq!(
            hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
            vec!["literal", "chinese"]
        );
        assert_eq!(index.query("wdapi", "all", 10).unwrap().len(), 1);
        assert_eq!(
            index
                .query_with_pinyin("wendangapi", "all", 10, false)
                .unwrap()
                .len(),
            1
        );
        assert!(index.query("zhengwen", "all", 10).unwrap().is_empty());
    }
}
