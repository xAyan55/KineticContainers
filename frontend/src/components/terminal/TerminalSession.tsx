import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import {
  FONT_FAMILY_STACK,
  type TerminalPreferences,
  type TerminalSessionItem,
} from "./terminalTypes";

interface TerminalSessionProps {
  instanceId: string;
  session: TerminalSessionItem;
  isActive: boolean;
  preferences: TerminalPreferences;
  onUpdateSession: (id: string, updates: Partial<TerminalSessionItem>) => void;
  apiBase?: string;
}

export function TerminalSession({
  instanceId,
  session,
  isActive,
  preferences,
  onUpdateSession,
  apiBase,
}: TerminalSessionProps): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const fitAddonRef = React.useRef<FitAddon | null>(null);
  const searchAddonRef = React.useRef<SearchAddon | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const resizeDebounceRef = React.useRef<number | null>(null);

  // Initialize Terminal & WebSocket connection for this session once
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.replaceChildren();

    const term = new Terminal({
      cursorBlink: preferences.cursorBlink,
      cursorStyle: preferences.cursorStyle,
      fontSize: preferences.fontSize,
      fontFamily: preferences.fontFamily || FONT_FAMILY_STACK,
      scrollback: preferences.scrollback,
      allowTransparency: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      theme: {
        background: "#000000",
        foreground: "#F5F5F5",
        cursor: "#F5F5F5",
        cursorAccent: "#000000",
        selectionBackground: "#333333",
        selectionForeground: "#FFFFFF",
        black: "#000000",
        red: "#EF4444",
        green: "#10B981",
        yellow: "#F59E0B",
        blue: "#3B82F6",
        magenta: "#A855F7",
        cyan: "#06B6D4",
        white: "#F5F5F5",
        brightBlack: "#4B5563",
        brightRed: "#F87171",
        brightGreen: "#34D399",
        brightYellow: "#FBBF24",
        brightBlue: "#60A5FA",
        brightMagenta: "#C084FC",
        brightCyan: "#22D3EE",
        brightWhite: "#FFFFFF",
      },
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon();
    const unicode11 = new Unicode11Addon();

    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(webLinks);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.open(container);

    termRef.current = term;
    fitAddonRef.current = fit;
    searchAddonRef.current = search;

    onUpdateSession(session.id, {
      term,
      fitAddon: fit,
      searchAddon: search,
      phase: "connecting",
    });

    const doFit = () => {
      try {
        if (container.clientWidth > 10 && container.clientHeight > 10) {
          fit.fit();
          return { cols: term.cols, rows: term.rows };
        }
      } catch {
        /* ignore */
      }
      return null;
    };

    // Wait for fonts to load before initial fit
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        doFit();
      });
    }

    // Build WebSocket URL
    const wsPath = `/api/instances/${encodeURIComponent(instanceId)}/console`;
    const searchParams = new URLSearchParams({
      session: session.id,
      cols: String(term.cols || 80),
      rows: String(term.rows || 24),
    });

    let wsUrl: string;
    if (apiBase) {
      try {
        const u = new URL(apiBase, window.location.href);
        const proto = u.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = `${proto}//${u.host}${wsPath}?${searchParams.toString()}`;
      } catch {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = `${proto}//${window.location.host}${wsPath}?${searchParams.toString()}`;
      }
    } else {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = `${proto}//${window.location.host}${wsPath}?${searchParams.toString()}`;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    onUpdateSession(session.id, { ws });

    ws.onopen = () => {
      onUpdateSession(session.id, { phase: "connected", error: undefined });
      const dims = doFit();
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
        onUpdateSession(session.id, { cols: dims.cols, rows: dims.rows });
      }
      if (isActive) {
        term.focus();
      }
    };

    ws.onmessage = async (ev: MessageEvent) => {
      let text = "";
      if (typeof ev.data === "string") {
        text = ev.data;
      } else if (ev.data instanceof Blob) {
        text = await ev.data.text();
      } else if (ev.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(ev.data);
      } else {
        return;
      }

      let msg: {
        type?: string;
        data?: string;
        message?: string;
        cols?: number;
        rows?: number;
        shell?: string;
      };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.type === "ready") {
        onUpdateSession(session.id, {
          phase: "connected",
          shell: msg.shell ?? null,
          cols: msg.cols ?? term.cols,
          rows: msg.rows ?? term.rows,
        });
      } else if (msg.type === "output" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "exit") {
        onUpdateSession(session.id, { phase: "closed" });
        term.write("\r\n\x1b[90m[Process completed]\x1b[0m\r\n");
      } else if (msg.type === "error") {
        onUpdateSession(session.id, { phase: "error", error: msg.message ?? "Console error." });
        term.write(`\r\n\x1b[31m[Error: ${msg.message ?? "Console error"}]\x1b[0m\r\n`);
      }
    };

    ws.onclose = (ev) => {
      onUpdateSession(session.id, { phase: "closed" });
      if (ev.code !== 1000 && ev.code !== 1001) {
        onUpdateSession(session.id, {
          phase: "error",
          error: ev.reason || `Disconnected (code ${ev.code})`,
        });
      }
    };

    ws.onerror = () => {
      onUpdateSession(session.id, {
        phase: "error",
        error: "Connection failed. Check if VPS is running.",
      });
    };

    const dataSub = term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
        onUpdateSession(session.id, { cols, rows });
      }
    });

    // Copy on select handler
    let selectionSub: { dispose: () => void } | null = null;
    if (preferences.copyOnSelect) {
      selectionSub = term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => undefined);
        }
      });
    }

    // ResizeObserver with coalescing
    const ro = new ResizeObserver(() => {
      if (resizeDebounceRef.current) {
        window.cancelAnimationFrame(resizeDebounceRef.current);
      }
      resizeDebounceRef.current = window.requestAnimationFrame(() => {
        const dims = doFit();
        if (dims && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
          onUpdateSession(session.id, { cols: dims.cols, rows: dims.rows });
        }
      });
    });
    ro.observe(container);

    return () => {
      dataSub.dispose();
      resizeSub.dispose();
      if (selectionSub) selectionSub.dispose();
      ro.disconnect();
      if (resizeDebounceRef.current) {
        window.cancelAnimationFrame(resizeDebounceRef.current);
      }
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "terminate" }));
          ws.close(1000, "client unmount");
        }
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      wsRef.current = null;
    };
  }, [instanceId, session.id]);

  // When active tab changes, refit and focus without re-instantiating!
  React.useEffect(() => {
    if (isActive && fitAddonRef.current && containerRef.current) {
      const container = containerRef.current;
      const fit = fitAddonRef.current;
      const term = termRef.current;
      const ws = wsRef.current;

      const timer = window.setTimeout(() => {
        try {
          if (container.clientWidth > 10 && container.clientHeight > 10) {
            fit.fit();
            if (term && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
              onUpdateSession(session.id, { cols: term.cols, rows: term.rows });
            }
            term?.focus();
          }
        } catch {
          /* ignore */
        }
      }, 50);

      return () => clearTimeout(timer);
    }
  }, [isActive, session.id]);

  // Update dynamic terminal preferences without resetting scrollback or restarting process
  React.useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    term.options.fontSize = preferences.fontSize;
    term.options.fontFamily = preferences.fontFamily || FONT_FAMILY_STACK;
    term.options.cursorStyle = preferences.cursorStyle;
    term.options.cursorBlink = preferences.cursorBlink;
    term.options.scrollback = preferences.scrollback;

    if (isActive && fitAddonRef.current && containerRef.current) {
      window.requestAnimationFrame(() => {
        try {
          fitAddonRef.current?.fit();
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            onUpdateSession(session.id, { cols: term.cols, rows: term.rows });
          }
        } catch {
          /* ignore */
        }
      });
    }
  }, [preferences, isActive, session.id]);

  return (
    <div
      ref={containerRef}
      className={`kinetic-terminal-container h-full w-full bg-[#000000] cursor-text overflow-hidden p-1 ${
        isActive ? "block flex-1 min-h-0 min-w-0" : "hidden"
      }`}
      onClick={() => {
        if (isActive && termRef.current) {
          termRef.current.focus();
        }
      }}
      tabIndex={isActive ? 0 : -1}
      aria-label={`${session?.title ?? "Terminal"} terminal`}
    />
  );
}
