import { moveFenceEntries } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { useFiles } from "@/stores/files";
import { useFileHistory } from "./history";

export async function moveDroppedFiles(categoryId: string, paths: string[], destination: string) {
    const result = await moveFenceEntries(paths, destination);
    useFiles.getState().applyMovedEntries(categoryId, result.moved);
    // 记一次可撤销的移动：一次拖入的多个文件归到同一个 groupId，撤销时一起回去
    if (result.moved.length) {
        const groupId = crypto.randomUUID();
        const push = useFileHistory.getState().push;
        for (const entry of result.moved) {
            if (entry.sourceRetained) continue; // 源没删掉就不算移动，撤销会乱
            push({
                kind: "move",
                from: entry.source,
                to: entry.path,
                label: entry.name,
                groupId,
            });
        }
    }
    await flushAllStorage();
    return result;
}
