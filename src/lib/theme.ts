export type ThemeMode = "light" | "dark";
/*
 * 应用主题类到 <html>，并同步 <meta name="theme-color">。
 *
 * theme-color 从**计算样式**读，不在这里写死 hex：
 * 写死就必然与 tokens.css 漂移（上一版就是 #07090c/#f3f4f6 两个过时值）。
 * 注意 html 背景由 index.css 的 `html { background: var(--color-background) }`
 * 提供 —— index.html 里那层 #0c0c0c 只是首帧防闪，随后被 token 覆盖。
 */
export function applyTheme(mode: ThemeMode) {
  document.documentElement.classList.toggle("dark", mode === "dark");
  const bg = getComputedStyle(document.documentElement).backgroundColor;
  if (bg && bg !== "rgba(0, 0, 0, 0)") {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  }
}

let switching = false;

/** 主题切换动画进行中（SettingsSync 据此冻结 applyTheme，真实切换由动画在正确时机执行） */
export function isThemeSwitching(): boolean {
  return switching;
}

/**
 * 径向主题切换：
 * - 首选 View Transitions（新旧两份真实界面快照：圈内新主题内容、圈外旧主题内容，
 *   文字图标全程可见）。此前 VT"不工作"的真因是 store effect 提前切主题污染了旧快照，
 *   时序冻结修复后恢复使用。
 * - 运行时无 VT 时回退 GSAP 纯色羽化幕布（内容会被纯色遮盖，仅保证动效存在）。
 */
export function toggleThemeRadial(target: ThemeMode, x?: number, y?: number) {
  if (switching) return;
  switching = true;

  const px = x ?? window.innerWidth / 2;
  const py = y ?? window.innerHeight / 2;
  const R =
    Math.hypot(Math.max(px, window.innerWidth - px), Math.max(py, window.innerHeight - py)) + 48;

  const supportsVT =
    typeof (document as { startViewTransition?: unknown }).startViewTransition === "function";

  if (supportsVT) {
    const root = document.documentElement;
    root.style.setProperty("--vt-x", `${px}px`);
    root.style.setProperty("--vt-y", `${py}px`);
    root.style.setProperty("--vt-r", `${R}px`);
    root.dataset.vt = target === "dark" ? "out" : "in";

    const vt = document.startViewTransition(() => applyTheme(target));
    vt.finished
      .catch(() => undefined)
      .finally(() => {
        delete root.dataset.vt;
        root.style.removeProperty("--vt-x");
        root.style.removeProperty("--vt-y");
        root.style.removeProperty("--vt-r");
        switching = false;
      });
    return;
  }

  /* ── 兜底：GSAP 羽化幕布（无 VT 的运行时）── */
  const FEATHER = 64;
  const RR = R + FEATHER + 16;

  const sheet = document.createElement("div");
  sheet.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483000",
    "pointer-events:none",
    `--x:${px}px`,
    `--y:${py}px`,
    "--r:0px",
    `background:radial-gradient(circle var(--r) at var(--x) var(--y), ${themeBg(target)} 0%, ${themeBg(target)} calc(var(--r) - ${FEATHER}px), transparent var(--r))`,
  ].join(";");
  document.body.appendChild(sheet);

  const isExpand = target === "dark";
  if (!isExpand) applyTheme(target); // 收拢方向：真实主题先切，被暗幕盖住

  const proxy = { r: isExpand ? 0 : RR };
  const setR = () => sheet.style.setProperty("--r", `${proxy.r}px`);

  /*
   * GSAP 在这里**按需**拉取：主题切换的首选路径是 View Transitions（WebView2 支持），
   * 这段羽化幕布只是无 VT 运行时的兜底。为了它把 69 KB 的 gsap 常驻进每个窗口不值得 ——
   * 真走到兜底分支时再加载，代价是动画起点晚十几毫秒（幕布此刻还是 r=0，肉眼看不出来）。
   */
  void (async () => {
    let gsap: typeof import("@/lib/gsap").gsap;
    try {
      ({ gsap } = await import("@/lib/gsap"));
    } catch {
      sheet.remove();
      switching = false;
      applyTheme(target);
      return;
    }

    gsap.to(proxy, {
      r: isExpand ? RR : 0,
      duration: isExpand ? 0.56 : 0.48,
      ease: "power3.inOut",
      onUpdate: setR,
      onComplete: () => {
        const done = () => {
          sheet.remove();
          switching = false;
        };
        if (isExpand) {
          applyTheme(target);
          gsap.delayedCall(0.06, done);
        } else {
          done();
        }
      },
    });
  })();
}

/** 读取目标主题的页面底色（临时切类读计算样式，随即还原，始终与 token 同步） */
function themeBg(mode: ThemeMode): string {
  const root = document.documentElement;
  const wasDark = root.classList.contains("dark");
  root.classList.toggle("dark", mode === "dark");
  const bg = getComputedStyle(root).backgroundColor;
  root.classList.toggle("dark", wasDark);
  // 兜底取 tokens.css 的 --pr-gray-950 / --pr-gray-50，避免计算样式取不到时返回透明
  return bg && bg !== "rgba(0, 0, 0, 0)" ? bg : mode === "dark" ? "#0c0c0c" : "#f4f4f4";
}
