import { moveFenceEntries } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { useFiles } from "@/stores/files";

export async function moveDroppedFiles(categoryId: string, paths: string[], destination: string) {
    const result = await moveFenceEntries(paths, destination);
    useFiles.getState().applyMovedEntries(categoryId, result.moved);
    await flushAllStorage();
    return result;
}
