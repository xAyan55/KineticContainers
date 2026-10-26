import * as React from "react";
import { X, RotateCcw, Sliders } from "lucide-react";
import {
  DEFAULT_PREFERENCES,
  FONT_FAMILY_STACK,
  type CursorStyle,
  type TerminalPreferences,
} from "./terminalTypes";

interface TerminalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  preferences: TerminalPreferences;
  onUpdatePreferences: (updates: Partial<TerminalPreferences>) => void;
}

export function TerminalSettings({
  isOpen,
  onClose,
  preferences,
  onUpdatePreferences,
}: TerminalSettingsProps): React.JSX.Element | null {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-lg border border-[#2A2A2A] bg-[#101010] p-5 shadow-2xl font-mono text-xs text-[#F5F5F5]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2A2A2A] pb-3 mb-4">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-[#888]" />
            <h3 className="text-sm font-semibold text-[#F5F5F5]">Terminal Preferences</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[#666] hover:bg-[#202020] hover:text-[#F5F5F5] transition-colors"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body Form */}
        <div className="flex flex-col gap-4">
          {/* Font Size */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[#aaa] text-xs">Font Size</label>
              <span className="text-[#F5F5F5]">{preferences.fontSize}px</span>
            </div>
            <input
              type="range"
              min={10}
              max={24}
              step={1}
              value={preferences.fontSize}
              onChange={(e) => onUpdatePreferences({ fontSize: Number(e.target.value) })}
              className="w-full accent-white cursor-pointer"
            />
          </div>

          {/* Font Family */}
          <div>
            <label className="block text-[#aaa] text-xs mb-1.5">Font Family</label>
            <select
              value={preferences.fontFamily}
              onChange={(e) => onUpdatePreferences({ fontFamily: e.target.value })}
              className="w-full rounded border border-[#2A2A2A] bg-[#000000] px-2.5 py-1.5 text-xs text-[#F5F5F5] outline-none focus:border-[#444]"
            >
              <option value={FONT_FAMILY_STACK}>JetBrains Mono (Bundled, Recommended)</option>
              <option value='Menlo, Monaco, "Courier New", monospace'>Menlo / Monaco / Monospace</option>
              <option value='Consolas, "Lucida Console", monospace'>Consolas / Monospace</option>
              <option value='ui-monospace, SFMono-Regular, monospace'>System UI Monospace</option>
            </select>
          </div>

          {/* Cursor Style */}
          <div>
            <label className="block text-[#aaa] text-xs mb-1.5">Cursor Style</label>
            <div className="grid grid-cols-3 gap-2">
              {(["block", "underline", "bar"] as CursorStyle[]).map((style) => (
                <button
                  key={style}
                  type="button"
                  onClick={() => onUpdatePreferences({ cursorStyle: style })}
                  className={`rounded border px-2 py-1.5 text-center capitalize transition-colors ${
                    preferences.cursorStyle === style
                      ? "border-[#F5F5F5] bg-[#222222] text-[#F5F5F5] font-semibold"
                      : "border-[#2A2A2A] bg-[#050505] text-[#888888] hover:bg-[#181818] hover:text-[#ddd]"
                  }`}
                >
                  {style}
                </button>
              ))}
            </div>
          </div>

          {/* Cursor Blinking */}
          <div className="flex items-center justify-between py-1">
            <div>
              <span className="block text-[#aaa] text-xs">Cursor Blinking</span>
              <span className="text-[11px] text-[#666]">Animate cursor in active sessions</span>
            </div>
            <input
              type="checkbox"
              checked={preferences.cursorBlink}
              onChange={(e) => onUpdatePreferences({ cursorBlink: e.target.checked })}
              className="h-4 w-4 rounded border-[#2A2A2A] bg-[#000000] accent-white cursor-pointer"
            />
          </div>

          {/* Scrollback Limit */}
          <div>
            <label className="block text-[#aaa] text-xs mb-1.5">Scrollback Lines</label>
            <select
              value={preferences.scrollback}
              onChange={(e) => onUpdatePreferences({ scrollback: Number(e.target.value) })}
              className="w-full rounded border border-[#2A2A2A] bg-[#000000] px-2.5 py-1.5 text-xs text-[#F5F5F5] outline-none focus:border-[#444]"
            >
              <option value={1000}>1,000 lines (Low memory)</option>
              <option value={3000}>3,000 lines</option>
              <option value={5000}>5,000 lines (Default)</option>
              <option value={10000}>10,000 lines</option>
              <option value={20000}>20,000 lines (Extended)</option>
            </select>
          </div>

          {/* Copy on Select */}
          <div className="flex items-center justify-between py-1 border-t border-[#2A2A2A] pt-3">
            <div>
              <span className="block text-[#aaa] text-xs">Copy on Select</span>
              <span className="text-[11px] text-[#666]">Automatically copy text to clipboard when selected</span>
            </div>
            <input
              type="checkbox"
              checked={preferences.copyOnSelect}
              onChange={(e) => onUpdatePreferences({ copyOnSelect: e.target.checked })}
              className="h-4 w-4 rounded border-[#2A2A2A] bg-[#000000] accent-white cursor-pointer"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="mt-5 flex items-center justify-between border-t border-[#2A2A2A] pt-3">
          <button
            type="button"
            onClick={() => onUpdatePreferences(DEFAULT_PREFERENCES)}
            className="flex items-center gap-1.5 text-[11px] text-[#888] hover:text-[#F5F5F5] transition-colors"
            title="Reset to default settings"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset to defaults</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-[#F5F5F5] px-3 py-1 text-xs font-semibold text-[#000000] hover:bg-[#e0e0e0] transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
