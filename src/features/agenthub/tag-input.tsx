import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { addTags, removeTag } from "./core";

/** 标签编辑：回车/失焦提交，中英文逗号与换行都当分隔符。 */
export function TagEditor({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  function commit() {
    const next = addTags(value, draft);
    if (next.length !== value.length) onChange(next);
    setDraft("");
    setAdding(false);
  }

  return (
    <div className="toolbox-tags">
      {value.map((tag) => (
        <span className="toolbox-tag" key={tag}>
          {tag}
          <button
            type="button"
            aria-label={t("toolbox.tags.remove", { tag })}
            onClick={() => onChange(removeTag(value, tag))}
          >
            <X />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="toolbox-tag-input"
          autoFocus
          value={draft}
          placeholder={t("toolbox.tags.placeholder")}
          aria-label={t("toolbox.tags.add")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
        />
      ) : (
        <button type="button" className="toolbox-tag-add" onClick={() => setAdding(true)}>
          <Plus />
          {t("toolbox.tags.add")}
        </button>
      )}
    </div>
  );
}
