import * as React from "react";
import { Terminal as TerminalIcon, AlertTriangle, Play, RefreshCw } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import {
  MAX_SESSIONS,
  type TerminalPreferences,
  type TerminalSessionItem,
} from "./terminalTypes";
import {
  loadTerminalPreferences,
  saveTerminalPreferences,
} from "./terminalPreferences";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalToolbar } from "./TerminalToolbar";
import { TerminalSettings } from "./TerminalSettings";
import { TerminalSession } from "./TerminalSession";

interface KineticTerminalProps {
  instanceId: string;
  instanceName?: string;
  running?: boolean;
  onRefreshInstance?: () => void;
  apiBase?: string;
}

export function KineticTerminal({
  instanceId,
  instanceName,
  running,
  onRefreshInstance,
  apiBase,
}: KineticTerminalProps): React.JSX.Element {
  const [checking, setChecking] = React.useState(true);
  const [supported, setSupported] = React.useState(true);
  const [unsupportedReason, setUnsupportedReason] = React.useState<string | null>(null);
  const [isContainerRunning, setIsContainerRunning] = React.useState(true);

  const [preferences, setPreferences] = React.useState<TerminalPreferences>(loadTerminalPreferences);
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [isFullscreen, setIsFullscreen] = React.useState(false);

  const [sessions, setSessions] = React.useState<TerminalSessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string>("");
  const sessionCounterRef = React.useRef(1);
  const terminalWrapperRef = React.useRef<HTMLDivElement | null>(null);

  // 1. Initial preflight check
  const checkConsole = React.useCallback(async () => {
    setChecking(true);
    setUnsupportedReason(null);
    try {
      const data = await api.get<{
        supported: boolean;
        running: boolean;
        shell: string | null;
        reason: string | null;
      }>(`/api/instances/${encodeURIComponent(instanceId)}/console`);

      setSupported(data.supported);
      setIsContainerRunning(data.running);
      if (!data.supported) {
        setUnsupportedReason(data.reason ?? "Interactive console is not available on this host.");
      } else {
        // If supported and no sessions exist yet, initialize Terminal 1
        setSessions((curr) => {
          if (curr.length === 0) {
            const firstId = "term_1";
            sessionCounterRef.current = 2;
            return [
              {
                id: firstId,
                title: "Terminal 1",
                phase: "connecting",
                term: null,
                fitAddon: null,
                searchAddon: null,
                ws: null,
                cols: 80,
                rows: 24,
                shell: data.shell,
                createdAt: Date.now(),
              },
            ];
          }
          return curr;
        });
        setActiveSessionId((curr) => curr || "term_1");
      }
    } catch (err) {
      setSupported(false);
      setUnsupportedReason(
        err instanceof ApiError ? err.message : "Failed to verify console availability."
      );
    } finally {
      setChecking(false);
    }
  }, [instanceId]);

  React.useEffect(() => {
    void checkConsole();
  }, [checkConsole]);

  const handleUpdatePreferences = (updates: Partial<TerminalPreferences>) => {
    setPreferences((prev) => {
      const next = { ...prev, ...updates };
      saveTerminalPreferences(next);
      return next;
    });
  };

  const handleAddSession = () => {
    if (sessions.length >= MAX_SESSIONS) return;
    const num = sessionCounterRef.current++;
    const nextId = `term_${num}_${Math.random().toString(36).slice(2, 6)}`;
    const newSession: TerminalSessionItem = {
      id: nextId,
      title: `Terminal ${num}`,
      phase: "connecting",
      term: null,
      fitAddon: null,
      searchAddon: null,
      ws: null,
      cols: 80,
      rows: 24,
      shell: null,
      createdAt: Date.now(),
    };

    setSessions((curr) => [...curr, newSession]);
    setActiveSessionId(nextId);
  };

  const handleCloseSession = (id: string) => {
    const s = sessions.find((item) => item.id === id);
    if (!s) return;

    if (s.phase === "connected") {
      const confirmClose = window.confirm(
        `Close ${s.title}? Any running process inside this shell session will be stopped.`
      );
      if (!confirmClose) return;
    }

    try {
      if (s.ws?.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ type: "terminate" }));
        s.ws.close(1000, "user close");
      }
    } catch {
      /* ignore */
    }

    try {
      s.term?.dispose();
    } catch {
      /* ignore */
    }

    setSessions((curr) => {
      const filtered = curr.filter((item) => item.id !== id);
      if (activeSessionId === id && filtered.length > 0) {
        // Shift active to adjacent tab
        const closedIdx = curr.findIndex((item) => item.id === id);
        const nextIdx = Math.max(0, Math.min(filtered.length - 1, closedIdx));
        setActiveSessionId(filtered[nextIdx].id);
      } else if (filtered.length === 0) {
        setActiveSessionId("");
      }
      return filtered;
    });
  };

  const handleCloseAll = () => {
    const connectedCount = sessions.filter((s) => s.phase === "connected").length;
    if (connectedCount > 0) {
      if (!window.confirm(`Close all ${sessions.length} terminal sessions?`)) {
        return;
      }
    }

    for (const s of sessions) {
      try {
        if (s.ws?.readyState === WebSocket.OPEN) {
          s.ws.send(JSON.stringify({ type: "terminate" }));
          s.ws.close(1000, "close all");
        }
        s.term?.dispose();
      } catch {
        /* ignore */
      }
    }

    setSessions([]);
    setActiveSessionId("");
  };

  const handleRenameSession = (id: string, newTitle: string) => {
    setSessions((curr) =>
      curr.map((s) => (s.id === id ? { ...s, title: newTitle } : s))
    );
  };

  const handleUpdateSession = (id: string, updates: Partial<TerminalSessionItem>) => {
    setSessions((curr) =>
      curr.map((s) => (s.id === id ? { ...s, ...updates } : s))
    );
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  const handleReconnectSession = () => {
    if (!activeSession) return;
    // Trigger reconnection by recreating session entry with fresh ID
    const renewedId = `term_rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setSessions((curr) =>
      curr.map((s) =>
        s.id === activeSession.id
          ? {
              ...s,
              id: renewedId,
              phase: "connecting",
              error: undefined,
              term: null,
              fitAddon: null,
              searchAddon: null,
              ws: null,
            }
          : s
      )
    );
    setActiveSessionId(renewedId);
  };

  const handleClearScreen = () => {
    activeSession?.term?.clear();
    activeSession?.term?.focus();
  };

  const handleFitTerminal = () => {
    try {
      activeSession?.fitAddon?.fit();
      if (activeSession?.term && activeSession?.ws?.readyState === WebSocket.OPEN) {
        activeSession.ws.send(
          JSON.stringify({
            type: "resize",
            cols: activeSession.term.cols,
            rows: activeSession.term.rows,
          })
        );
        handleUpdateSession(activeSession.id, {
          cols: activeSession.term.cols,
          rows: activeSession.term.rows,
        });
      }
      activeSession?.term?.focus();
    } catch {
      /* ignore */
    }
  };

  const handleToggleFullscreen = () => {
    if (!terminalWrapperRef.current) return;
    if (!isFullscreen) {
      if (terminalWrapperRef.current.requestFullscreen) {
        terminalWrapperRef.current.requestFullscreen().catch(() => {
          setIsFullscreen(true);
        });
      } else {
        setIsFullscreen(true);
      }
    } else {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => undefined);
      }
      setIsFullscreen(false);
    }
  };

  // Sync fullscreen change events (e.g. user presses Esc)
  React.useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      window.setTimeout(handleFitTerminal, 100);
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  if (checking) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-sm text-[#888888] font-mono rounded-lg border border-[#2A2A2A] bg-[#101010]">
        <RefreshCw className="h-5 w-5 animate-spin text-[#F5F5F5] mb-2" />
        <p>Connecting to virtualization gateway…</p>
      </div>
    );
  }

  if (!supported) {
    return (
      <div className="flex flex-col items-center justify-center p-10 text-center font-mono rounded-lg border border-[#2A2A2A] bg-[#101010]">
        <div className="rounded-full bg-[#202020] p-3 text-amber-400 mb-3 border border-[#333]">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h3 className="text-sm font-semibold text-[#F5F5F5] mb-1">Interactive Console Unavailable</h3>
        <p className="max-w-md text-xs text-[#888888] mb-5">{unsupportedReason}</p>
        <div className="flex gap-2">
          {!isContainerRunning && onRefreshInstance && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await api.post(`/api/instances/${instanceId}/actions`, { action: "start" });
                  onRefreshInstance();
                  void checkConsole();
                } catch {
                  /* ignore */
                }
              }}
              className="flex items-center gap-1.5 rounded-md bg-[#F5F5F5] px-3 py-1.5 text-xs font-semibold text-[#000000] hover:bg-[#e0e0e0] transition-colors"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>Start VPS</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void checkConsole()}
            className="flex items-center gap-1.5 rounded-md border border-[#2A2A2A] bg-[#181818] px-3 py-1.5 text-xs text-[#F5F5F5] hover:bg-[#222] transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Retry</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={terminalWrapperRef}
      className={`flex flex-col rounded-lg border border-[#2A2A2A] bg-[#000000] overflow-hidden shadow-2xl transition-all ${
        isFullscreen
          ? "fixed inset-0 z-50 rounded-none border-none h-screen w-screen"
          : "min-h-[520px] h-[640px] w-full"
      }`}
    >
      {/* Horizontal Tabs Bar */}
      <TerminalTabs
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onAddSession={handleAddSession}
        onCloseSession={handleCloseSession}
        onRenameSession={handleRenameSession}
        onCloseAll={handleCloseAll}
      />

      {/* Terminal Action Toolbar */}
      <TerminalToolbar
        session={activeSession}
        preferences={preferences}
        onUpdatePreferences={handleUpdatePreferences}
        onReconnect={handleReconnectSession}
        onClearScreen={handleClearScreen}
        onFitTerminal={handleFitTerminal}
        isFullscreen={isFullscreen}
        onToggleFullscreen={handleToggleFullscreen}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Viewport for all terminal sessions (inactive preserved via hidden class) */}
      <div className="relative flex-1 w-full bg-[#000000] min-h-0 min-w-0 overflow-hidden flex flex-col">
        {sessions.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center font-mono text-xs text-[#888]">
            <TerminalIcon className="h-8 w-8 text-[#444] mb-2" />
            <p className="mb-3 text-[#aaa]">No active terminal sessions.</p>
            <button
              type="button"
              onClick={handleAddSession}
              className="rounded border border-[#2A2A2A] bg-[#181818] px-3 py-1.5 text-xs text-[#F5F5F5] hover:bg-[#252525] transition-colors"
            >
              Open New Terminal
            </button>
          </div>
        ) : (
          sessions.map((s) => (
            <TerminalSession
              key={s.id}
              instanceId={instanceId}
              session={s}
              isActive={s.id === activeSessionId}
              preferences={preferences}
              onUpdateSession={handleUpdateSession}
              apiBase={apiBase}
            />
          ))
        )}
      </div>

      {/* Status Bar / Shortcut footer */}
      <div className="flex items-center justify-between border-t border-[#1e1e1e] bg-[#0c0c0c] px-3 py-1 text-[11px] font-mono text-[#666] select-none">
        <div className="flex items-center gap-3">
          <span>{sessions.length} / {MAX_SESSIONS} sessions</span>
          <span className="hidden md:inline">Ctrl+Shift+C / Ctrl+Shift+V for clipboard</span>
        </div>
        <div className="flex items-center gap-2">
          <span>JetBrains Mono</span>
          <span>·</span>
          <span>xterm-256color</span>
        </div>
      </div>

      {/* Preferences Dialog */}
      <TerminalSettings
        isOpen={isSettingsOpen}
        onClose={() => {
          setIsSettingsOpen(false);
          activeSession?.term?.focus();
        }}
        preferences={preferences}
        onUpdatePreferences={handleUpdatePreferences}
      />
    </div>
  );
}
