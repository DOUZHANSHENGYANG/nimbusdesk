/**
 * MCP 配置 JSON 的统一解析。
 *
 * 各 AI 工具的外层包裹键并不一致，这个模块把它们归一到同一种中间形态，
 * 供「编辑单个服务」与「批量导入」共用 —— 避免两处各写一套导致行为分叉。
 *
 * 依据是本项目 harness.rs 里的 Format 枚举（实际读写过的格式）：
 *   JsonFlat    { "mcpServers": { name: {...} } }   Claude / Cursor / Windsurf / Cline 等
 *   JsonServers { "servers":    { name: {...} } }   VS Code (Copilot MCP)
 *   OpenCode    { "mcp":        { name: {...} } }   OpenCode
 *   无包裹        { name: {...} } 或裸条目 { "command": ... }
 *
 * 条目字段的差异也要吸收：
 *   - command 可能是字符串，也可能是数组（OpenCode 写成 ["npx","-y","pkg"]）
 *   - 环境变量键名可能是 env / environment
 *   - 远端类型的 type 可能是 http / sse / streamableHttp / remote
 */

/** 解析出的单个服务 */
export interface ParsedMcpEntry {
  name: string;
  /** stdio | http | sse | streamableHttp */
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

/** 解析结果：成功条目 + 被跳过的条目说明 */
export interface ParsedMcpConfig {
  entries: ParsedMcpEntry[];
  /** 看起来像配置但无法识别的条目（用于提示，不静默丢弃） */
  skipped: string[];
  /** 识别到的外层包裹键，便于界面告知用户「按哪种格式理解」 */
  wrapper: "mcpServers" | "servers" | "mcp" | "bare" | "none";
}

const REMOTE_TYPES = ["http", "sse", "streamableHttp", "streamable-http", "remote"];

function asRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined) continue;
    out[k] = typeof val === "string" ? val : String(val);
  }
  return out;
}

/** 判断一个对象是否像「单个 MCP 服务条目」 */
function looksLikeEntry(o: Record<string, unknown>): boolean {
  return "command" in o || "url" in o || "type" in o || "serverUrl" in o;
}

/** 把单个条目归一化；无法识别时返回 null */
function normalizeEntry(name: string, raw: unknown): ParsedMcpEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;

  // OpenCode 用 type: local|remote 区分传输方式，需要先映射成实际形态
  const rawType = typeof e.type === "string" ? e.type : "";
  const url = typeof e.url === "string" ? e.url : typeof e.serverUrl === "string" ? e.serverUrl : "";
  const isRemote = !!url || REMOTE_TYPES.includes(rawType);

  // command 可能是字符串或数组：数组形态首元素是命令，其余是参数
  let command = "";
  let args: string[] = [];
  if (typeof e.command === "string") {
    command = e.command;
  } else if (Array.isArray(e.command) && e.command.length) {
    command = String(e.command[0]);
    args = e.command.slice(1).map(String);
  }
  if (Array.isArray(e.args)) {
    // 显式 args 优先于从 command 数组推出的参数
    args = e.args.map(String);
  }

  // type 归一化：local/remote 是 OpenCode 的私有叫法
  let transport: string;
  if (isRemote) {
    transport = rawType && rawType !== "remote" ? rawType : "http";
  } else {
    transport = "stdio";
  }

  // 既没有命令也没有 URL，不认为是有效条目
  if (!isRemote && !command) return null;

  return {
    name,
    transport,
    command: isRemote ? "" : command,
    args: isRemote ? [] : args,
    env: asRecord(e.env ?? e.environment),
    url,
    headers: asRecord(e.headers),
  };
}

/**
 * 解析任意常见形态的 MCP 配置。
 *
 * `fallbackName` 用于「裸条目」（没有外层包裹、也没有键名）时的命名。
 */
export function parseMcpConfig(text: string, fallbackName = "imported-mcp"): ParsedMcpConfig {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entries: [], skipped: [], wrapper: "none" };
  }
  const obj = raw as Record<string, unknown>;
  const skipped: string[] = [];

  // 1) 找出外层包裹键
  const wrappers: Array<"mcpServers" | "servers" | "mcp"> = ["mcpServers", "servers", "mcp"];
  for (const key of wrappers) {
    const inner = obj[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const entries: ParsedMcpEntry[] = [];
      for (const [name, val] of Object.entries(inner as Record<string, unknown>)) {
        const e = normalizeEntry(name, val);
        if (e) entries.push(e);
        else skipped.push(name);
      }
      return { entries, skipped, wrapper: key };
    }
  }

  // 2) 裸条目：{ "command": ... } / { "url": ... }
  if (looksLikeEntry(obj)) {
    const e = normalizeEntry(fallbackName, obj);
    return { entries: e ? [e] : [], skipped: e ? [] : [fallbackName], wrapper: "bare" };
  }

  // 3) 单层名字包裹：{ "context7": { "command": ... } }
  const keys = Object.keys(obj);
  const single =
    keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === "object"
      ? normalizeEntry(keys[0], obj[keys[0]])
      : null;
  if (single) return { entries: [single], skipped: [], wrapper: "bare" };

  // 4) 多条目但无已知包裹键：{ "a": {...}, "b": {...} }
  const entries: ParsedMcpEntry[] = [];
  for (const [name, val] of Object.entries(obj)) {
    const e = normalizeEntry(name, val);
    if (e) entries.push(e);
    else skipped.push(name);
  }
  if (entries.length) return { entries, skipped, wrapper: "bare" };

  return { entries: [], skipped: keys, wrapper: "none" };
}
