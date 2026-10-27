import * as React from "react";
import {
  RotateCcw,
  Search,
  Maximize2,
  Minimize2,
  Trash2,
  Settings,
  Copy,
  ChevronUp,
  ChevronDown,
  X,
  Type,
  ZoomIn,
  ZoomOut,
  Sliders,
} from "lucide-react";
import type { TerminalSessionItem, TerminalPreferences } from "./terminalTypes";

interface TerminalToolbarProps {
  session: TerminalSessionItem | undefined;
  preferences: TerminalPreferences;
  onUpdatePreferences: (updates: Partial<TerminalPreferences>) => void;
  onReconnect: () => void;
  onClearScreen: () => void;
  onFitTerminal: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenSettings: () => void;
}

export function TerminalToolbar({
  session,
  preferences,
  onUpdatePreferences,
  onReconnect,
  onClearScreen,
  onFitTerminal,
  isFullscreen,
  onToggleFullscreen,
  onOpenSettings,
}: TerminalToolbarProps): React.JSX.Element {
  const [showSearch, setShowSearch] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [caseSensitive, setCaseSensitive] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  const handleSearch = (query: string, reverse = false) => {
    setSearchQuery(query);
    if (!session?.searchAddon) return;
    if (!query) {
      session.searchAddon.clearDecorations();
      return;
    }
    if (reverse) {
      session.searchAddon.findPrevious(query, { caseSensitive, regex: false });
    } else {
      session.searchAddon.findNext(query, { caseSensitive, regex: false });
    }
  };

  const handleCopySelection = () => {
    if (!session?.term) return;
    const selection = session.term.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => undefined);
    }
  };

  const adjustFontSize = (delta: number) => {
    const next = Math.max(10, Math.min(24, preferences.fontSize + delta));
    onUpdatePreferences({ fontSize: next });
  };

  let statusBadge = (
    <span className="flex items-center gap-1.5 text-zinc-400">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
      <span>Offline</span>
    </span>
  );

  if (session) {
    if (session.phase === "connected") {
      statusBadge = (
        <span className="flex items-center gap-1.5 text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]" />
          <span>Connected ({session.cols ?? 80}×{session.rows ?? 24})</span>
        </span>
      );
    } else if (session.phase === "connecting" || session.phase === "reconnecting") {
      statusBadge = (
        <span className="flex items-center gap-1.5 text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
          <span>{session.phase === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
        </span>
      );
    } else if (session.phase === "error") {
      statusBadge = (
        <span className="flex items-center gap-1.5 text-rose-400" title={session.error}>
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
          <span className="truncate max-w-[200px]">{session.error || "Connection error"}</span>
        </span>
      );
    } else if (session.phase === "closed") {
      statusBadge = (
        <span className="flex items-center gap-1.5 text-zinc-400">
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
          <span>Session ended</span>
        </span>
      );
    }
  }

  return (
    <div className="relative border-b border-[#2A2A2A] bg-[#101010] px-3 py-1.5 text-xs text-[#888888] font-mono select-none">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Left: Session Status & Shell info */}
        <div className="flex items-center gap-3">
          {statusBadge}
          {session?.shell && (
            <span className="text-[11px] text-[#666] hidden sm:inline">
              shell: <span className="text-[#a0a0a0]">{session.shell}</span>
            </span>
          )}
        </div>

        {/* Right: Actions and Controls */}
        <div className="flex items-center gap-1">
          {/* Reconnect button when disconnected or closed */}
          {session && (session.phase === "closed" || session.phase === "disconnected" || session.phase === "error") && (
            <button
              type="button"
              onClick={onReconnect}
              className="flex items-center gap-1 rounded bg-[#202020] hover:bg-[#2A2A2A] text-[#F5F5F5] px-2 py-0.5 text-xs transition-colors border border-[#333]"
              title="Reconnect this terminal session"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reconnect</span>
            </button>
          )}

          {/* Search Toggle */}
          <button
            type="button"
            onClick={() => setShowSearch(!showSearch)}
            className={`rounded p-1 transition-colors ${
              showSearch ? "bg-[#252525] text-[#F5F5F5]" : "hover:bg-[#1a1a1a] hover:text-[#F5F5F5]"
            }`}
            title="Search output (Ctrl+F)"
            aria-label="Search terminal output"
          >
            <Search className="h-3.5 w-3.5" />
          </button>

          {/* Copy Selection */}
          <button
            type="button"
            onClick={handleCopySelection}
            className="rounded p-1 hover:bg-[#1a1a1a] hover:text-[#F5F5F5] transition-colors"
            title="Copy selected text"
            aria-label="Copy selected text"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>

          {/* Font Size controls */}
          <div className="flex items-center rounded border border-[#2A2A2A] bg-[#0a0a0a] px-1">
            <button
              type="button"
              onClick={() => adjustFontSize(-1)}
              className="p-1 hover:text-[#F5F5F5] transition-colors"
              title="Decrease font size"
              aria-label="Decrease font size"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onUpdatePreferences({ fontSize: 14 })}
              className="px-1 text-[11px] text-[#aaa] hover:text-[#F5F5F5]"
              title="Reset font size to 14px"
            >
              {preferences?.fontSize ?? 14}px
            </button>
            <button
              type="button"
              onClick={() => adjustFontSize(1)}
              className="p-1 hover:text-[#F5F5F5] transition-colors"
              title="Increase font size"
              aria-label="Increase font size"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
          </div>

          {/* Clear screen */}
          <button
            type="button"
            onClick={onClearScreen}
            className="rounded p-1 hover:bg-[#1a1a1a] hover:text-[#F5F5F5] transition-colors"
            title="Clear terminal screen"
            aria-label="Clear screen"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>

          {/* Fit Terminal */}
          <button
            type="button"
            onClick={onFitTerminal}
            className="rounded p-1 hover:bg-[#1a1a1a] hover:text-[#F5F5F5] transition-colors text-[11px] px-1.5"
            title="Recalculate terminal dimensions"
          >
            Fit
          </button>

          {/* Settings modal button */}
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded p-1 hover:bg-[#1a1a1a] hover:text-[#F5F5F5] transition-colors"
            title="Terminal settings"
            aria-label="Terminal settings"
          >
            <Sliders className="h-3.5 w-3.5" />
          </button>

          {/* Fullscreen toggle */}
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="rounded p-1 hover:bg-[#1a1a1a] hover:text-[#F5F5F5] transition-colors"
            title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Floating Search Bar */}
      {showSearch && (
        <div className="absolute right-3 top-10 z-20 flex items-center gap-1 rounded-md border border-[#2A2A2A] bg-[#141414] p-1.5 shadow-xl">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search terminal..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSearch(searchQuery, e.shiftKey);
              } else if (e.key === "Escape") {
                setShowSearch(false);
                session?.term?.focus();
              }
            }}
            className="w-44 rounded border border-[#2A2A2A] bg-[#0a0a0a] px-2 py-0.5 text-xs text-[#F5F5F5] placeholder-[#666] outline-none focus:border-[#444]"
          />
          <button
            type="button"
            onClick={() => handleSearch(searchQuery, true)}
            className="rounded p-1 hover:bg-[#202020] hover:text-[#F5F5F5]"
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => handleSearch(searchQuery, false)}
            className="rounded p-1 hover:bg-[#202020] hover:text-[#F5F5F5]"
            title="Next match (Enter)"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setCaseSensitive(!caseSensitive);
              if (session?.searchAddon && searchQuery) {
                session.searchAddon.findNext(searchQuery, { caseSensitive: !caseSensitive });
              }
            }}
            className={`rounded px-1 text-[10px] font-bold uppercase transition-colors ${
              caseSensitive ? "bg-[#333] text-[#F5F5F5]" : "text-[#666] hover:text-[#aaa]"
            }`}
            title="Match case"
          >
            Aa
          </button>
          <button
            type="button"
            onClick={() => {
              setShowSearch(false);
              session?.searchAddon?.clearDecorations();
              session?.term?.focus();
            }}
            className="rounded p-1 hover:bg-[#202020] hover:text-[#F5F5F5]"
            title="Close search (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
