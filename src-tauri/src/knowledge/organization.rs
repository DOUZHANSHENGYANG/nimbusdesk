//! Source-based organization: one canonical note and recoverable, hidden originals.
use super::*;

const JOURNALS: &str = ".workbench/organization";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transaction {
    sources: Vec<OrganizeSource>,
    target: String,
    target_fingerprint: String,
    kind: String,
    capture_ids: Vec<String>,
    complete: bool,
}

fn journal_folders(vault: &Vault) -> Result<Vec<String>> {
    let path = vault.path(JOURNALS)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in fs::read_dir(path).map_err(|e| fail("读取整理记录失败", e))? {
        let entry = entry.map_err(|e| fail("读取整理记录失败", e))?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !id_ok(&id) {
            return Err("整理恢复记录名称不合法".into());
        }
        let folder = format!("{JOURNALS}/{id}");
        if vault.path(&folder)?.is_dir() && vault.path(&format!("{folder}/journal.json"))?.exists()
        {
            result.push(folder);
        }
    }
    result.sort();
    Ok(result)
}

fn load(vault: &Vault, folder: &str) -> Result<Transaction> {
    let transaction: Transaction =
        serde_json::from_str(&vault.text(&format!("{folder}/journal.json"))?)
            .map_err(|e| fail("整理恢复记录损坏", e))?;
    if transaction.sources.is_empty()
        || transaction.sources.len() > 100
        || !archive_path(&transaction.target)
        || !["experience", "recipe", "resource"].contains(&transaction.kind.as_str())
        || transaction.capture_ids.iter().any(|id| !id_ok(id))
    {
        return Err("整理恢复记录内容不合法".into());
    }
    vault.path(&transaction.target)?;
    for source in &transaction.sources {
        if !source.path.ends_with(".md") || source.path.starts_with('.') {
            return Err("整理来源路径不合法".into());
        }
        vault.path(&source.path)?;
    }
    Ok(transaction)
}

fn save(vault: &Vault, folder: &str, transaction: &Transaction) -> Result<()> {
    let relative = format!("{folder}/journal.json");
    let path = vault.path(&relative)?;
    vault.path(&format!("{relative}.tmp"))?;
    vault.path(&format!("{relative}.bak"))?;
    let bytes = serde_json::to_vec_pretty(transaction).map_err(|e| fail("编码整理记录失败", e))?;
    crate::atomic::write_file_atomic(&path.to_string_lossy(), &bytes)
        .map_err(|e| fail("保存整理恢复记录失败", e))
}

fn finish(vault: &Vault, folder: &str, transaction: &mut Transaction) -> Result<()> {
    if transaction.complete {
        return Ok(());
    }
    let output = vault.text(&format!("{folder}/result.bak"))?;
    if fingerprint(output.as_bytes()) != transaction.target_fingerprint {
        return Err("整理暂存内容不完整，原文备份已保留".into());
    }
    // Validate every input before publishing or removing anything. A partially completed
    // retry may have already removed a source, but its verified backup must remain.
    for (index, source) in transaction.sources.iter().enumerate() {
        if fingerprint(
            vault
                .text(&format!("{folder}/source-{index}.bak"))?
                .as_bytes(),
        ) != source.fingerprint
        {
            return Err("整理原文备份不完整，停止恢复".into());
        }
        if vault.path(&source.path)?.exists() {
            let actual = fingerprint(vault.text(&source.path)?.as_bytes());
            if actual != source.fingerprint
                && !(source.path == transaction.target && actual == transaction.target_fingerprint)
            {
                return Err("原始笔记在整理期间已被修改，请保留备份并刷新后重试".into());
            }
        } else if source.path == transaction.target || !vault.path(&transaction.target)?.exists() {
            return Err("整理原文被移走，停止恢复并保留备份".into());
        }
    }
    let target = vault.path(&transaction.target)?;
    if target.exists() {
        let actual = fingerprint(vault.text(&transaction.target)?.as_bytes());
        if actual != transaction.target_fingerprint {
            let same_source = transaction
                .sources
                .iter()
                .any(|s| s.path == transaction.target && s.fingerprint == actual);
            if !same_source {
                return Err("整理目标已存在或被修改，不会覆盖其他笔记".into());
            }
            vault.path(&format!("{}.tmp", transaction.target))?;
            vault.path(&format!("{}.bak", transaction.target))?;
            crate::atomic::write_file_atomic(&target.to_string_lossy(), output.as_bytes())
                .map_err(|e| fail("更新整理笔记失败", e))?;
        }
    } else {
        let parent = transaction.target.rsplit_once('/').ok_or("整理目标无效")?.0;
        vault.mkdir(parent)?;
        let stage = format!("{folder}/publish.tmp");
        let staged = vault.path(&stage)?;
        if staged.exists() {
            if fingerprint(vault.text(&stage)?.as_bytes()) != transaction.target_fingerprint {
                return Err("整理发布暂存文件冲突，已保留原文".into());
            }
        } else {
            new_file(&staged, output.as_bytes())?;
        }
        publish_file(vault, &stage, &transaction.target)?;
    }
    for source in &transaction.sources {
        if source.path != transaction.target && vault.path(&source.path)?.exists() {
            if fingerprint(vault.text(&source.path)?.as_bytes()) != source.fingerprint {
                return Err("原文发布后被修改，两份内容均保留，请人工确认".into());
            }
            fs::remove_file(vault.path(&source.path)?)
                .map_err(|e| fail("整理已保存，清理来源失败（原文备份保留）", e))?;
        }
    }
    for id in &transaction.capture_ids {
        let mut metadata = vault.metadata(id)?;
        metadata.record.note_path = transaction.target.clone();
        metadata.record.archived_path = Some(transaction.target.clone());
        metadata.record.status = "archived".into();
        vault.save_metadata(&metadata)?;
    }
    transaction.complete = true;
    save(vault, folder, transaction)
}

pub(super) fn recover(vault: &Vault) -> Result<()> {
    for folder in journal_folders(vault)? {
        let mut transaction = load(vault, &folder)?;
        finish(vault, &folder, &mut transaction)?;
    }
    Ok(())
}

pub(super) fn mark_completed(vault: &Vault, notes: &mut [KnowledgeNote]) -> Result<()> {
    let mut completed = HashMap::<String, Vec<String>>::new();
    for folder in journal_folders(vault)? {
        let transaction = load(vault, &folder)?;
        if transaction.complete {
            completed
                .entry(transaction.target)
                .or_default()
                .push(transaction.target_fingerprint);
        }
    }
    for note in notes {
        if let Some(tokens) = completed.get(&note.path) {
            note.organized = tokens.contains(&fingerprint(vault.text(&note.path)?.as_bytes()));
        }
    }
    Ok(())
}

fn yaml_error() -> String {
    "原笔记的 YAML 标签或类型使用了暂不支持的复杂写法；请先在 Obsidian 中改为普通文本标签或文本列表，再重新整理。原文尚未改动".into()
}

// This is deliberately a conservative subset, not a YAML deserializer. Unknown
// values are rejected before a journal or destination is created.
fn yaml_commentless(value: &str) -> Result<&str> {
    let bytes = value.as_bytes();
    let mut quote = None;
    let mut index = 0;
    while index < bytes.len() {
        match (quote, bytes[index]) {
            (Some(b'"'), b'\\') => {
                index += 2;
                continue;
            }
            (Some(b'\''), b'\'') if bytes.get(index + 1) == Some(&b'\'') => {
                index += 2;
                continue;
            }
            (Some(active), current) if active == current => quote = None,
            (None, b'\'' | b'"') => quote = Some(bytes[index]),
            (None, b'#') if index == 0 || bytes[index - 1].is_ascii_whitespace() => {
                return Ok(value[..index].trim_end());
            }
            _ => {}
        }
        index += 1;
    }
    if quote.is_some() {
        return Err(yaml_error());
    }
    Ok(value.trim_end())
}

fn yaml_scalar(value: &str) -> Result<String> {
    let value = yaml_commentless(value)?.trim();
    if value.starts_with('"') {
        return serde_json::from_str::<String>(value).map_err(|_| yaml_error());
    }
    if let Some(inner) = value.strip_prefix('\'') {
        let mut result = String::new();
        let mut chars = inner.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    result.push('\'');
                } else if chars.peek().is_none() {
                    return Ok(result);
                } else {
                    return Err(yaml_error());
                }
            } else {
                result.push(ch);
            }
        }
        return Err(yaml_error());
    }
    if value.is_empty()
        || value.starts_with(['[', ']', '{', '}', '&', '*', '!', '|', '>', '?', '@', '`'])
        || value.contains(": ")
        || value.contains(['\'', '"'])
        || [
            "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE", "~",
        ]
        .contains(&value)
        || value.parse::<f64>().is_ok()
    {
        return Err(yaml_error());
    }
    Ok(value.into())
}

fn yaml_inline_tags(value: &str) -> Result<Vec<String>> {
    let value = yaml_commentless(value)?.trim();
    if !value.starts_with('[') {
        return Ok(vec![yaml_scalar(value)?]);
    }
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(value) {
        return Ok(tags);
    }
    let inner = value
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .ok_or_else(yaml_error)?;
    let mut tags = vec![];
    let bytes = inner.as_bytes();
    let mut start = 0;
    let mut index = 0;
    let mut quote = None;
    while index < bytes.len() {
        match (quote, bytes[index]) {
            (Some(b'"'), b'\\') => {
                index += 2;
                continue;
            }
            (Some(b'\''), b'\'') if bytes.get(index + 1) == Some(&b'\'') => {
                index += 2;
                continue;
            }
            (Some(active), current) if active == current => quote = None,
            (None, b'\'' | b'"') => quote = Some(bytes[index]),
            (None, b',') => {
                tags.push(yaml_scalar(&inner[start..index])?);
                start = index + 1;
            }
            (None, b'[' | b']' | b'{' | b'}') => return Err(yaml_error()),
            _ => {}
        }
        index += 1;
    }
    if quote.is_some() {
        return Err(yaml_error());
    }
    if !inner[start..].trim().is_empty() {
        tags.push(yaml_scalar(&inner[start..])?);
    }
    Ok(tags)
}

fn yaml_key(line: &str) -> Result<Option<(String, &str)>> {
    if line.trim().is_empty()
        || line.trim_start().starts_with('#')
        || line.starts_with(char::is_whitespace)
        || line.starts_with('-')
    {
        return Ok(None);
    }
    let bytes = line.as_bytes();
    let mut quote = None;
    let mut index = 0;
    while index < bytes.len() {
        match (quote, bytes[index]) {
            (Some(b'"'), b'\\') => {
                index += 2;
                continue;
            }
            (Some(b'\''), b'\'') if bytes.get(index + 1) == Some(&b'\'') => {
                index += 2;
                continue;
            }
            (Some(active), current) if active == current => quote = None,
            (None, b'\'' | b'"') => quote = Some(bytes[index]),
            (None, b':') => {
                return Ok(Some((
                    yaml_scalar(line[..index].trim())?,
                    &line[index + 1..],
                )));
            }
            _ => {}
        }
        index += 1;
    }
    Err(yaml_error())
}

fn metadata_and_tags(frontmatter: &str, proposed: &[String]) -> Result<String> {
    let mut kept = vec![];
    let mut tags: Vec<String> = vec![];
    let lines: Vec<_> = frontmatter.lines().collect();
    if lines
        .iter()
        .find(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .is_some_and(|l| l.starts_with(char::is_whitespace))
    {
        return Err(yaml_error());
    }
    let mut seen = std::collections::HashSet::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let Some((key, value)) = yaml_key(line)? else {
            kept.push(line);
            index += 1;
            continue;
        };
        if !["tags", "type"].contains(&key.as_str()) {
            kept.push(line);
            index += 1;
            continue;
        }
        if !seen.insert(key.clone()) {
            return Err(yaml_error());
        }
        let value = yaml_commentless(value)?.trim();
        let mut end = index + 1;
        while end < lines.len()
            && (lines[end].trim().is_empty()
                || lines[end].starts_with(char::is_whitespace)
                || lines[end].trim_start().starts_with('-'))
        {
            end += 1;
        }
        if key == "tags" {
            if value.is_empty() {
                for line in &lines[index + 1..end] {
                    let item = line.trim();
                    if item.is_empty() || item.starts_with('#') {
                        continue;
                    }
                    tags.push(yaml_scalar(
                        item.strip_prefix("- ").ok_or_else(yaml_error)?,
                    )?);
                }
            } else {
                tags.extend(yaml_inline_tags(value)?);
                if lines[index + 1..end]
                    .iter()
                    .any(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
                {
                    return Err(yaml_error());
                }
            }
        } else if !value.is_empty() {
            yaml_scalar(value)?;
            if lines[index + 1..end]
                .iter()
                .any(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
            {
                return Err(yaml_error());
            }
        } else if lines[index + 1..end]
            .iter()
            .any(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        {
            return Err(yaml_error());
        }
        index = end;
    }
    tags.extend(proposed.iter().cloned());
    let mut unique = std::collections::HashSet::new();
    tags.retain(|tag| !tag.is_empty() && unique.insert(tag.to_lowercase()));
    Ok(format!(
        "{}\ntags: {}",
        kept.join("\n").trim_end(),
        serde_json::to_string(&tags).expect("tags serialize")
    ))
}

fn transform_prose(
    body: &str,
    mut transform: impl FnMut(&str) -> Result<String>,
) -> Result<String> {
    let mut output = String::new();
    let mut fence: Option<(u8, usize)> = None;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let marker = trimmed.as_bytes().first().copied();
        let count = marker
            .map(|m| trimmed.bytes().take_while(|b| *b == m).count())
            .unwrap_or(0);
        let is_fence = indent <= 3 && matches!(marker, Some(b'`' | b'~')) && count >= 3;
        if let Some((active, minimum)) = fence {
            output.push_str(line);
            if is_fence
                && marker == Some(active)
                && count >= minimum
                && trimmed[count..].trim().is_empty()
            {
                fence = None;
            }
            continue;
        }
        if is_fence {
            fence = Some((marker.expect("fence marker"), count));
            output.push_str(line);
            continue;
        }
        // Indented code is preserved too. Table indentation and list indentation may
        // conservatively skip relocation; changing a code sample would be worse.
        if line.starts_with("    ") || line.starts_with('\t') {
            output.push_str(line);
            continue;
        }
        let mut rest = line;
        while let Some(start) = rest.find('`') {
            output.push_str(&transform(&rest[..start])?);
            rest = &rest[start..];
            let ticks = rest.bytes().take_while(|b| *b == b'`').count();
            let delimiter = "`".repeat(ticks);
            let Some(end) = rest[ticks..].find(&delimiter) else {
                output.push_str(rest);
                rest = "";
                break;
            };
            let end = ticks + end + ticks;
            output.push_str(&rest[..end]);
            rest = &rest[end..];
        }
        output.push_str(&transform(rest)?);
    }
    Ok(output)
}

// Resolve relative inline Markdown destinations against the original note's folder.
// Vault-root WikiLinks remain unchanged. This avoids moving linked assets or altering
// any unmanaged document. Obsidian short-name links keep resolving to the same filename.
fn relocated_links(body: &str, source: &str, target: &str) -> Result<String> {
    transform_prose(body, |prose| relocated_inline_links(prose, source, target))
}

fn relocated_destination(
    destination: &str,
    source_parent: &str,
    target_depth: usize,
) -> Result<String> {
    let trimmed = destination.trim_start();
    let leading = &destination[..destination.len() - trimmed.len()];
    let (path, suffix, angled) = if let Some(inner) = trimmed.strip_prefix('<') {
        let Some(end) = inner.find('>') else {
            return Err(
                "相对链接的尖括号未闭合，请先在 Obsidian 中修正链接后整理；原文尚未改动".into(),
            );
        };
        (&inner[..end], &inner[end + 1..], true)
    } else {
        let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        (&trimmed[..end], &trimmed[end..], false)
    };
    if path.is_empty() || path.starts_with(['#', '/']) || path.contains(':') {
        return Ok(destination.into());
    }
    let title = suffix.trim();
    let safe_title = title.is_empty()
        || (title.starts_with('"')
            && title.ends_with('"')
            && title.len() >= 2
            && !title[1..title.len() - 1].contains('"'))
        || (title.starts_with('\'')
            && title.ends_with('\'')
            && title.len() >= 2
            && !title[1..title.len() - 1].contains('\''));
    if !safe_title || path.contains(['\\', '(', ')', '\n', '\r']) {
        return Err("相对链接使用了暂不支持的空格、转义或标题写法；请在 Obsidian 中用 <路径> 包裹含空格的地址后重新整理，原文尚未改动".into());
    }
    let mut parts: Vec<&str> = source_parent.split('/').filter(|v| !v.is_empty()).collect();
    for part in path.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("相对链接超出知识库，请修正链接后整理".into());
                }
            }
            other => parts.push(other),
        }
    }
    let path = format!("{}{}", "../".repeat(target_depth), parts.join("/"));
    Ok(if angled {
        format!("{leading}<{path}>{suffix}")
    } else {
        format!("{leading}{path}{suffix}")
    })
}

fn relocated_inline_links(body: &str, source: &str, target: &str) -> Result<String> {
    let source_parent = source.rsplit_once('/').map(|v| v.0).unwrap_or("");
    let target_depth = target
        .rsplit_once('/')
        .map(|v| v.0.split('/').count())
        .unwrap_or(0);
    if source_parent == target.rsplit_once('/').map(|v| v.0).unwrap_or("") {
        return Ok(body.into());
    }
    let mut output = String::new();
    let mut rest = body;
    while let Some(start) = rest.find("](") {
        output.push_str(&rest[..start + 2]);
        rest = &rest[start + 2..];
        let Some(end) = rest.find(')') else {
            output.push_str(rest);
            return Ok(output);
        };
        output.push_str(&relocated_destination(
            &rest[..end],
            source_parent,
            target_depth,
        )?);
        output.push(')');
        rest = &rest[end + 1..];
    }
    output.push_str(rest);
    Ok(output)
}

fn relocated_wikilinks(body: &str, source: &str) -> Result<String> {
    transform_prose(body, |prose| relocated_inline_wikilinks(prose, source))
}

fn relocated_inline_wikilinks(body: &str, source: &str) -> Result<String> {
    let parent = source.rsplit_once('/').map(|v| v.0).unwrap_or("");
    let mut output = String::new();
    let mut rest = body;
    while let Some(start) = rest.find("[[") {
        output.push_str(&rest[..start + 2]);
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            output.push_str(rest);
            return Ok(output);
        };
        let destination = &rest[..end];
        if destination.starts_with("./") || destination.starts_with("../") {
            let mut parts: Vec<&str> = parent.split('/').filter(|v| !v.is_empty()).collect();
            for part in destination.split('/') {
                match part {
                    "." | "" => {}
                    ".." => {
                        if parts.pop().is_none() {
                            return Err("WikiLink 超出知识库，请修正后整理".into());
                        }
                    }
                    other => parts.push(other),
                }
            }
            output.push_str(&parts.join("/"));
        } else {
            output.push_str(destination);
        }
        output.push_str("]]");
        rest = &rest[end + 2..];
    }
    output.push_str(rest);
    Ok(output)
}

fn retain_references(
    mut body: String,
    originals: &[String],
    sources: &[OrganizeSource],
    target: &str,
) -> Result<String> {
    let mut missing = vec![];
    for (original, source) in originals.iter().zip(sources) {
        let (_, original_body) = split_frontmatter(original);
        let mut prose = String::new();
        transform_prose(original_body, |segment| {
            prose.push_str(segment);
            Ok(segment.into())
        })?;
        let original_body = relocated_wikilinks(&prose, &source.path)?;
        let mut rest = original_body.as_str();
        while let Some(start) = rest.find("[[") {
            let prefix = if start > 0 && rest.as_bytes()[start - 1] == b'!' {
                "!"
            } else {
                ""
            };
            rest = &rest[start..];
            let Some(end) = rest.find("]]") else {
                break;
            };
            let reference = format!("{prefix}{}", &rest[..end + 2]);
            if !body.contains(&reference) && !missing.contains(&reference) {
                missing.push(reference);
            }
            rest = &rest[end + 2..];
        }
        // Inline image destinations can be omitted by a model; retain them too.
        let original_body = relocated_links(original_body.as_str(), &source.path, target)?;
        let mut rest = original_body.as_str();
        while let Some(start) = rest.find("![") {
            rest = &rest[start..];
            let Some(middle) = rest.find("](") else {
                break;
            };
            let Some(end) = rest[middle + 2..].find(')') else {
                break;
            };
            let end = middle + 2 + end + 1;
            let reference = rest[..end].to_string();
            if !body.contains(&reference) && !missing.contains(&reference) {
                missing.push(reference);
            }
            rest = &rest[end..];
        }
    }
    if !missing.is_empty() {
        body.push_str(&format!("\n\n## 附件与引用\n\n{}", missing.join("\n\n")));
    }
    Ok(body)
}

pub fn organize_with_folders(
    root: &str,
    mut input: OrganizeInput,
    folders: &KnowledgeFolders,
) -> Result<KnowledgeNote> {
    let _guard = WRITES
        .lock()
        .map_err(|_| "知识库写入锁异常，请重启工作台")?;
    let vault = Vault::new(root)?;
    let folders = validate_vault_folders(&vault, folders.clone())?;
    let category = match input.kind.as_str() {
        "experience" => &folders.experience,
        "recipe" => &folders.recipe,
        "resource" => &folders.resource,
        _ => return Err("整理分类不合法".into()),
    };
    if input.sources.len() != 1
        || input.title.trim().is_empty()
        || input.title.len() > 600
        || input.content.len() > 2 * 1024 * 1024
        || input.tags.len() > 50
        || input.tags.iter().any(|tag| tag.len() > 120)
    {
        return Err(
            "每次只支持整理一篇来源笔记，且标题与正文须在大小限制内；多篇材料请分别整理".into(),
        );
    }
    recover(&vault)?;
    input.sources.sort_by(|a, b| a.path.cmp(&b.path));
    input.sources.dedup_by(|a, b| a.path == b.path);
    let identity = fingerprint(
        &serde_json::to_vec(&(&input, &folders)).map_err(|e| fail("编码整理请求失败", e))?,
    );
    let journal_folder = format!("{JOURNALS}/{identity}");
    if vault
        .path(&format!("{journal_folder}/journal.json"))?
        .exists()
    {
        let transaction = load(&vault, &journal_folder)?;
        let content = vault.text(&transaction.target)?;
        if fingerprint(content.as_bytes()) != transaction.target_fingerprint {
            return Err("整理结果已被外部修改，请刷新后重新整理".into());
        }
        let mut note = vault.note(&transaction.target, &content)?;
        note.kind = transaction.kind;
        note.organized = true;
        return Ok(note);
    }
    let mut originals = vec![];
    for source in &input.sources {
        let kind = note_kind(&source.path, &folders);
        if source.path.starts_with('.') || !source.path.ends_with(".md") || kind == "note" {
            return Err("只能整理已绑定管理目录和收件箱内的 Markdown 笔记".into());
        }
        let content = vault.text(&source.path)?;
        if fingerprint(content.as_bytes()) != source.fingerprint {
            return Err("笔记已被外部修改，请刷新后重新整理".into());
        }
        originals.push(content);
    }
    let first = &input.sources[0].path;
    let capture_source = first.starts_with(&format!("{INBOX}/")) && first.ends_with("/条目.md");
    let filename = if capture_source {
        format!("{}.md", safe_name(&input.title))
    } else {
        first
            .rsplit('/')
            .next()
            .ok_or("笔记名称不合法")?
            .to_string()
    };
    let target = if inside(first, category) {
        first.clone()
    } else {
        format!("{category}/{filename}")
    };
    if !archive_path(&target) {
        return Err("整理目标名称不合法".into());
    }
    if vault.path(&target)?.exists() && !input.sources.iter().any(|s| s.path == target) {
        return Err("目标目录已有同名笔记；请先在 Obsidian 中重命名来源笔记或调整目标分类后重试，不会创建重复副本".into());
    }
    let (frontmatter, _) = split_frontmatter(&originals[0]);
    let (_, body) = split_frontmatter(&input.content);
    let body = body.trim_start();
    let body = if body.starts_with("# ") {
        body.split_once('\n')
            .map(|v| v.1)
            .unwrap_or("")
            .trim_start()
    } else {
        body
    };
    let body = relocated_links(body, first, &target)?;
    let body = relocated_wikilinks(&body, first)?;
    let body = retain_references(body, &originals, &input.sources, &target)?;
    let content = format!(
        "---\n{}\ntype: {}\n---\n\n# {}\n\n{}\n",
        metadata_and_tags(frontmatter, &input.tags)?.trim(),
        input.kind,
        input.title.replace(['\r', '\n'], " "),
        body.trim()
    );
    let mut capture_ids = vec![];
    let inbox = vault.path(INBOX)?;
    if inbox.exists() {
        for entry in fs::read_dir(inbox).map_err(|e| fail("读取条目来源失败", e))? {
            let entry = entry.map_err(|e| fail("读取条目来源失败", e))?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if !id_ok(&id) || !vault.path(&format!("{INBOX}/{id}/条目.json"))?.exists() {
                continue;
            }
            if input.sources.iter().any(|s| {
                s.path
                    == vault
                        .metadata(&id)
                        .map(|m| m.record.note_path)
                        .unwrap_or_default()
            }) {
                capture_ids.push(id);
            }
        }
    }
    // No visible note is touched until every original and output has a synced backup.
    vault.mkdir(&journal_folder)?;
    for (index, original) in originals.iter().enumerate() {
        let path = vault.path(&format!("{journal_folder}/source-{index}.bak"))?;
        if path.exists() {
            if fs::read(&path).map_err(|e| fail("读取整理备份失败", e))? != original.as_bytes()
            {
                return Err("整理备份冲突，原文未改动".into());
            }
        } else {
            new_file(&path, original.as_bytes())?;
        }
    }
    let staged = vault.path(&format!("{journal_folder}/result.bak"))?;
    if staged.exists() {
        if fs::read(&staged).map_err(|e| fail("读取整理暂存失败", e))? != content.as_bytes()
        {
            return Err("整理暂存冲突，原文未改动".into());
        }
    } else {
        new_file(&staged, content.as_bytes())?;
    }
    let mut transaction = Transaction {
        sources: input.sources,
        target: target.clone(),
        target_fingerprint: fingerprint(content.as_bytes()),
        kind: input.kind.clone(),
        capture_ids,
        complete: false,
    };
    save(&vault, &journal_folder, &transaction)?;
    finish(&vault, &journal_folder, &mut transaction)?;
    let mut note = vault.note(&target, &content)?;
    note.kind = input.kind;
    note.organized = true;
    Ok(note)
}
