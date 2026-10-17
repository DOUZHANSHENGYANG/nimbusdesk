export interface KnowledgeFolders { experience: string; recipe: string; resource: string }
export const DEFAULT_KNOWLEDGE_FOLDERS: KnowledgeFolders = {
  experience: "02-工作/开发经验", recipe: "02-工作/开发配方", resource: "04-资源收藏",
};
export const KNOWLEDGE_FOLDER_KEYS = ["experience", "recipe", "resource"] as const;

function slash(path: string): string { return path.trim().replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, ""); }
export function vaultKey(root: string): string { return slash(root).toLocaleLowerCase(); }

export function folderWithinVault(root: string, selected: string): string {
  const base = slash(root); const path = slash(selected);
  if (!path.toLocaleLowerCase().startsWith(`${base.toLocaleLowerCase()}/`)) throw new Error("请选择当前知识库内的文件夹 / Choose a folder inside this vault");
  return path.slice(base.length + 1);
}

export function normalizeFolders(folders: KnowledgeFolders): KnowledgeFolders {
  const result = {} as KnowledgeFolders;
  for (const key of KNOWLEDGE_FOLDER_KEYS) {
    const path = slash(folders[key]);
    const parts = path.split("/");
    if (!path || path.length > 1024 || parts.length > 40 || parts.some((part) => !part || part.startsWith(".") || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(node_modules|skills|target|vendor)$/i.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      || /^(assets|08-收件箱)(?:\/|$)/i.test(path)) throw new Error("文件夹路径不合法 / Invalid knowledge folder");
    result[key] = path;
  }
  const paths = Object.values(result).map((path) => path.toLocaleLowerCase());
  if (paths.some((path, i) => paths.some((other, j) => i !== j && (path === other || path.startsWith(`${other}/`))))) throw new Error("分类文件夹不能相同或互相包含 / Category folders cannot overlap");
  return result;
}

export function foldersForVault(bindings: Record<string, KnowledgeFolders>, root: string): KnowledgeFolders {
  return bindings[vaultKey(root)] ?? DEFAULT_KNOWLEDGE_FOLDERS;
}
