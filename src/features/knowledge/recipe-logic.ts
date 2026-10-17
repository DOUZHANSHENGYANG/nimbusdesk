/** Placeholders are deliberately plain text: no expression evaluation or command execution. */
export function recipeParameters(content: string): string[] {
  return [...new Set([...content.matchAll(/\{\{\s*([^{}\r\n]+?)\s*\}\}/g)].map((match) => match[1].trim()).filter(Boolean))];
}
export function fillRecipe(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{\s*([^{}\r\n]+?)\s*\}\}/g, (original, name: string) => Object.prototype.hasOwnProperty.call(values, name.trim()) ? values[name.trim()] : original);
}
