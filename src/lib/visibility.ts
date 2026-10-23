/**
 * 前台门控的轮询。
 *
 * 这个应用有十几个定时轮询：搜索状态、目录映射、项目/禅道的同步检查…窗口最小化或被完全
 * 遮住之后它们仍在跑，每一拍都是一次 IPC —— 白烧 CPU 也白唤磁盘。
 *
 * 注意口径：`document.visibilityState === "hidden"` 表示**这个窗口不可见**（最小化 / 被别的
 * 窗口完全盖住），不是「失焦」。用户切到别的应用但窗口还在屏幕上时仍是 `visible`，
 * 轮询照常 —— 这正是我们想要的：暂停的只是「用户根本看不见」的那种。
 *
 * 有三类轮询**不能**接这个门控，别顺手改：
 *   - 边缘坞/显示器的 2.5 s 轮询：它就是靠轮询感知鼠标贴边的，窗口不可见时最需要它；
 *   - 桌面便签的提醒调度：不可见也必须按时触发；
 *   - GitHub 设备码登录的轮询：用户正是要切到浏览器去授权，此时本窗口不可见。
 */

/** 轮询策略：always = 后台也照常跑；foreground = 只在前台跑。 */
export type PollPolicy = "always" | "foreground";

/** 当前窗口是否在前台可见。非浏览器环境（单测、构建期）一律当作可见。 */
export function isForeground(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/** 这一拍该不该真正干活。 */
export function shouldTick(policy: PollPolicy, foreground: boolean): boolean {
  return policy === "always" || foreground;
}

export interface ForegroundIntervalOptions {
  policy?: PollPolicy;
  /**
   * 回到前台时立刻补一拍。默认 true（数据可能已经过期）。
   * 调用方自己已经挂了 `focus` / `visibilitychange` 监听的就传 false，免得同一件事做两遍。
   */
  catchUp?: boolean;
}

/**
 * 起一个受前台门控的轮询，返回停止函数。
 *
 * 定时器本身不停（保持节奏简单），只是不可见的那些拍子直接跳过；回到前台补一拍，
 * 用户不会看到「刚切回来还是十分钟前的数据」。
 */
export function startForegroundInterval(
  run: () => void,
  ms: number,
  options: ForegroundIntervalOptions = {},
): () => void {
  const policy = options.policy ?? "foreground";
  const catchUp = options.catchUp ?? true;

  const tick = () => {
    if (shouldTick(policy, isForeground())) run();
  };
  const wake = () => {
    if (catchUp && isForeground()) run();
  };

  const timer = setInterval(tick, ms);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  if (typeof window !== "undefined") window.addEventListener("focus", wake);

  return () => {
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
    if (typeof window !== "undefined") window.removeEventListener("focus", wake);
  };
}
