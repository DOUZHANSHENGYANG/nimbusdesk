import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * 弹窗正文区。
 *
 * 云台的 DialogContent 是「grid + gap」，段与段之间靠 gap 排；源侧用
 * `<DialogBody />` 当**可滚动的撑开段**，让头/脚固定、中间独立滚动。
 * 这里补上这一个组件，搬过来的页面就不用改结构。
 */
export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-h-0 overflow-y-auto -mx-4 px-4", className)} {...props} />;
}
