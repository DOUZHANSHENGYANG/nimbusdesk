#!/usr/bin/env node
/**
 * 发布闸门：构建 → 体积体检 → 在真实产物与夹具上跑浏览器回归。
 *
 * 为什么需要它：`npm run verify` 是本地快闸（纯单测 + 类型 + i18n，不构建、不起服务），
 * 而这一轮反复出问题的几处（首屏分包体积、窗口不可见时轮询是否停、长列表分片与深链、
 * 搜索窗的批加载与跨批滚动）只有把真产物/真夹具跑起来才验得到。此前它们是手动闸门，
 * 全靠人记得跑 —— 于是「批加载把列表拽回选中项」「跨批导航不滚动」这类回退连续两轮没被拦住。
 *
 * 两个阶段，服务端口不同：
 *   - 构建产物（`vite preview`，4179）：check:split、check:visibility
 *     —— 它们断言的是「懒加载边界」和「轮询门控」，必须在打包后的 bundle 上验；
 *   - 开发服务（`vite`，17800）：check:files-list、check:search-window、check:modal
 *     —— 它们加载各 feature 目录下的 `fixtures/page.html`（夹具只在 dev 下由 Vite 现场转换），
 *     而夹具是「真组件 + mock 原生 IPC」的那套，改动最多的正是它们。
 *
 * 已经开着的服务会**复用而不是杀掉**（开发时 17800 通常有人在用），只清理自己起的。
 *
 * 用法：`npm run verify:dist`
 *   PLAYWRIGHT_MODULE=…/playwright/index.mjs   浏览器检查需要（没有则由脚本自行解析）
 *   VERIFY_SKIP_DEV=1                          只验产物阶段（跳过三个夹具检查）
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PREVIEW_PORT = 4179;
const DEV_PORT = 17800;
const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`;
const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}`;

const results = [];
const started = [];

/** 每次跑完 / 中途异常都要回收自己起的服务，别留下占端口的孤儿进程。 */
function stopServer(server) {
  if (!server || server.exited) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-server.pid, "SIGTERM");
    }
  } catch {
    // 已经退了就算了
  }
}

function startServer(label, command, args, origin) {
  const child = spawn(command, args, {
    stdio: "ignore",
    shell: process.platform === "win32",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const server = { label, pid: child.pid, exited: false, origin };
  child.on("exit", () => {
    server.exited = true;
  });
  started.push(server);
  return server;
}

/** 轮询直到服务返回 200；已在跑的立刻返回 true。 */
async function waitForServer(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function isUp(origin) {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** 跑一个命令，成功只留一行，失败把输出整段打出来。 */
function run(label, command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
      env: { ...process.env, ...options.env },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (code) => {
      const ok = code === 0;
      results.push({ label, ok });
      if (ok) {
        const last = output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
        console.log(`  ✓ ${label}${last ? ` — ${last.slice(0, 100)}` : ""}`);
      } else {
        console.log(`  ✗ ${label}（exit ${code}）`);
        console.log(output.trim().split(/\r?\n/).map((line) => `      ${line}`).join("\n"));
      }
      resolve(ok);
    });
  });
}

async function main() {
  const skipDev = process.env.VERIFY_SKIP_DEV === "1";

  console.log("① 构建");
  if (!(await run("build", "npm", ["run", "build"]))) return false;

  console.log("② 体积体检（产物）");
  if (!existsSync("dist/index.html")) {
    console.log("  ✗ dist/index.html 不存在");
    results.push({ label: "check:bundle", ok: false });
    return false;
  }
  if (!(await run("check:bundle", process.execPath, ["scripts/check-bundle.mjs"]))) return false;

  console.log(`③ 构建产物上的浏览器回归（${PREVIEW_ORIGIN}）`);
  let preview = null;
  if (await isUp(PREVIEW_ORIGIN)) {
    console.log("  复用已经在跑的 preview");
  } else {
    preview = startServer("preview", "npx", ["vite", "preview", "--port", String(PREVIEW_PORT), "--strictPort"], PREVIEW_ORIGIN);
    if (!(await waitForServer(PREVIEW_ORIGIN, 45_000))) {
      console.log("  ✗ preview 没起来（端口被占？）");
      results.push({ label: "preview", ok: false });
      return false;
    }
  }
  const origin = { FIXTURE_ORIGIN: PREVIEW_ORIGIN };
  let ok = await run("check:split", process.execPath, ["scripts/check-split-browser.mjs"], { env: origin });
  ok = (await run("check:visibility", process.execPath, ["scripts/check-visibility-browser.mjs"], { env: origin })) && ok;
  if (preview) stopServer(preview);

  if (skipDev) {
    console.log("④ 夹具回归：跳过（VERIFY_SKIP_DEV=1）");
    return ok;
  }

  console.log(`④ 夹具上的浏览器回归（${DEV_ORIGIN}）`);
  let dev = null;
  if (await isUp(DEV_ORIGIN)) {
    console.log("  复用已经在跑的 dev server");
  } else {
    dev = startServer("dev", "npx", ["vite", "--port", String(DEV_PORT), "--strictPort"], DEV_ORIGIN);
    if (!(await waitForServer(DEV_ORIGIN, 120_000))) {
      console.log("  ✗ dev server 没起来");
      results.push({ label: "dev", ok: false });
      return false;
    }
  }
  const devOrigin = { FIXTURE_ORIGIN: DEV_ORIGIN };
  ok = (await run("check:files-list", process.execPath, ["scripts/check-files-list-browser.mjs"], { env: devOrigin })) && ok;
  ok = (await run("check:search-window", process.execPath, ["scripts/check-search-window-browser.mjs"], { env: devOrigin })) && ok;
  ok = (await run("check:modal", process.execPath, ["scripts/check-modal-browser.mjs"], { env: devOrigin })) && ok;
  if (dev) stopServer(dev);

  return ok;
}

let passed = false;
try {
  passed = await main();
} finally {
  for (const server of started) stopServer(server);
  const failures = results.filter((item) => !item.ok);
  console.log("");
  console.log(`闸门：${results.filter((item) => item.ok).length} 项通过${failures.length ? `，${failures.length} 项失败（${failures.map((item) => item.label).join(", ")}）` : ""}`);
  if (!passed || failures.length) process.exitCode = 1;
}
