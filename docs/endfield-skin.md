# 终末地纸本 · 界面风格（endfield skin）

设置 › 外观 › 界面风格 里第三张卡：`终末地 纸本`。切换后 `<html data-skin="endfield">`，
样式全在 `src/styles/endfield-skin.css`，组件层不写死颜色。

## 两套模式

| 模式 | 读法 | 底色 | 黄怎么用 |
| --- | --- | --- | --- |
| 浅色 | 纸本（官网风） | `#f4f4f2` 纸 + `#161616` 墨 | **只做填充**：当前项刻度、选中行、悬停灌满。黄字在纸上 1.1:1，不可见 |
| 深色 | 炭黑 HUD（游戏内） | `#191919` + `#ededed` | 可填充也可做线：`--trace` 在深色下就是黄 |

「标出当前位置的线」一律读 `var(--trace)`，不要在组件里判断主题 —— 两套模式的黄色方向是相反的。

## 三条规则

1. **黄不占品牌位。** 浅色品牌是墨、深色品牌是**纸白**；黄永远单独走 `--signal` / `--trace`。
   踩过的坑：深色把品牌设成黄之后，导航选中块变成芥末黄、分区标签全是黄字 ——
   那是「黄色铺屏」，不是「黄色做信号」。
   另一个原因是对比度脚本：`scripts/check-contrast.mjs` 要求文件类型色距品牌色相 ≥20°，
   品牌挪到黄（H≈100）会让 sheet / video / doc 越界，`npm run verify` 直接红。
2. **暖色只进材质层。** `--pr-gray-*` 的 C=0 契约不动，纸的暖灰写在 `--pr-mat-*`。
3. **不做玻璃。** `--pr-glass-blur: 0`，玻璃三件套退成实底 —— 纸和毛玻璃是两种材质语言。

## 新增 token

| token | 用途 |
| --- | --- |
| `--signal` / `--on-signal` | 唯一强调色与它上面的字 |
| `--trace` | 当前位置的线（导航刻度、取景框、焦点环、选中态、滚动条悬停） |
| `--ef-ease` / `--ef-snap` / `--ef-mech` | 三条曲线：普通 / 出现后稳住 / 慢起硬停 |
| `--ef-tri-1` / `--ef-tri-3` | 色标两端的品红与薄荷（中间一格就是 `--signal`） |
| `--ef-contour` | 侧栏等高线，墨 5.5%（深色 5%） |

## 装饰

| 件 | 位置 | 分寸 |
| --- | --- | --- |
| 色标 | **只在开屏底部** | 品红 / 黄 / 薄荷 / 墨四段。压到 44px 标题栏上就是四色杂讯 —— 窗口顶边不放 |
| 等高线 | 侧栏背景 | 间隔 60px、墨 5.5%。铺满内容面就成噪点（两张 repeating-radial 会叠成斜网纹），所以只在窄侧栏里当肌理 |
| 括线与刻度 | 内容面四角 + 右缘 | 1px、透明度 0.35，纯取景不发光 |

「不抢戏」是这套风格的第一原则：装饰件单独看都成立，同时上满就变成杂音。

## HUD 取景框

`.app-main::before`（上两角）与 `::after`（下两角 + 右缘刻度）纯 CSS 绘制，锚在**内容列**
而不是窗口，所以侧栏收起、窗口缩放都不用重算，没有 JS。线宽 1px、透明度 0.35，
只在内容面上取景，不压到标题栏。

## 控件

- 浮层（弹窗 / 菜单 / 下拉 / 命令面板 / 提示）：直角 + 1px 线 + 一层短影，`backdrop-filter: none`；
- 页签：底边 1px，选中是 2px 黄下划线；
- 开关 / 复选 / 滑块 / 进度：全部直角，选中态读 `--trace`；
- 焦点环：`:focus-visible` 统一 2px `--trace`；输入框例外（用内阴影，避免和黄底打架）；
- 代码块、对话气泡：方角 + 1px 线；
- 表格行悬停只换底色，不整行位移（宽表里位移会抖）。

## 开屏

`src/components/shell/endfield-splash.tsx`，1.2 秒：测量网格 → 扫描光带 → 字标擦入 → 淡出。

- 只在 `endfield` skin 下挂载，**会话内只演一次**，切主题时会重演；
- 点击或按键立即结束（这一层只是氛围，不挡任何操作）；
- `prefers-reduced-motion` 下根本不挂载；CSS 那边也留了一道 `display: none` 兜底。

## 动效

- 卡片入场 `ef-rise`：6px 上移，320ms `--ef-snap`。**不带透明度** —— 后台窗口被节流时
  动画不播完，`opacity:0` 会让整页内容不可见，位移停在原处最多是「没动」；
- 取景框入场 `ef-frame-in`：480ms，从 0.985 缩放到 1；
- 导航左缘刻度：`scaleY(0→1)` 220ms `--ef-mech`；
- 按钮悬停：墨色灌满信号黄，不加位移缩放；
- 开屏：网格淡入 380ms、扫描带 820ms、字标擦入 560ms；
- `prefers-reduced-motion: reduce` 下全部关闭。

## 验证

```powershell
npm run verify          # i18n / 对比度 / 预览同步 / tsc / 单测
npm run tauri dev       # 真窗口里切三张风格卡，重点看：
```

1. 切到 endfield 后 **侧栏与内容面之间只有 1px 线**，没有浮起阴影；
2. 所有圆角消失，但状态点、头像、加载圈仍是圆的；
3. 浅色下任意位置的黄字都不存在（只有黄块 + 墨字）；
4. 深色下只有三处是黄：导航左缘刻度、取景框括线、焦点环与选中态；
5. 窗口顶边是干净的一条（**不该有色标**），侧栏能看到等高线；
6. 系统开启「减少动态效果」后不再有入场动画、开屏完全不出现。

不启动 Tauri 也能看：夹具带 `?skin=` 参数，直接开
`http://127.0.0.1:17800/src/features/files/fixtures/page.html?theme=light&skin=endfield#/tools/files`
（换 `theme=dark` 看炭黑）。

对比度实测：纸 `#f4f4f2` 上墨 16.43:1、次墨 6.07:1、黄块上墨 16.31:1；深色 `#191919` 上
`#ededed` 15.02:1、`#a3a3a3` 6.97:1、`#fffa00` 14.34:1；成功 / 警告 / 信息 / 危险四色
在各自底色上 6.25–9.25:1。

截图：

- `docs/screenshots/endfield-paper.jpg` —— 浅色纸本
- `docs/screenshots/endfield-charcoal.jpg` —— 深色炭黑
- `docs/screenshots/endfield-splash.jpg` —— 开屏（左右浅色 / 深色，底色标只在这里）
- `docs/screenshots/endfield-real-window.png` —— **真机窗口**（CDP 截的原生画面，见
  `tauri-window-debug` skill）；频道条、侧栏眉标与编号都在真 IPC 下确认过

## 已知边界

- **字体**：`--font-sans` 首选 `Saira`（OFL，宽体几何），本机没装就落到系统字体栈。
  `@fontsource-variable/saira` 没装进依赖（`npm install` 在这台机器上超时），所以宽体
  目前只靠字重与字距近似。要完全一致：`npm i @fontsource-variable/saira` 后加一行
  `@import "@fontsource-variable/saira/standard.css";` 到 `src/index.css`。
- **不用游戏官方字体**：`EndfieldByButan` 是 CC BY-NC，二创不可商用。
- **切角**：按钮没有做 7px 切角。`clip-path` 会把键盘焦点环一起裁掉，这里选了可访问性。
  切角只出现在开屏字标与括线转角上。
- 玻璃层在 `endfield` 下是实底、无模糊；Dock 同理（`--dock-*` 已改成纸色）。

调研来源见 `E:\User\knowledge-base\0-Inbox\2026-11-01-终末地HUD主题调研.md`。
