/**
 * 由 src/styles/tokens.css 生成 design-preview.html。
 *
 * 为什么要生成而不是手写：预览页原先**手工抄了一份** token 取值，结果它和
 * 真源各自演化 —— 上一轮把品牌色从靛紫挪到天青蓝后，预览页还留着旧的紫值，
 * 于是「看预览觉得没问题、看应用觉得还是紫」这种自相矛盾就出现了。
 * 只抄一次也会漂移；唯一不漂移的办法是让它从真源派生。
 *
 * 生成物里的所有色卡、色相、对比度都在浏览器里**从计算样式读**，
 * 所以预览页不可能与 tokens.css 不一致。
 *
 * 用法：node scripts/build-preview.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TOKENS = readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8");

/*
 * 把 tokens.css 原样嵌进预览页，只改一处作用域：
 * 真源用 `.dark`（由 <html class="dark"> 切），预览页用 `html[data-theme="dark"]`
 * （双击标题切 data-theme）。除了这个选择器，一个字符都不改。
 */
const scoped = TOKENS.replace(/^\.dark\s*\{/gm, 'html[data-theme="dark"] {');

const html = `<!doctype html>
<html lang="zh" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <title>NimbusDesk · 石墨天青 设计系统</title>
    <style>
/* ══════════════════════════════════════════════════════════════
   本段由 scripts/build-preview.mjs 从 src/styles/tokens.css 生成。
   不要手工编辑 —— 改动会在下次生成时被覆盖，请改 tokens.css。
   ══════════════════════════════════════════════════════════════ */
${scoped}

/* ── 以下是预览页自身的排版，不属于设计系统 ── */
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 32px;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif);
  font-size: var(--pr-text-md);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  transition: background 300ms, color 300ms;
}
h1 { font-size: var(--pr-text-2xl); font-weight: 600; margin: 0 0 4px; letter-spacing: -0.012em; cursor: pointer; user-select: none; }
h2 {
  font-size: var(--pr-text-sm); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--muted-foreground); margin: 40px 0 14px;
}
.sub { color: var(--muted-foreground); font-size: var(--pr-text-base); margin: 0 0 28px; }
.wrap { max-width: 1140px; margin: 0 auto; }
.hint {
  display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: var(--pr-radius-full);
  background: var(--accent); color: var(--accent-foreground);
  font-size: var(--pr-text-xs); font-weight: 600; vertical-align: middle;
}

.swatches { display: flex; flex-wrap: wrap; gap: 6px; }
.sw {
  width: 78px; height: 58px; border-radius: var(--pr-radius-md); position: relative;
  border: 1px solid var(--border); overflow: hidden;
}
.sw span {
  position: absolute; bottom: 3px; left: 5px; font-size: 9px; font-weight: 600;
  font-family: "Cascadia Mono", Consolas, monospace;
}
.sw b {
  position: absolute; top: 3px; right: 5px; font-size: 8px; font-weight: 500;
  font-family: "Cascadia Mono", Consolas, monospace; opacity: .85;
}
.sw-dark span, .sw-dark b { color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.5); }
.sw-light span, .sw-light b { color: #000; text-shadow: 0 1px 2px rgba(255,255,255,.6); }

.grid { display: grid; gap: 14px; }
.g3 { grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); }

.card {
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: var(--pr-radius-lg);
  padding: 18px; transition: background 300ms, border-color 300ms;
  box-shadow: var(--pr-shadow-1);
}
.card h3 { margin: 0 0 12px; font-size: var(--pr-text-md); font-weight: 600; }

.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }

.btn {
  height: var(--pr-h-lg); padding: 0 18px; border-radius: var(--pr-radius-md);
  border: 1px solid transparent; font-size: var(--pr-text-md); font-weight: 500;
  cursor: pointer; display: inline-flex; align-items: center; gap: 8px;
  transition: all 180ms var(--pr-ease-spring);
}
.btn:active { transform: scale(.97); }
.btn-primary { background: var(--primary); color: var(--primary-foreground); }
.btn-primary:hover { filter: brightness(1.08); }
.btn-secondary { background: var(--secondary); color: var(--secondary-foreground); }
.btn-secondary:hover { background: var(--surface-hover); }
.btn-ghost { background: transparent; color: var(--primary); }
.btn-ghost:hover { background: var(--accent); }
.btn-outline { background: transparent; border-color: var(--border); color: var(--foreground); }
.btn-outline:hover { border-color: var(--muted-foreground); }
.btn-sm { height: var(--pr-h-md); padding: 0 12px; font-size: var(--pr-text-sm); }

.input {
  height: var(--pr-h-lg); width: 100%; padding: 0 12px; font-size: var(--pr-text-md);
  background: var(--card); color: var(--foreground);
  border: 1px solid var(--input); border-radius: var(--pr-radius-sm);
  outline: none; transition: box-shadow 180ms, border-color 180ms;
}
.input:focus { border-color: var(--primary); box-shadow: var(--pr-shadow-glow); }
.input::placeholder { color: var(--muted-foreground); }

.sw-toast {
  display: flex; align-items: center; width: 44px; height: 26px; border-radius: var(--pr-radius-full);
  padding: 0 3px; background: var(--muted-foreground); cursor: pointer; transition: background 220ms;
}
.sw-toast.on { background: var(--primary); }
.sw-toast i {
  display: block; width: 20px; height: 20px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
  transition: transform 220ms var(--pr-ease-spring);
}
.sw-toast.on i { transform: translateX(18px); }

.badge {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 9px;
  border-radius: var(--pr-radius-full); font-size: var(--pr-text-xs); font-weight: 600;
}
.b-done { background: var(--primary); color: var(--primary-foreground); }
.b-doing { background: var(--accent); color: var(--accent-foreground); }
.b-todo { background: var(--muted); color: var(--muted-foreground); }
.b-ok { background: color-mix(in oklch, var(--success) 16%, transparent); color: var(--success); }
.b-warn { background: color-mix(in oklch, var(--warning) 18%, transparent); color: var(--warning); }
.b-err { background: color-mix(in oklch, var(--destructive) 16%, transparent); color: var(--destructive); }

table { width: 100%; border-collapse: collapse; font-size: var(--pr-text-sm); }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--muted-foreground); font-weight: 600; font-size: var(--pr-text-xs); text-transform: uppercase; letter-spacing: .05em; }
td.mono, .mono { font-family: "Cascadia Mono", Consolas, monospace; font-size: var(--pr-text-sm); }
.pass { color: var(--success); font-weight: 600; }
.fail { color: var(--destructive); font-weight: 600; }

.files { display: flex; flex-direction: column; gap: 2px; }
.file {
  display: flex; align-items: center; gap: 10px; padding: 7px 9px;
  border-radius: var(--pr-radius-sm); cursor: default; font-size: var(--pr-text-md);
}
.file:hover { background: var(--surface-hover); }
.file em { color: var(--muted-foreground); font-style: normal; font-size: var(--pr-text-xs); margin-left: auto; }
.file .dot { width: 14px; height: 14px; border-radius: 4px; flex: none; }

.sidebar-demo { display: flex; border-radius: var(--pr-radius-lg); overflow: hidden; border: 1px solid var(--border); }
.sidebar-demo nav {
  width: 196px; background: var(--sidebar); color: var(--sidebar-foreground);
  padding: 10px; display: flex; flex-direction: column; gap: 2px;
}
.sidebar-demo nav a {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: var(--pr-radius-sm); color: inherit; text-decoration: none; font-size: var(--pr-text-md);
}
.sidebar-demo nav a.on { background: var(--sidebar-accent); color: var(--sidebar-accent-foreground); font-weight: 600; }
.sidebar-demo nav a:not(.on):hover { background: var(--surface-hover); }
.sidebar-demo .main { flex: 1; background: var(--background); padding: 16px; }
.bar { height: 6px; border-radius: var(--pr-radius-full); background: var(--muted); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--primary); border-radius: var(--pr-radius-full); }

.type-row { display: flex; align-items: baseline; gap: 14px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.type-row b { min-width: 132px; color: var(--muted-foreground); font-size: var(--pr-text-xs); font-weight: 600; }
.type-row:last-child { border-bottom: none; }

.radius-row { display: flex; gap: 12px; align-items: flex-end; }
.radius-box { background: var(--accent); border: 1px solid var(--primary); }

::selection { background: var(--selection); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1 id="title">
        NimbusDesk · 石墨天青<span class="hint">双击标题切换明暗</span>
      </h1>
      <p class="sub">
        品牌天青蓝 H=252（渲染 H≈207°）+ 真无彩中性灰（C=0，色相无意义）。<br />
        文件类型色按<b>渲染后 sRGB 色相</b>分配，落在 352°→186° 单一弧上，265–350° 紫区完全为空。<br />
        色卡标注的「渲染 H」是浏览器实际渲染出的 sRGB 色相 —— 这才是肉眼判定的依据。
      </p>

      <h2>品牌色阶 · 天青蓝</h2>
      <div class="swatches" id="brand"></div>

      <h2>中性灰 · 真无彩（C=0）</h2>
      <div class="swatches" id="gray"></div>

      <h2>状态色 · 浅/深两档</h2>
      <div class="swatches" id="status"></div>

      <h2>文件类型标识色</h2>
      <div class="swatches" id="files"></div>

      <h2>组件预览</h2>
      <div class="grid g3">
        <div class="card">
          <h3>按钮</h3>
          <div class="row">
            <button class="btn btn-primary">主要操作</button>
            <button class="btn btn-secondary">次要</button>
          </div>
          <div class="row" style="margin-top: 10px">
            <button class="btn btn-outline btn-sm">描边</button>
            <button class="btn btn-ghost btn-sm">纯文字</button>
            <button class="btn btn-sm" style="background: color-mix(in oklch, var(--destructive) 14%, transparent); color: var(--destructive)">删除</button>
          </div>
        </div>

        <div class="card">
          <h3>输入框</h3>
          <input class="input" placeholder="输入后回车添加…" />
          <input class="input" style="margin-top: 10px; border-color: var(--primary); box-shadow: var(--pr-shadow-glow)" value="已聚焦" />
        </div>

        <div class="card">
          <h3>开关 / 徽标</h3>
          <div class="row">
            <div class="sw-toast on" id="sw1"><i></i></div>
            <div class="sw-toast" id="sw2"><i></i></div>
          </div>
          <div class="row" style="margin-top: 12px">
            <span class="badge b-done">已完成</span>
            <span class="badge b-doing">进行中</span>
            <span class="badge b-todo">待办</span>
          </div>
          <div class="row" style="margin-top: 8px">
            <span class="badge b-ok">成功</span>
            <span class="badge b-warn">警告</span>
            <span class="badge b-err">危险</span>
          </div>
        </div>

        <div class="card">
          <h3>文件类型图标</h3>
          <div class="files" id="filelist"></div>
        </div>

        <div class="card">
          <h3>进度</h3>
          <div style="display: flex; flex-direction: column; gap: 10px">
            <div class="bar"><i style="width: 72%"></i></div>
            <div class="bar"><i style="width: 38%; background: var(--success)"></i></div>
            <div class="bar"><i style="width: 100%; background: var(--warning)"></i></div>
          </div>
        </div>

        <div class="card">
          <h3>圆角尺度</h3>
          <div class="radius-row">
            <div class="radius-box" style="width: 46px; height: 46px; border-radius: var(--pr-radius-xs)"></div>
            <div class="radius-box" style="width: 46px; height: 46px; border-radius: var(--pr-radius-sm)"></div>
            <div class="radius-box" style="width: 46px; height: 46px; border-radius: var(--pr-radius-md)"></div>
            <div class="radius-box" style="width: 46px; height: 46px; border-radius: var(--pr-radius-lg)"></div>
            <div class="radius-box" style="width: 46px; height: 46px; border-radius: var(--pr-radius-xl)"></div>
            <div class="radius-box" style="width: 46px; height: 46px; border-radius: var(--pr-radius-full)"></div>
          </div>
          <p class="sub" style="margin: 12px 0 0; font-size: var(--pr-text-sm)">
            xs / sm / md / lg / xl / full —— 桌面密度比移动端紧一档，卡片用 lg(12) 不用 16。
          </p>
        </div>

        <div class="card">
          <h3>排版尺度</h3>
          <div class="type-row"><b>2xl · 23 / 600</b><span style="font-size: var(--pr-text-2xl); font-weight: 600">今日计划</span></div>
          <div class="type-row"><b>xl · 19 / 600</b><span style="font-size: var(--pr-text-xl); font-weight: 600">数据与存储</span></div>
          <div class="type-row"><b>lg · 16 / 600</b><span style="font-size: var(--pr-text-lg); font-weight: 600">文件管理</span></div>
          <div class="type-row"><b>md · 14 / 400</b><span>任务标题与说明文字</span></div>
          <div class="type-row"><b>base · 13 / 400</b><span style="font-size: var(--pr-text-base)">密集列表正文</span></div>
          <div class="type-row"><b>sm · 12 / 400</b><span style="font-size: var(--pr-text-sm); color: var(--muted-foreground)">辅助说明、时间戳</span></div>
          <div class="type-row"><b>等宽 12</b><span class="mono">2026-03-10 09:00 – 11:30</span></div>
        </div>
      </div>

      <h2>布局预览 · 侧栏 + 主区</h2>
      <div class="sidebar-demo">
        <nav>
          <a class="on">▦ 主页</a>
          <a>▤ 项目管理</a>
          <a>▥ 计划管理</a>
          <a>▧ 文件管理</a>
          <a>▨ 资讯</a>
          <a style="margin-top: auto">⚙ 设置</a>
        </nav>
        <div class="main">
          <div class="card">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px">
              <b style="font-size: var(--pr-text-lg)">今日计划</b>
              <span class="badge b-doing">3/8 已完成</span>
            </div>
            <div class="bar" style="margin-bottom: 14px"><i style="width: 37%"></i></div>
            <div style="display: flex; flex-direction: column; gap: 6px">
              <div class="file"><span class="dot" style="background: var(--pr-brand-500)"></span>梳理配色 token 层级<span style="margin-left: auto" class="mono">09:00 – 11:30</span></div>
              <div class="file"><span class="dot" style="background: var(--pr-gray-300)"></span>写对比度校验脚本<span style="margin-left: auto" class="mono">14:00 – 15:00</span></div>
              <div class="file"><span class="dot" style="background: var(--pr-gray-300)"></span>文件类型图标收敛到 token</div>
            </div>
          </div>
        </div>
      </div>

      <h2>对比度实测（现场计算，非抄写）</h2>
      <div class="card" style="padding: 6px 14px">
        <table id="ct"></table>
      </div>

      <h2>色相几何</h2>
      <div class="card" style="padding: 6px 14px">
        <table id="hue"></table>
      </div>
    </div>

<script>
  /*
   * 预览页是「查看器」：所有数值都从计算样式读，不在此处复制任何 token。
   * 唯一硬编码的是「哪些变量要展示」以及断言口径。
   * 一致性由这份现场计算 + scripts/check-contrast.mjs 共同保证。
   */
  (function () {
    const root = document.documentElement;

    function vars() {
      const cs = getComputedStyle(root);
      return (name) => cs.getPropertyValue(name).trim();
    }

    /* ── OKLCH → sRGB（用于算渲染色相与对比度）── */
    function toLinear(str) {
      const m = /oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*(?:\\/\\s*([\\d.]+))?\\s*\\)/.exec(str);
      if (!m) return null;
      const L = +m[1], C = +m[2], H = (+m[3] * Math.PI) / 180;
      const a = C * Math.cos(H), b = C * Math.sin(H);
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.291485548 * b;
      return [
        4.0767416621 * l_ ** 3 - 3.3077115913 * m_ ** 3 + 0.2309699292 * s_ ** 3,
        -1.2684380046 * l_ ** 3 + 2.6097574011 * m_ ** 3 - 0.3413193965 * s_ ** 3,
        -0.0041960863 * l_ ** 3 - 0.7034186147 * m_ ** 3 + 1.707614701 * s_ ** 3,
      ];
    }
    const cl = (v) => Math.min(1, Math.max(0, v));
    const enc = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
    const hex = (lin) => "#" + lin.map(enc).map(cl).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    const lum = (lin) => { const c = lin.map(cl); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };

    /* 渲染后色相：人眼看到的色相，与 oklch 第三参数并不相等 */
    function renderedHue(lin) {
      const [r, g, b] = lin.map(enc).map(cl);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d < 1e-9) return -1; // 无彩
      const h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
      return (h + 360) % 360;
    }

    const v = vars();

    /* ── 色卡 ── */
    function swatch(parent, label, cssValue, extra) {
      const lin = toLinear(cssValue);
      const d = document.createElement("div");
      const isDarkColor = lin ? lum(lin) < 0.35 : false;
      d.className = "sw " + (isDarkColor ? "sw-dark" : "sw-light");
      d.style.background = cssValue;
      const hue = lin ? renderedHue(lin) : -1;
      d.innerHTML =
        "<span>" + label + "</span>" +
        (extra || (lin ? "<b>" + (hue < 0 ? "无彩" : hue.toFixed(0) + "°") + "</b>" : ""));
      parent.appendChild(d);
    }

    const BRAND = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const GRAY = [0, 25, 50, 100, 150, 200, 300, 400, 500, 600, 700, 750, 800, 850, 900, 925, 950, 975, 1000];

    function build() {
      /* 品牌与灰阶是主题无关原料，直接读 */
      const bEl = document.getElementById("brand");
      const gEl = document.getElementById("gray");
      const sEl = document.getElementById("status");
      const fEl = document.getElementById("files");
      bEl.innerHTML = gEl.innerHTML = sEl.innerHTML = "";
      BRAND.forEach((k) => swatch(bEl, "--pr-brand-" + k, v("--pr-brand-" + k)));
      GRAY.forEach((k) => swatch(gEl, "--pr-gray-" + k, v("--pr-gray-" + k)));
      [["red", 600], ["red", 400], ["green", 600], ["green", 400],
       ["amber", 600], ["amber", 400], ["blue", 600], ["blue", 400],
      ].forEach(([n, k]) => swatch(sEl, "--pr-" + n + "-" + k, v("--pr-" + n + "-" + k)));
      FILE_KEYS.forEach((k) => swatch(fEl, k, v("--pr-file-" + k), "<b>H</b>"));
      paintFiles();
      buildList();
    }

    /* ── 文件类型：额外标注渲染色相 ── */
    const FILE_KEYS = ["pdf", "slide", "archive", "sheet", "video", "doc", "image", "audio", "misc"];
    function paintFiles() {
      const fEl = document.getElementById("files");
      fEl.innerHTML = "";
      FILE_KEYS.forEach((k) => {
        const css = v("--pr-file-" + k);
        const lin = toLinear(css);
        const d = document.createElement("div");
        const dark = lin ? lum(lin) < 0.35 : false;
        d.className = "sw " + (dark ? "sw-dark" : "sw-light");
        const hue = lin ? renderedHue(lin) : -1;
        d.style.background = css;
        d.innerHTML = "<span>" + k + "</span><b>" + (hue < 0 ? "无彩" : hue.toFixed(0) + "°") + "</b>";
        fEl.appendChild(d);
      });
    }

    const LIST = [
      ["设计稿.pdf", "pdf", "▤"], ["季度汇报.pptx", "slide", "▥"],
      ["归档.zip", "archive", "▣"], ["账目.xlsx", "sheet", "▦"],
      ["会议录像.mp4", "video", "▷"], ["截图.png", "image", "▨"],
      ["会议纪要.docx", "doc", "▤"], ["录音.m4a", "audio", "♫"],
      ["build.rs", "misc", "◇"],
    ];
    function buildList() {
      const listEl = document.getElementById("filelist");
      listEl.innerHTML = "";
      LIST.forEach(([name, key, glyph]) => {
        const d = document.createElement("div");
        d.className = "file";
        d.innerHTML =
          '<span style="color: var(--pr-file-' + key + '); font-size: 15px; width: 16px; text-align: center">' +
          glyph + "</span>" + name + "<em>" + key + "</em>";
        listEl.appendChild(d);
      });
    }

    /* ── 对比度断言（现场算）── */
    const CASES = [
      ["浅色·正文 on 页面底", "--foreground", "--background", 4.5],
      ["浅色·正文 on 卡片", "--card-foreground", "--card", 4.5],
      ["浅色·次要文字 on 页面底", "--muted-foreground", "--background", 4.5],
      ["浅色·次要文字 on 卡片", "--muted-foreground", "--card", 4.5],
      ["浅色·次要文字 on muted 底", "--muted-foreground", "--muted", 4.5],
      ["浅色·主按钮文字", "--primary-foreground", "--primary", 4.5],
      ["浅色·强调文字 on 强调底", "--accent-foreground", "--accent", 4.5],
      ["浅色·侧栏文字", "--sidebar-foreground", "--sidebar", 4.5],
      ["浅色·危险色 on 卡片", "--destructive", "--card", 4.5],
      ["浅色·成功色 on 卡片", "--success", "--card", 4.5],
      ["浅色·警告色 on 卡片", "--warning", "--card", 4.5],
      ["浅色·信息色 on 卡片", "--info", "--card", 4.5],
      ["深色·正文 on 页面底", "--foreground", "--background", 4.5],
      ["深色·正文 on 卡片", "--card-foreground", "--card", 4.5],
      ["深色·次要文字 on 页面底", "--muted-foreground", "--background", 4.5],
      ["深色·次要文字 on muted 底", "--muted-foreground", "--muted", 4.5],
      ["深色·主按钮文字", "--primary-foreground", "--primary", 4.5],
      ["深色·强调文字 on 卡片", "--accent-foreground", "--card", 4.5],
      ["深色·侧栏文字", "--sidebar-foreground", "--sidebar", 4.5],
      ["深色·危险色 on 卡片", "--destructive", "--card", 4.5],
      ["深色·成功色 on 卡片", "--success", "--card", 4.5],
      ["深色·警告色 on 卡片", "--warning", "--card", 4.5],
      ["深色·信息色 on 卡片", "--info", "--card", 4.5],
    ];

    /**
     * 把 oklch(... / alpha) 按 alpha 复合到底色上，返回复合后的 [L,C,H]。
     * 不复合就会把半透明的 --accent 当成不透明来算，得出 2.41:1 这种假失败
     * ——它实际是把 16% 的品牌色当成了 100%。只在 OKLab 的 L/C 上插值，
     * 对对比度的影响 <1%。
     */
    function composite(fgStr, bgStr) {
      const fg = toLinear(fgStr);
      const bg = toLinear(bgStr);
      const m = /oklch\\(\\s*[\\d.]+\\s+[\\d.]+\\s+[\\d.]+\\s*\\/\\s*([\\d.]+)\\s*\\)/.exec(fgStr);
      if (!fg || !m) return fg;
      const alpha = +m[1];
      if (alpha >= 1) return fg;
      // 用 L/C/H 三通道插值（比线性 sRGB 插值更接近浏览器在 OKLab 的行为）
      const bgP = /oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/.exec(bgStr);
      if (!bgP) return fg;
      const L = +bgP[1] * (1 - alpha) + toLinFromStr(fgStr, 0) * alpha;
      const C = +bgP[2] * (1 - alpha) + toLinFromStr(fgStr, 1) * alpha;
      const H = +bgP[3];
      return toLinear("oklch(" + L + " " + C + " " + H + ")");
    }
    function toLinFromStr(str, idx) {
      const m = /oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)/.exec(str);
      return m ? +m[idx + 1] : 0;
    }

    function contrast(fgCss, bgCss) {
      const fg = composite(fgCss, bgCss), bg = toLinear(bgCss);
      if (!fg || !bg) return null;
      const a = lum(fg), b = lum(bg);
      const hi = Math.max(a, b), lo = Math.min(a, b);
      return (hi + 0.05) / (lo + 0.05);
    }

    /*
     * 按指定主题读变量：临时切 data-theme，读完还原。
     * 必须这样做 —— 否则浅色行会读到深色值：第一版就出现过「浅色·强调文字」
     * 显示 2.41:1 的假失败，其实是把 --accent 的 16% alpha 当不透明算的，
     * 而且读的是当前（深色）主题。
     */
    function withTheme(mode, fn) {
      const prev = root.getAttribute("data-theme");
      root.setAttribute("data-theme", mode);
      const cs = getComputedStyle(root);
      const read = (name) => cs.getPropertyValue(name).trim();
      try {
        return fn(read);
      } finally {
        root.setAttribute("data-theme", prev || "dark");
      }
    }

    function buildContrast() {
      const rows = CASES.map(([d, f, b, need]) => {
        const mode = /^深色/.test(d) ? "dark" : "light";
        return withTheme(mode, (read) => [d, read(f), read(b), need]);
      });
      document.getElementById("ct").innerHTML =
        "<tr><th>场景</th><th>前景 → 背景</th><th>对比度</th><th>要求</th><th>结果</th></tr>" +
        rows.map(([d, f, b, need]) => {
          const c = contrast(f, b);
          const ok = c !== null && c >= need;
          return (
            "<tr><td>" + d + '</td><td class="mono" style="font-size:10px">' + hexOf(f) + " → " + hexOf(b) +
            '</td><td class="mono">' + (c === null ? "—" : c.toFixed(2) + ":1") +
            '</td><td class="mono">≥' + need + '</td><td class="' + (ok ? "pass" : "fail") + '">' +
            (c === null ? "解析失败" : ok ? "通过" : "未达标") + "</td></tr>"
          );
        }).join("");
    }

    /** 把任意 oklch 串（含 alpha）显示成 hex，便于肉眼核对 */
    function hexOf(str) {
      const lin = toLinear(str);
      if (!lin) return "—";
      const m = /oklch\\(\\s*[\\d.]+\\s+[\\d.]+\\s+[\\d.]+\\s*\\/\\s*([\\d.]+)\\s*\\)/.exec(str);
      return hex(lin) + (m ? " α" + m[1] : "");
    }

    /* ── 色相几何检查（现场算）── */
    function buildHue() {
      const brandHue = renderedHue(toLinear(v("--pr-brand-600")));
      const PLO = 265, PHI = 350;
      const rows = FILE_KEYS.filter((k) => k !== "misc").map((k) => {
        const lin = toLinear(v("--pr-file-" + k));
        const h = renderedHue(lin);
        const gap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
        const inPurple = h >= PLO && h <= PHI;
        const nearBrand = gap(h, brandHue) < 20;
        return [k, h, hex(lin), inPurple, nearBrand];
      });
      let minSep = 999, pair = "";
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const g = Math.min(d, 360 - d);
          const d = Math.abs(rows[i][1] - rows[j][1]) % 360;
          const g = Math.min(d, 360 - d);
          if (g < minSep) { minSep = g; pair = rows[i][0] + "×" + rows[j][0]; }
        }
      }
      const bad = rows.filter((r) => r[3] || r[4]).length;
      document.getElementById("hue").innerHTML =
        "<tr><th>类型</th><th>渲染色相</th><th>色值</th><th>紫区</th><th>近品牌</th></tr>" +
        rows.map(([k, h, hx, inP, nearB]) =>
          "<tr><td>" + k + '</td><td class="mono">' + h.toFixed(1) + '°</td><td class="mono">' + hx +
          '</td><td class="' + (inP ? "fail" : "pass") + '">' + (inP ? "越界" : "OK") +
          '</td><td class="' + (nearB ? "fail" : "pass") + '">' + (nearB ? "过近" : "OK") + "</td></tr>"
        ).join("") +
        '<tr><td colspan="5" class="' + (bad === 0 ? "pass" : "fail") + '">' +
        "品牌渲染色相 " + brandHue.toFixed(1) + "° ｜ 类别两两最小间距 " + minSep.toFixed(1) + "°（" + pair +
        "）｜ 越界 " + bad + " 项</td></tr>";
    }

    function rebuild() {
      /* 主题切换后 CSS 变量全变，色卡与断言都必须重建 */
      build();
      buildContrast();
      buildHue();
    }

    document.getElementById("title").addEventListener("dblclick", function () {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      rebuild();
    });

    ["sw1", "sw2"].forEach(function (id) {
      document.getElementById(id).addEventListener("click", function (e) {
        e.currentTarget.classList.toggle("on");
      });
    });

    rebuild();
  })();
</script>
  </body>
</html>
`;

/*
 * 允许写到别处：scripts/check-preview-sync.mjs 需要在不改动被校验文件的前提下
 * 重新生成一遍来比对。默认仍然覆盖 design-preview.html。
 */
const OUT = process.env.PREVIEW_OUT || join(ROOT, "design-preview.html");
writeFileSync(OUT, html, "utf8");
console.log(`✓ ${OUT} 已由 tokens.css 生成（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
