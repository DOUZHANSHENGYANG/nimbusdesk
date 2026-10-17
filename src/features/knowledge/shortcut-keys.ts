export type ShortcutKey = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat" | "isComposing" | "getModifierState">;

export type RecordedShortcut =
  | { type: "recorded"; shortcut: string }
  | { type: "cancel" }
  | { type: "ignored"; reason: "modifier" | "typing" | "unsupported" | "composition" | "repeat" };

const namedKeys = new Set([
  "Space", "Enter", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Pause", "PrintScreen", "ScrollLock", "NumLock", "CapsLock",
  "Equal", "Minus", "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Period", "Quote", "Semicolon", "Slash",
  "NumpadAdd", "NumpadDecimal", "NumpadDivide", "NumpadEnter", "NumpadEqual", "NumpadMultiply", "NumpadSubtract",
]);

// Match the native global-hotkey parser, using physical codes rather than IME text.
export function recordShortcut(event: ShortcutKey): RecordedShortcut {
  if (event.isComposing || event.getModifierState("AltGraph")) return { type: "ignored", reason: "composition" };
  if (event.code === "Escape" || event.code === "Tab") return { type: "cancel" };
  if (event.repeat) return { type: "ignored", reason: "repeat" };
  if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) return { type: "ignored", reason: "modifier" };
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return { type: "ignored", reason: "typing" };
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5)
    : namedKeys.has(event.code) || /^(F([1-9]|1[0-9]|2[0-4])|Numpad[0-9])$/.test(event.code) ? event.code : null;
  if (!key) return { type: "ignored", reason: "unsupported" };
  return { type: "recorded", shortcut: [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", key].filter(Boolean).join("+") };
}
