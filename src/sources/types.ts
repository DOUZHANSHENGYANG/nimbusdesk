/** 统一条目结构 —— 所有渠道适配器的唯一输出类型（扩展新渠道时只依赖这里） */
export interface SourceEntry {
  id: string;
  title: string;
  url: string;
  /** epoch ms，可选 */
  pubDate?: number;
  /** Complete article supplied by RSS/Atom, kept separately from list previews. */
  content?: { format: "html" | "text"; value: string };
  extra?: {
    /** 徽标信息，如 "✰ 1.2k"、"384 points" */
    info?: string;
    /** 悬停/正文描述 */
    hover?: string;
  };
}

/** 渠道适配器 —— 扩展一个新渠道 = 新建一个文件实现它 + 在 registry 注册一行 */
export interface SourceAdapter {
  id: string;
  name: string;
  /** 侧栏分组：技术 | 社区 | 资讯 … */
  group: string;
  homepage: string;
  fetch(): Promise<SourceEntry[]>;
}
