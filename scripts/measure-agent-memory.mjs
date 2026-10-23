#!/usr/bin/env node
/**
 * 内存账本采样：把「派子代理前后」的占用按组摊开，用来验证到底是谁在吃内存。
 *
 * 归组口径与 OpenChamber 的 resource-monitor 扩展一致（它统计的也是常驻内存）：
 *   - OpenChamber = Electron 主进程及其子进程，按 `--type=` 分 main / renderer / gpu / utility
 *   - opencode    = agent 运行时，所有会话与子代理共用这一个进程
 *   - 终端 job    = 树外的 node/vite 之类（dev server、工具链），按父级聚合成一棵子树
 *   - WebView2    = Tauri 应用（工作台软件）的 webview 一族
 *
 * 用法：
 *   node scripts/measure-agent-memory.mjs                # 打印当前快照
 *   node scripts/measure-agent-memory.mjs --save a.json  # 存一份快照
 *   node scripts/measure-agent-memory.mjs --diff a.json  # 与快照对比（可写在 --save 里一起用：先 diff 再存）
 *
 * 只读 `Get-CimInstance Win32_Process`，不碰任何进程；Windows-only。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** PowerShell 一次拿到整张进程表（含命令行，用来分辨 --type= 与是谁的子进程）。 */
function readProcesses() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress",
  ].join("; ");
  const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 64 * MB,
  });
  const parsed = JSON.parse(raw);
  return parsed.map((row) => ({
    pid: row.ProcessId,
    ppid: row.ParentProcessId,
    name: row.Name ?? "",
    cmd: row.CommandLine ?? "",
    res: Math.round((row.WorkingSetSize ?? 0) / MB),
    priv: Math.round((row.PrivatePageCount ?? 0) / MB),
  }));
}

/** Electron 的进程类型：main 没有 --type=，其余从命令行里读。 */
function electronType(proc) {
  const match = /--type=([a-z-]+)/.exec(proc.cmd);
  return match ? match[1] : "main";
}

/** 一棵子树（含自己）的全部进程。 */
function subtree(procs, rootPid) {
  const byParent = new Map();
  for (const proc of procs) {
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, []);
    byParent.get(proc.ppid).push(proc);
  }
  const out = [];
  const walk = (pid) => {
    for (const child of byParent.get(pid) ?? []) {
      out.push(child);
      walk(child.pid);
    }
  };
  const root = procs.find((proc) => proc.pid === rootPid);
  if (root) out.push(root);
  walk(rootPid);
  return out;
}

/** 命令行里最像一个「这是什么」的那一段（给 job 起名用）。 */
function jobLabel(proc) {
  const cmd = proc.cmd.replace(/^"|"$/g, "");
  const vite = /([\w.-]+)[\\/]\.pnpm[\\/]vite@|node_modules[\\/]vite[\\/]bin/.exec(cmd);
  if (vite) return `vite ${proc.name}`;
  const port = /--port[= ](\d+)/.exec(cmd);
  const tail = cmd.split(/\s+/).slice(0, 3).join(" ");
  return port ? `${tail} … :${port[1]}` : tail.slice(0, 48);
}

function sum(group, key) {
  return group.reduce((total, proc) => total + proc[key], 0);
}

/** 开发/agent 会拉起的东西：只有含这类进程的树才算 job，免得把 QQ、资源管理器、浏览器算进来。 */
const JOB_MEMBER = /^(node|bun|deno|esbuild|vitepress|tsc|cargo|rustc|python|pnpm|npm|npx|yarn)/i;
const NOT_A_JOB = /^(chrome|msedge|firefox|ego|QQ|WeChat)/i;

function snapshot() {
  const procs = readProcesses();
  // 五个组互斥：Electron 本体 / opencode 运行时 / agent 拉起的树 / 其他 node 家族 / Tauri 的 webview
  const electron = procs.filter((proc) => /OpenChamber\.exe$/i.test(proc.name));
  const opencode = procs.filter((proc) => /(^|[\\/])opencode(\.exe)?$/i.test(proc.name));
  const webview = procs.filter((proc) => /msedgewebview2/i.test(proc.name));
  const claimed = new Set([...electron, ...opencode, ...webview].map((proc) => proc.pid));

  const byType = {};
  for (const proc of electron) {
    const type = electronType(proc);
    byType[type] ??= [];
    byType[type].push(proc);
  }

  // agent 拉起的进程：opencode 的整棵子树（不含它自己）——子代理跑的 shell、命令、测试都在这里
  const agentPids = new Set(
    opencode.flatMap((proc) => subtree(procs, proc.pid)).map((proc) => proc.pid),
  );
  const agentProcs = procs.filter((proc) => agentPids.has(proc.pid) && !claimed.has(proc.pid));

  // agent 那堆进程按「opencode 的哪个直接子进程」归档：一行一个被拉起的命令/服务
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const opencodePids = new Set(opencode.map((proc) => proc.pid));
  const agentTrees = new Map();
  for (const proc of agentProcs) {
    let cursor = proc;
    for (let guard = 0; guard < 64; guard += 1) {
      const parent = byPid.get(cursor.ppid);
      if (!parent || opencodePids.has(parent.pid)) break;
      cursor = parent;
    }
    if (!agentTrees.has(cursor.pid)) agentTrees.set(cursor.pid, []);
    agentTrees.get(cursor.pid).push(proc);
  }
  const agentJobs = [...agentTrees.values()]
    .map((tree) => {
      const heaviest = [...tree].sort((a, b) => b.res - a.res)[0];
      return { label: jobLabel(heaviest), res: sum(tree, "res"), priv: sum(tree, "priv"), count: tree.length };
    })
    .sort((a, b) => b.res - a.res);

  // 其余 job：既不是 app、也不是 agent 子树的 node 家族（dev server、工具链）
  const outside = procs.filter((proc) => !claimed.has(proc.pid) && !agentPids.has(proc.pid) && !NOT_A_JOB.test(proc.name));
  const outsidePids = new Set(outside.map((proc) => proc.pid));
  const jobs = outside
    .filter((proc) => !outsidePids.has(proc.ppid))
    .map((proc) => {
      const tree = subtree(procs, proc.pid).filter((member) => outsidePids.has(member.pid));
      const heaviest = [...tree].sort((a, b) => b.res - a.res)[0] ?? proc;
      return { tree, label: jobLabel(heaviest), pid: proc.pid };
    })
    .filter((job) => job.tree.some((member) => JOB_MEMBER.test(member.name)))
    .map((job) => ({
      label: job.label,
      pid: job.pid,
      res: sum(job.tree, "res"),
      priv: sum(job.tree, "priv"),
      count: job.tree.length,
    }))
    .sort((a, b) => b.res - a.res);

  const totalMem = os.totalmem();
  return {
    at: new Date().toISOString(),
    system: {
      ramGB: +(totalMem / GB).toFixed(1),
      freeGB: +(os.freemem() / GB).toFixed(2),
      usedPct: Math.round((1 - os.freemem() / totalMem) * 100),
    },
    app: {
      total: { res: sum(electron, "res"), priv: sum(electron, "priv"), count: electron.length },
      byType: Object.fromEntries(
        Object.entries(byType)
          .map(([type, list]) => [type, { res: sum(list, "res"), priv: sum(list, "priv"), count: list.length }])
          .sort((a, b) => b[1].res - a[1].res),
      ),
    },
    opencode: { res: sum(opencode, "res"), priv: sum(opencode, "priv"), count: opencode.length },
    agent: { res: sum(agentProcs, "res"), priv: sum(agentProcs, "priv"), count: agentProcs.length },
    agentJobs,
    webview: { res: sum(webview, "res"), priv: sum(webview, "priv"), count: webview.length },
    jobs,
  };
}

function row(label, data, indent = "") {
  const res = `${data.res} MB`.padStart(9);
  const priv = `${data.priv} MB`.padStart(10);
  const count = data.count === undefined ? "" : ` ×${data.count}`;
  return `${indent}${label.padEnd(30)}${res}${priv}${count}`;
}

function print(snap) {
  const lines = [];
  lines.push(`系统   RAM ${snap.system.ramGB} GB  可用 ${snap.system.freeGB} GB  已用 ${snap.system.usedPct}%`);
  lines.push(`      ${"常驻".padEnd(26)}${"私有".padStart(10)}`);
  lines.push(row("OpenChamber 合计", snap.app.total));
  for (const [type, data] of Object.entries(snap.app.byType)) lines.push(row(type, data, "  "));
  lines.push(row("opencode（会话/子代理运行时）", snap.opencode));
  lines.push(row("agent 拉起的进程（shell/命令/测试）", snap.agent));
  for (const job of (snap.agentJobs ?? []).slice(0, 5)) lines.push(row(job.label, job, "  "));
  lines.push(row("WebView2（工作台软件）", snap.webview));
  if (snap.jobs.length) {
    lines.push(row("终端 job 合计", {
      res: snap.jobs.reduce((t, job) => t + job.res, 0),
      priv: snap.jobs.reduce((t, job) => t + job.priv, 0),
      count: snap.jobs.length,
    }));
    for (const job of snap.jobs.slice(0, 6)) lines.push(row(job.label, job, "  "));
  }
  const grandRes = snap.app.total.res + snap.opencode.res;
  lines.push("");
  lines.push(`OpenChamber + opencode 合计：${grandRes} MB 常驻（渲染进程 ${snap.app.byType.renderer?.res ?? 0} MB）`);
  return lines.join("\n");
}

function diff(before, after) {
  const delta = (a, b) => {
    const change = b - a;
    const sign = change > 0 ? "+" : "";
    return `${sign}${change} MB`;
  };
  const lines = [];
  lines.push(`对比 ${new Date(before.at).toLocaleTimeString()} → ${new Date(after.at).toLocaleTimeString()}`);
  lines.push("");
  lines.push(`OpenChamber 合计        ${delta(before.app.total.res, after.app.total.res)}  (${before.app.total.res} → ${after.app.total.res} MB)`);
  for (const type of new Set([...Object.keys(before.app.byType), ...Object.keys(after.app.byType)])) {
    const a = before.app.byType[type]?.res ?? 0;
    const b = after.app.byType[type]?.res ?? 0;
    const na = before.app.byType[type]?.count ?? 0;
    const nb = after.app.byType[type]?.count ?? 0;
    lines.push(`  ${type.padEnd(22)}${delta(a, b).padStart(12)}  (${na} → ${nb} 个)`);
  }
  lines.push(`opencode                ${delta(before.opencode.res, after.opencode.res)}  (私有 ${before.opencode.priv} → ${after.opencode.priv} MB)`);
  lines.push(`  agent 拉起的进程      ${delta(before.agent?.res ?? 0, after.agent?.res ?? 0).padStart(12)}  (${before.agent?.count ?? 0} → ${after.agent?.count ?? 0} 个)`);
  lines.push(`WebView2                ${delta(before.webview.res, after.webview.res)}`);
  lines.push(`系统可用内存            ${delta(before.system.freeGB * 1024, after.system.freeGB * 1024)}  (${before.system.freeGB} → ${after.system.freeGB} GB)`);
  return lines.join("\n");
}

const args = process.argv.slice(2);
const diffIndex = args.indexOf("--diff");
const saveIndex = args.indexOf("--save");
const current = snapshot();
if (diffIndex !== -1) {
  const before = JSON.parse(readFileSync(args[diffIndex + 1], "utf8"));
  console.log(diff(before, current));
  if (saveIndex !== -1) writeFileSync(args[saveIndex + 1], JSON.stringify(current, null, 2));
} else {
  console.log(print(current));
  if (saveIndex !== -1) {
    writeFileSync(args[saveIndex + 1], JSON.stringify(current, null, 2));
    console.log(`\n快照已存：${args[saveIndex + 1]}`);
  }
}
