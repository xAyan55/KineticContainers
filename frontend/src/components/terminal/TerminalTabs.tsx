import * as React from "react";
import { Plus, X, Terminal as TerminalIcon, Edit2, Check } from "lucide-react";
import { MAX_SESSIONS, type TerminalSessionItem } from "./terminalTypes";

interface TerminalTabsProps {
  sessions: TerminalSessionItem[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onAddSession: () => void;
  onCloseSession: (id: string) => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onCloseAll: () => void;
}

export function TerminalTabs({
  sessions,
  activeSessionId,
  onSelectSession,
  onAddSession,
  onCloseSession,
  onRenameSession,
  onCloseAll,
}: TerminalTabsProps): React.JSX.Element {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startRename = (s: TerminalSessionItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(s.id);
    setEditTitle(s.title);
  };

  const finishRename = (id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed) {
      onRenameSession(id, trimmed);
    }
    setEditingId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "Enter") {
      finishRename(id);
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  };

  return (
    <div className="flex items-center justify-between border-b border-[#2A2A2A] bg-[#0c0c0c] px-2">
      <div className="flex items-center gap-1 overflow-x-auto py-1 kct-scroll">
        {sessions.map((s) => {
          const isActive = s.id === activeSessionId;
          const isEditing = editingId === s.id;

          let statusDotColor = "bg-zinc-500";
          let statusText = "Disconnected";
          if (s.phase === "connected") {
            statusDotColor = "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]";
            statusText = "Connected";
          } else if (s.phase === "connecting" || s.phase === "reconnecting") {
            statusDotColor = "bg-amber-500 animate-pulse";
            statusText = s.phase === "reconnecting" ? "Reconnecting…" : "Connecting…";
          } else if (s.phase === "error") {
            statusDotColor = "bg-rose-500";
            statusText = "Error";
          }

          return (
            <div
              key={s.id}
              onClick={() => onSelectSession(s.id)}
              className={`group flex items-center gap-2 rounded-t-md px-3 py-1.5 text-xs font-mono select-none cursor-pointer border-t border-x transition-colors ${
                isActive
                  ? "bg-[#000000] border-[#2A2A2A] text-[#F5F5F5] font-medium"
                  : "bg-[#101010] border-transparent text-[#888888] hover:bg-[#161616] hover:text-[#d4d4d4]"
              }`}
              title={`${s.title} (${statusText})`}
            >
              <span className={`h-2 w-2 rounded-full flex-shrink-0 ${statusDotColor}`} aria-hidden="true" />
              <TerminalIcon className="h-3 w-3 text-[#666] flex-shrink-0" aria-hidden="true" />

              {isEditing ? (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={inputRef}
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => finishRename(s.id)}
                    onKeyDown={(e) => handleKeyDown(e, s.id)}
                    maxLength={32}
                    className="w-24 rounded border border-[#3A3A3A] bg-[#1a1a1a] px-1 py-0.5 text-xs text-[#F5F5F5] outline-none focus:border-[#666]"
                  />
                  <button
                    type="button"
                    onClick={() => finishRename(s.id)}
                    className="text-[#888] hover:text-[#F5F5F5]"
                    title="Save title"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <span
                  onDoubleClick={(e) => startRename(s, e)}
                  className="max-w-[130px] truncate"
                  title="Double-click to rename"
                >
                  {s.title}
                </span>
              )}

              {!isEditing && (
                <button
                  type="button"
                  onClick={(e) => startRename(s, e)}
                  className="opacity-0 group-hover:opacity-100 text-[#666] hover:text-[#F5F5F5] transition-opacity p-0.5 rounded"
                  title="Rename session"
                >
                  <Edit2 className="h-2.5 w-2.5" />
                </button>
              )}

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseSession(s.id);
                }}
                className="ml-1 rounded p-0.5 text-[#666] hover:bg-[#202020] hover:text-[#F5F5F5] transition-colors"
                title="Close terminal session"
                aria-label={`Close ${s.title}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={onAddSession}
          disabled={sessions.length >= MAX_SESSIONS}
          className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-mono transition-colors ${
            sessions.length >= MAX_SESSIONS
              ? "opacity-40 cursor-not-allowed text-[#666]"
              : "text-[#888888] hover:bg-[#181818] hover:text-[#F5F5F5]"
          }`}
          title={
            sessions.length >= MAX_SESSIONS
              ? `Maximum sessions reached (${MAX_SESSIONS})`
              : "Open new terminal session"
          }
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New</span>
        </button>
      </div>

      {sessions.length > 1 && (
        <div className="flex-shrink-0 pl-2">
          <button
            type="button"
            onClick={onCloseAll}
            className="text-[11px] font-mono text-[#666] hover:text-[#e0e0e0] px-2 py-1 rounded hover:bg-[#181818] transition-colors"
            title="Close all terminal sessions"
          >
            Close all
          </button>
        </div>
      )}
    </div>
  );
}
