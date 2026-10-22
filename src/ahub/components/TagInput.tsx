import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { cn } from "@/ahub/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}

/**
 * 标签输入：输入后回车添加；在表单中标签输入框为空时按回车 = 提交表单（自动保存）。
 */
export function TagInput({ value, onChange, placeholder, className, id }: TagInputProps) {
  const [text, setText] = useState("");

  const addTag = () => {
    const t = text.trim();
    if (!t) return false;
    if (!value.includes(t)) onChange([...value, t]);
    setText("");
    return true;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // 有内容：添加标签并吞掉事件（不触发表单提交）
      if (text.trim()) {
        e.preventDefault();
        addTag();
      }
      // 空内容：不 preventDefault，让事件冒泡提交表单 → 自动保存
      return;
    }
    if (e.key === "Backspace" && !text && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-surface px-2 py-1 transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--ah-primary-soft)]",
        className,
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex max-w-40 items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary"
        >
          <span className="truncate">{tag}</span>
          <button
            type="button"
            aria-label={`remove ${tag}`}
            className="rounded-full p-0.5 outline-none hover:bg-primary/15"
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={value.length === 0 ? (placeholder ?? "") : ""}
        className="h-6 min-w-24 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-ink-3"
      />
    </div>
  );
}
