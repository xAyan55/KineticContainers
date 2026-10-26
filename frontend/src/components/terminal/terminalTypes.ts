import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";

export type SessionPhase =
  | "checking"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error"
  | "closed";

export interface TerminalSessionItem {
  id: string;
  title: string;
  phase: SessionPhase;
  error?: string;
  term: Terminal | null;
  fitAddon: FitAddon | null;
  searchAddon: SearchAddon | null;
  ws: WebSocket | null;
  cols: number;
  rows: number;
  shell: string | null;
  createdAt: number;
}

export type CursorStyle = "block" | "underline" | "bar";

export interface TerminalPreferences {
  fontSize: number;
  fontFamily: string;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
}

export const FONT_FAMILY_STACK =
  '"JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const DEFAULT_PREFERENCES: TerminalPreferences = {
  fontSize: 14,
  fontFamily: FONT_FAMILY_STACK,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: false,
};

export const MAX_SESSIONS = 8;
