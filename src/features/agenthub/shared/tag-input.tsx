import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * 标签输入：回车添加，空内容按回车**不拦**（让事件冒泡去提交外层表单 = 自动保存），
 * 退格键在输入框为空时删掉最后一个标签。
 */
export function TagInput({
  value,
  onChange,
  placeholder,
  className,
  id,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [text, setText] = useState("");

  const addTag = () => {
    const tag = text.trim();
    if (!tag) return;
    if (!value.includes(tag)) onChange([...value, tag]);
    setText("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      if (text.trim()) {
        event.preventDefault();
        addTag();
      }
      return;
    }
    if (event.key === "Backspace" && !text && value.length > 0) onChange(value.slice(0, -1));
  };

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-surface px-2 py-1 transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--ring)]",
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
            onClick={() => onChange(value.filter((item) => item !== tag))}
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={value.length === 0 ? (placeholder ?? "") : ""}
        className="h-6 min-w-24 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-ink-3"
      />
    </div>
  );
}
