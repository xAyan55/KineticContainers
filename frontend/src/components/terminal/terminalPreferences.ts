import { DEFAULT_PREFERENCES, type TerminalPreferences } from "./terminalTypes";

const STORAGE_KEY = "kct_terminal_preferences";

export function loadTerminalPreferences(): TerminalPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<TerminalPreferences>;
    return {
      fontSize: typeof parsed.fontSize === "number" && parsed.fontSize >= 10 && parsed.fontSize <= 24 ? parsed.fontSize : DEFAULT_PREFERENCES.fontSize,
      fontFamily: typeof parsed.fontFamily === "string" && parsed.fontFamily.trim() ? parsed.fontFamily : DEFAULT_PREFERENCES.fontFamily,
      cursorStyle: parsed.cursorStyle === "block" || parsed.cursorStyle === "underline" || parsed.cursorStyle === "bar" ? parsed.cursorStyle : DEFAULT_PREFERENCES.cursorStyle,
      cursorBlink: typeof parsed.cursorBlink === "boolean" ? parsed.cursorBlink : DEFAULT_PREFERENCES.cursorBlink,
      scrollback: typeof parsed.scrollback === "number" && parsed.scrollback >= 1000 && parsed.scrollback <= 20000 ? parsed.scrollback : DEFAULT_PREFERENCES.scrollback,
      copyOnSelect: typeof parsed.copyOnSelect === "boolean" ? parsed.copyOnSelect : DEFAULT_PREFERENCES.copyOnSelect,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function saveTerminalPreferences(prefs: TerminalPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore storage quota errors */
  }
}
