import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useKnowledgeCopy } from "./copy";
import { recipeParameters, fillRecipe } from "./recipe-logic";

export function RecipePreview({ content }: { content: string }) {
  const c = useKnowledgeCopy();
  const parameters = useMemo(() => recipeParameters(content), [content]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const preview = fillRecipe(content, values);
  return <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
    <h3 className="text-sm font-medium">{c.recipePreview}</h3>
    {parameters.length === 0 && <p className="text-xs text-muted-foreground">{c.noRecipeParameters}</p>}
    {parameters.map((name) => <label key={name} className="block space-y-1 text-xs">{name}<Input value={values[name] ?? ""} onChange={(e) => setValues({ ...values, [name]: e.target.value })} /></label>)}
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 text-xs">{preview}</pre>
    <Button variant="outline" onClick={() => void navigator.clipboard.writeText(preview).then(() => setMessage(c.copied)).catch((e) => setMessage(String(e)))}>{c.copy}</Button>
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </section>;
}
