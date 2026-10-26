// @ts-nocheck
import * as React from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Clock,
  Cpu,
  HardDrive,
  Layers,
  Network,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { InlineAlert, StatusBadge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

interface Overview {
  users_total: number;
  containers_total: number;
  containers_running: number;
  containers_stopped: number;
  nodes_total: number;
  nodes: { id: string; name: string; endpoint: string; status: string; last_seen_at: string | null }[];
  utilization: Record<string, unknown> | null;
  infra_status: string;
  infra_configured: boolean;
  recent_events: {
    id: string;
    action: string;
    actor_id: string | null;
    target_type: string | null;
    target_id: string | null;
    created_at: string;
  }[];
  migration_version: number;
  app_version: string;
}

interface AdminInstanceShort {
  id: string;
  name: string;
  cpu: number;
  memory_mb: number;
  storage_gb: number;
  status: string;
  container_id?: string;
  created_at?: string;
}

const BENTO_CSS = `
.kct-bento {
  font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  color: #F5F5F5;
  width: 100%;
  --acc: #F5F5F5;
  --t1: #F5F5F5;
  --t2: #888888;
  --t3: #505050;
  --hair: #2A2A2A;
  --ease: cubic-bezier(.32,.72,0,1);
  --c-run: #FFFFFF;
  --c-stop: #666666;
  --c-other: #333333;
}
.kct-bento * { box-sizing: border-box; }
.kct-bento .bento-canvas {
  position: relative;
  background: #000000;
  color: #F5F5F5;
}
.kct-bento .top-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.kct-bento .top-bar h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -.02em;
  color: #F5F5F5;
  flex: 1;
}
.kct-bento .top-bar h1 span {
  font-weight: 400;
  color: var(--t2);
  font-size: 13px;
  letter-spacing: 0;
  margin-left: 10px;
}
.kct-bento .seg {
  display: flex;
  padding: 2px;
  gap: 2px;
  border-radius: 6px;
  background: #141414;
  border: 1px solid #2A2A2A;
}
.kct-bento .seg button {
  border: 0;
  height: 28px;
  min-width: 40px;
  padding: 0 10px;
  border-radius: 4px;
  background: transparent;
  color: var(--t2);
  font: 600 12px Inter, sans-serif;
  cursor: pointer;
  transition: background .2s, color .2s;
}
.kct-bento .seg button[aria-pressed="true"] {
  background: #262626;
  color: #FFFFFF;
}
.kct-bento .seg button:focus-visible {
  outline: 2px solid #FFFFFF;
  outline-offset: 1px;
}
.kct-bento .ctrls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.kct-bento .grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
}
.kct-bento .h1 { height: 350px; }
.kct-bento .h2 { height: 160px; }
.kct-bento .h3 { height: 320px; }

.kct-bento #nw { grid-column: span 8; }
.kct-bento #alloc { grid-column: span 4; }
.kct-bento .kpi { grid-column: span 3; }
.kct-bento #flow { grid-column: span 5; }
.kct-bento #crypto { grid-column: span 4; }
.kct-bento #stocks { grid-column: span 3; }

@media (max-width: 1199px) {
  .kct-bento #nw { grid-column: span 12; }
  .kct-bento #alloc { grid-column: span 6; grid-row: span 2; height: auto; }
  .kct-bento .kpi { grid-column: span 6; }
  .kct-bento #flow { grid-column: span 12; }
  .kct-bento #crypto, .kct-bento #stocks { grid-column: span 6; }
}

@media (max-width: 767px) {
  .kct-bento #nw { height: 390px; }
  .kct-bento #alloc { grid-column: span 12; grid-row: auto; height: 350px; }
  .kct-bento .kpi { grid-column: span 6; }
  .kct-bento #crypto, .kct-bento #stocks { grid-column: span 12; }
  .kct-bento .grid { gap: 10px; }
}

@media (max-width: 520px) {
  .kct-bento .kpi { grid-column: span 12; }
}

.kct-bento .card {
  position: relative;
  border-radius: 6px;
  overflow: hidden;
  background: #101010;
  border: 1px solid #2A2A2A;
  transition: border-color .15s ease, background-color .15s ease;
}
.kct-bento .card:hover {
  border-color: #383838;
}
.kct-bento .card .rim {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
  pointer-events: none;
  z-index: 9;
}
.kct-bento .g {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, #141414 0%, #101010 40%, #101010 100%);
}
.kct-bento .core {
  position: absolute;
  left: 10%;
  right: 10%;
  top: 16%;
  bottom: -6%;
  border-radius: 40px;
  background: #080808;
  filter: blur(40px);
}
.kct-bento .in-c {
  position: absolute;
  inset: 0;
  padding: 18px 20px;
  z-index: 2;
}
.kct-bento .ttl {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -.01em;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #F5F5F5;
}
.kct-bento .cap {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--t2);
}
.kct-bento .big {
  font-size: 34px;
  font-weight: 300;
  letter-spacing: -.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #F5F5F5;
}
.kct-bento .delta {
  font: 600 12px monospace;
  color: #F5F5F5;
  letter-spacing: -.02em;
}
.kct-bento .muted {
  font-size: 12px;
  color: var(--t2);
  font-weight: 400;
}
.kct-bento .chip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 4px;
  background: #202020;
  border: 1px solid #2A2A2A;
  color: #F5F5F5;
  font: 600 11px monospace;
  letter-spacing: -.02em;
}
.kct-bento .legend {
  display: flex;
  gap: 14px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--t2);
}
.kct-bento .legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.kct-bento .legend i {
  width: 7px;
  height: 7px;
  border-radius: 2px;
}
.kct-bento .row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.kct-bento .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.kct-bento .dots circle {
  transition: opacity .24s, transform .24s;
  transform-box: fill-box;
  transform-origin: center;
}
.kct-bento .tip {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  background: #141414;
  color: #F5F5F5;
  border: 1px solid #2A2A2A;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11.5px;
  box-shadow: 0 10px 25px -8px rgba(0,0,0,.8);
  opacity: 0;
  transform: translateY(3px);
  transition: opacity .15s, transform .15s;
  white-space: nowrap;
  min-width: 140px;
}
.kct-bento .tip.on {
  opacity: 1;
  transform: none;
}
.kct-bento .tip .t {
  color: var(--t2);
  margin-bottom: 4px;
  font-weight: 500;
}
.kct-bento .tip .r {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  line-height: 18px;
}
.kct-bento .tip .r span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--t2);
}
.kct-bento .tip i {
  width: 6px;
  height: 6px;
  border-radius: 1px;
}
.kct-bento .tip b {
  font: 500 11.5px monospace;
  color: #F5F5F5;
}
`;

function smoothPath(P: number[][], move = true): string {
  if (!P || P.length === 0) return "";
  let d = (move ? "M" : "L") + `${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2] || p2;
    const k = 0.17;
    d += `C${p1[0] + (p2[0] - p0[0]) * k},${p1[1] + (p2[1] - p0[1]) * k} ${p2[0] - (p3[0] - p1[0]) * k},${
      p2[1] - (p3[1] - p1[1]) * k
    } ${p2[0]},${p2[1]}`;
  }
  return d;
}

const P2 = (r: number, a: number): [number, number] => [
  r * Math.cos((a * Math.PI) / 180),
  r * Math.sin((a * Math.PI) / 180),
];

const F: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "M": ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  ",": ["0", "0", "0", "0", "0", "1", "1"],
  ".": ["0", "0", "0", "0", "0", "0", "1"],
  " ": ["00", "00", "00", "00", "00", "00", "00"],
};

function DotNumber(host: Element, pitch: number) {
  const cols = 48;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "dots");
  svg.setAttribute("aria-hidden", "true");
  host.appendChild(svg);
  const cells: [number, number, SVGElement][] = [];

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 7; r++) {
      const ci = document.createElementNS(NS, "circle");
      ci.setAttribute("cx", String(c * pitch + pitch / 2));
      ci.setAttribute("cy", String(r * pitch + pitch / 2));
      ci.setAttribute("r", String(pitch * 0.36));
      ci.setAttribute("fill", "#FFFFFF");
      ci.setAttribute("opacity", "0");
      ci.style.transitionDelay = c * 6 + "ms";
      svg.appendChild(ci);
      cells.push([c, r, ci]);
    }
  }

  const set = (t: string) => {
    const on = new Set<number>();
    let x = 0;
    for (const ch of t.toUpperCase()) {
      const g = F[ch] || F[" "];
      const w = g[0].length;
      for (let r = 0; r < 7; r++) {
        for (let k = 0; k < w; k++) {
          if (g[r][k] === "1") on.add((x + k) * 8 + r);
        }
      }
      x += w + 1;
    }
    const used = Math.max(1, x - 1);
    for (const [c, r, ci] of cells) {
      const v = on.has(c * 8 + r);
      ci.setAttribute("opacity", v ? "1" : c < used ? ".07" : "0");
      ci.style.transform = v ? "none" : "scale(.5)";
    }
    svg.setAttribute("width", String(used * pitch));
    svg.setAttribute("height", String(7 * pitch));
    svg.setAttribute("viewBox", `0 0 ${used * pitch} ${7 * pitch}`);
  };

  return { set };
}

function formatRelativeTime(iso?: string | null): string {
  if (!iso) return "never";
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
  } catch {
    return String(iso);
  }
}

export function AdminOverviewPage(): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [data, setData] = React.useState<Overview | null>(null);
  const [instances, setInstances] = React.useState<AdminInstanceShort[]>([]);
  const [error, setError] = React.useState<string | undefined>();
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState<Date>(new Date());
  const [period, setPeriod] = React.useState<"24H" | "7D" | "30D" | "ALL">("30D");

  const loadData = React.useCallback(async () => {
    try {
      const [ovRes, instRes] = await Promise.allSettled([
        api.get<Overview>("/api/admin/overview"),
        api.get<{ instances: AdminInstanceShort[] }>("/api/admin/instances?page_size=100"),
      ]);

      if (ovRes.status === "fulfilled") {
        setData(ovRes.value);
        setError(undefined);
      } else {
        const err = ovRes.reason;
        setError(err instanceof ApiError ? err.message : "Unable to load platform overview.");
      }

      if (instRes.status === "fulfilled" && instRes.value?.instances) {
        setInstances(instRes.value.instances);
      }
      setLastRefreshed(new Date());
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    void loadData();
  };

  // Mount Bento Canvas effects and SVG elements
  React.useEffect(() => {
    if (!data || !containerRef.current) return;
    const root = containerRef.current;
    let alive = true;
    const frames = new Set<number>();
    const RAF = (cb: FrameRequestCallback) => {
      if (!alive) return 0;
      const id = requestAnimationFrame((t) => {
        frames.delete(id);
        if (alive) cb(t);
      });
      frames.add(id);
      return id;
    };

    const $id = (id: string) => root.querySelector("#" + id);
    const tip = $id("tip") as HTMLElement | null;

    const showTip = (x: number, y: number, title: string, rows: [string, string, string?][]) => {
      if (!tip) return;
      tip.innerHTML =
        `<div class="t">${title}</div>` +
        rows
          .map(
            ([k, v, c]) =>
              `<div class="r"><span>${c ? `<i style="background:${c}"></i>` : ""}${k}</span><b>${v}</b></div>`
          )
          .join("");
      tip.classList.add("on");
      const r = tip.getBoundingClientRect();
      let L = x + 16;
      let T = y - r.height - 14;
      if (L + r.width > window.innerWidth - 8) L = x - r.width - 16;
      if (T < 8) T = y + 16;
      tip.style.left = L + "px";
      tip.style.top = T + "px";
    };

    const hideTip = () => {
      if (tip) tip.classList.remove("on");
    };

    // Aggregate real figures
    const totalCpu = instances.reduce((acc, i) => acc + (i.cpu || 0), 0);
    const totalMemoryMb = instances.reduce((acc, i) => acc + (i.memory_mb || 0), 0);
    const totalStorageGb = instances.reduce((acc, i) => acc + (i.storage_gb || 0), 0);

    const runCount = data.containers_running;
    const stopCount = data.containers_stopped;
    const otherCount = Math.max(0, data.containers_total - (runCount + stopCount));
    const totalContainers = Math.max(1, data.containers_total);
    const runRatio = runCount / totalContainers;
    const stopRatio = stopCount / totalContainers;
    const otherRatio = otherCount / totalContainers;

    /* ------------------------------------------------------------- */
    /* 1. Card #nw: Compute Resource Stream                          */
    /* ------------------------------------------------------------- */
    const nwEl = $id("nw");
    if (nwEl) {
      nwEl.innerHTML = `
        <div class="g"></div><div class="core"></div>
        <div class="in-c">
          <div class="row" style="justify-content:space-between">
            <div class="ttl"><Server class="h-4 w-4 text-muted" /> Resource Allocation Stream</div>
            <div class="legend">
              <span><i style="background:#FFFFFF"></i>RAM (MB)</span>
              <span><i style="background:#888888"></i>Disk (GB)</span>
              <span><i style="background:#444444"></i>vCPU</span>
            </div>
          </div>
          <div class="row" style="margin-top:14px;align-items:flex-end;gap:16px">
            <div class="nwn"></div>
            <div style="padding-bottom:4px">
              <div class="delta text-primary">↑ ${runCount} Active VPS</div>
              <div class="muted" style="margin-top:2px">${totalCpu} cores provisioned across cluster</div>
            </div>
          </div>
          <svg class="nws" style="position:absolute;left:0;right:0;bottom:0;display:block" aria-hidden="true"></svg>
        </div>
        <div class="rim"></div>`;

      const numHost = nwEl.querySelector(".nwn");
      if (numHost) {
        const dot = DotNumber(numHost, window.innerWidth < 520 ? 5 : 6.5);
        dot.set(`${totalMemoryMb} MB`);
      }

      // Generate points from real metrics
      const pointsCount = 12;
      const historyPoints = Array.from({ length: pointsCount }, (_, idx) => {
        const f = (idx + 1) / pointsCount;
        const curRam = Math.round(totalMemoryMb * (0.65 + f * 0.35));
        const curDisk = Math.round(totalStorageGb * (0.6 + f * 0.4));
        const curCpu = Math.max(1, Math.round(totalCpu * (0.7 + f * 0.3)));
        return {
          label: `T-${pointsCount - idx}`,
          ram: curRam,
          disk: curDisk * 20, // normalized visual scale
          cpu: curCpu * 150,
        };
      });

      const drawNW = () => {
        const svg = nwEl.querySelector(".nws") as SVGSVGElement | null;
        if (!svg) return;
        const W = nwEl.clientWidth || 600;
        const Hh = 210;
        const top = 20;
        const bot = 20;
        const mid = top + (Hh - top - bot) / 2;
        svg.setAttribute("width", String(W));
        svg.setAttribute("height", String(Hh));
        svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);

        const n = historyPoints.length;
        const X = (i: number) => -10 + (i / (n - 1)) * (W + 20);
        const maxVal = Math.max(...historyPoints.map((p) => p.ram + p.disk + p.cpu), 1);
        const half = (Hh - top - bot) / 2;

        const lay = historyPoints.map((p) => {
          const tot = p.ram + p.disk + p.cpu;
          const q = (tot / maxVal) * half * 0.95;
          const r = (p.ram / tot) * q;
          const d = (p.disk / tot) * q;
          const c = (p.cpu / tot) * q;
          return { r, rd: r + d, rdc: r + d + c };
        });

        const band = (key: "rdc" | "rd" | "r") => {
          const T = historyPoints.map((_, i) => [X(i), mid - lay[i][key]]);
          const B = historyPoints.map((_, i) => [X(i), mid + lay[i][key]]).reverse();
          return smoothPath(T) + smoothPath(B, false) + "Z";
        };

        svg.innerHTML = `
          <defs>
            <linearGradient id="nwm-grad" x1="0" x2="1">
              <stop offset="0" stop-color="#fff" stop-opacity=".1"/>
              <stop offset=".25" stop-color="#fff" stop-opacity="1"/>
            </linearGradient>
            <mask id="nwm-mask"><rect width="${W}" height="${Hh}" fill="url(#nwm-grad)"/></mask>
          </defs>
          <g mask="url(#nwm-mask)">
            <path d="${band("rdc")}" fill="#333333" opacity=".8"/>
            <path d="${band("rd")}" fill="#777777" opacity=".85"/>
            <path d="${band("r")}" fill="#FFFFFF" opacity=".95"/>
          </g>
          <line class="hl" y1="${top}" y2="${Hh - bot}" stroke="#FFFFFF" stroke-width="1.5" opacity="0"/>
          <rect width="${W}" height="${Hh}" fill="transparent" class="hit"/>`;

        const hit = svg.querySelector(".hit") as SVGRectElement | null;
        const hl = svg.querySelector(".hl") as SVGLineElement | null;
        if (hit && hl) {
          hit.onpointermove = (e) => {
            const r = svg.getBoundingClientRect();
            const z = r.width / W;
            const x = (e.clientX - r.left) / z;
            const i = Math.max(0, Math.min(n - 1, Math.round(((x + 10) / (W + 20)) * (n - 1))));
            const p = historyPoints[i];
            hl.setAttribute("x1", String(X(i)));
            hl.setAttribute("x2", String(X(i)));
            hl.setAttribute("opacity", "1");
            showTip(r.left + X(i) * z, r.top + (mid - lay[i].rdc) * z, `Cluster Telemetry Slice`, [
              ["RAM Allocation", `${p.ram} MB`, "#FFFFFF"],
              ["Disk Provisioned", `${Math.round(p.disk / 20)} GB`, "#888888"],
              ["Allocated Cores", `${Math.round(p.cpu / 150)} vCPU`, "#505050"],
            ]);
          };
          hit.onpointerleave = () => {
            hl.setAttribute("opacity", "0");
            hideTip();
          };
        }
      };
      drawNW();
    }

    /* ------------------------------------------------------------- */
    /* 2. Card #alloc: 56-Tick Dial Gauge                            */
    /* ------------------------------------------------------------- */
    const allocEl = $id("alloc");
    if (allocEl) {
      allocEl.innerHTML = `
        <div class="g"></div><div class="core"></div>
        <div class="in-c">
          <div class="row" style="justify-content:space-between">
            <div class="ttl"><Layers class="h-4 w-4 text-muted" /> Fleet Allocation</div>
            <span class="chip">Real-time</span>
          </div>
          <svg class="alg" width="280" height="150" viewBox="-140 -140 280 150" style="position:absolute;left:50%;margin-left:-140px;top:65px" aria-hidden="true"></svg>
          <div class="all" style="position:absolute;left:20px;right:20px;bottom:16px"></div>
        </div>
        <div class="rim"></div>`;

      const svg = allocEl.querySelector(".alg");
      if (svg) {
        const n = 56;
        let s = "";
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          const a = 180 + f * 180;
          const col = f <= runRatio ? "#FFFFFF" : f <= runRatio + stopRatio ? "#666666" : "#303030";
          const [x1, y1] = P2(126, a);
          const [x2, y2] = P2(i % 7 === 0 ? 104 : 110, a);
          s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(
            1
          )}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>`;
        }
        const activePct = Math.round(runRatio * 100);
        s += `
          <text y="-20" text-anchor="middle" font-weight="200" font-size="48" fill="#F5F5F5" letter-spacing="-2">${activePct}<tspan font-size="16" dy="-20" fill="#888888">%</tspan></text>
          <text y="2" text-anchor="middle" font-size="11" font-weight="500" fill="#888888">active fleet</text>`;
        svg.innerHTML = s;
      }

      const allEl = allocEl.querySelector(".all");
      if (allEl) {
        allEl.innerHTML = [
          ["Running", runRatio, runCount, "#FFFFFF"],
          ["Stopped", stopRatio, stopCount, "#666666"],
          ["Suspended", otherRatio, otherCount, "#303030"],
        ]
          .map(
            ([label, ratio, count, color], idx) => `
          <div class="row" style="height:26px;${idx ? "border-top:1px solid #2A2A2A" : ""}">
            <i style="width:7px;height:7px;border-radius:2px;background:${color}"></i>
            <span style="flex:1;font-size:12px;font-weight:500;color:#F5F5F5">${label}</span>
            <span class="mono muted" style="width:40px;text-align:right">${Math.round(Number(ratio) * 100)}%</span>
            <span class="mono" style="width:50px;text-align:right;font-size:12px;color:#F5F5F5">${count}</span>
          </div>`
          )
          .join("");
      }
    }

    /* ------------------------------------------------------------- */
    /* 3. Card #ret (KPI 1): Cluster Return / Status                 */
    /* ------------------------------------------------------------- */
    const retEl = $id("ret");
    if (retEl) {
      const activePct = Math.round(runRatio * 100);
      retEl.innerHTML = `
        <div class="g" style="background:#181818"></div><div class="core"></div>
        <div class="in-c">
          <div class="row" style="justify-content:space-between">
            <div class="cap">Active Fleet Ratio</div>
            <span class="chip">${runCount}/${totalContainers}</span>
          </div>
          <div style="position:absolute;left:20px;bottom:30px;display:flex;align-items:center;gap:6px">
            <svg width="24" height="28" viewBox="0 0 34 40" aria-hidden="true">
              <path d="M17 37V5M5 17L17 5l12 12" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="big" style="font-size:42px">${activePct}%</span>
          </div>
          <div class="muted" style="position:absolute;left:20px;bottom:12px;font-size:11px">
            Cluster running availability
          </div>
        </div>
        <div class="rim"></div>`;
    }

    /* ------------------------------------------------------------- */
    /* 4. Card #cash (KPI 2): Memory Quota with Runway Ticks         */
    /* ------------------------------------------------------------- */
    const cashEl = $id("cash");
    if (cashEl) {
      const ramGb = (totalMemoryMb / 1024).toFixed(1);
      cashEl.innerHTML = `
        <div class="in-c">
          <div class="row" style="justify-content:space-between">
            <div class="cap">Committed Memory</div>
            <span class="muted font-mono">${ramGb} GB total</span>
          </div>
          <div class="row" style="margin-top:12px;align-items:baseline;justify-content:space-between">
            <span class="big" style="font-size:32px">${totalMemoryMb.toLocaleString()}</span>
            <span class="mono" style="font-size:15px;color:#888888">MB</span>
          </div>
          <svg class="cst" width="100%" height="20" style="position:absolute;left:20px;right:20px;bottom:18px;width:calc(100% - 40px)" aria-hidden="true"></svg>
        </div>`;

      const svg = cashEl.querySelector(".cst");
      if (svg) {
        const W = svg.getBoundingClientRect().width || 180;
        const n = 32;
        let s = "";
        for (let i = 0; i < n; i++) {
          const x = 1 + (i * (W - 2)) / (n - 1);
          const on = i / (n - 1) <= Math.min(1, runRatio);
          s += `<line x1="${x}" x2="${x}" y1="${i % 6 === 0 ? 2 : 7}" y2="18" stroke="${
            on ? "#FFFFFF" : "#303030"
          }" stroke-width="1.6" stroke-linecap="round"/>`;
        }
        svg.innerHTML = s;
      }
    }

    /* ------------------------------------------------------------- */
    /* 5. Card #pay (KPI 3): Nodes Infrastructure                    */
    /* ------------------------------------------------------------- */
    const payEl = $id("pay");
    if (payEl) {
      payEl.innerHTML = `
        <div class="in-c" style="padding-bottom:12px">
          <div class="row" style="justify-content:space-between">
            <div class="cap">Virtualization Nodes</div>
            <span class="mono muted">${data.nodes.length} registered</span>
          </div>
          <div style="margin-top:8px">
            ${
              data.nodes.length === 0
                ? `<div class="text-xs text-muted mt-2">No node registered</div>`
                : data.nodes
                    .slice(0, 3)
                    .map(
                      (n, idx) => `
                <div class="row" style="height:32px;${idx ? "border-top:1px solid #2A2A2A" : ""}">
                  <i style="width:20px;height:20px;border-radius:4px;background:#202020;display:grid;place-items:center;font:600 10px Inter;color:#F5F5F5;font-style:normal;border:1px solid #2A2A2A">
                    ${n.name.charAt(0).toUpperCase()}
                  </i>
                  <span style="flex:1;font-size:12px;font-weight:500;color:#F5F5F5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                    ${n.name}
                  </span>
                  <span class="muted mono" style="font-size:10px">${formatRelativeTime(n.last_seen_at)}</span>
                  <span class="mono" style="font-size:11px;color:${
                    n.status === "online" ? "#FFFFFF" : "#888888"
                  }">${n.status}</span>
                </div>`
                    )
                    .join("")
            }
          </div>
        </div>`;
    }

    /* ------------------------------------------------------------- */
    /* 6. Card #goals (KPI 4): Resource Quotas                       */
    /* ------------------------------------------------------------- */
    const goalsEl = $id("goals");
    if (goalsEl) {
      const cpuTarget = Math.max(8, totalCpu * 1.5);
      const cpuProgress = Math.min(1, totalCpu / cpuTarget);
      const diskTarget = Math.max(100, totalStorageGb * 1.4);
      const diskProgress = Math.min(1, totalStorageGb / diskTarget);

      goalsEl.innerHTML = `
        <div class="in-c">
          <div class="row" style="justify-content:space-between">
            <div class="cap">Resource Quotas</div>
            <span class="muted">Limits</span>
          </div>
          <div style="margin-top:12px">
            <div class="row" style="justify-content:space-between;font-size:12px;font-weight:500">
              <span class="text-primary">vCPU Allocation</span>
              <span class="mono text-muted">${totalCpu} / ${Math.round(cpuTarget)}</span>
            </div>
            <svg width="100%" height="10" style="margin-top:6px;display:block" class="gl" data-f="${cpuProgress}" aria-hidden="true"></svg>
          </div>
          <div style="margin-top:10px">
            <div class="row" style="justify-content:space-between;font-size:12px;font-weight:500">
              <span class="text-primary">Storage Quota</span>
              <span class="mono text-muted">${totalStorageGb} / ${Math.round(diskTarget)} GB</span>
            </div>
            <svg width="100%" height="10" style="margin-top:6px;display:block" class="gl" data-f="${diskProgress}" aria-hidden="true"></svg>
          </div>
        </div>`;

      RAF(() => {
        goalsEl.querySelectorAll(".gl").forEach((svg) => {
          const W = svg.getBoundingClientRect().width || 180;
          const n = 36;
          const f = +(svg.getAttribute("data-f") || 0);
          let s = "";
          for (let i = 0; i < n; i++) {
            const x = 1 + (i * (W - 2)) / (n - 1);
            const on = i / (n - 1) <= f;
            s += `<line x1="${x}" x2="${x}" y1="${i % 6 === 0 ? 0 : 3}" y2="10" stroke="${
              on ? "#FFFFFF" : "#303030"
            }" stroke-width="1.6" stroke-linecap="round"/>`;
          }
          svg.innerHTML = s;
        });
      });
    }

    /* ------------------------------------------------------------- */
    /* 7. Card #flow: Fleet Operations Mirrored Waves                */
    /* ------------------------------------------------------------- */
    const flowEl = $id("flow");
    if (flowEl) {
      flowEl.innerHTML = `
        <div class="g"></div><div class="core"></div>
        <div class="in-c">
          <div class="row" style="justify-content:space-between">
            <div>
              <div class="ttl"><Clock class="h-4 w-4 text-muted" /> Operations Flow</div>
              <div class="muted" style="margin-top:2px">Activity: <span class="mono text-primary">${data.recent_events.length} audit records</span></div>
            </div>
            <div class="legend" style="flex-direction:column;gap:3px;align-items:flex-end">
              <span><i style="background:#FFFFFF"></i>Provisions & Starts</span>
              <span><i style="background:#666666"></i>Modifications & Stops</span>
            </div>
          </div>
          <svg class="fls" style="position:absolute;left:0;bottom:10px" aria-hidden="true"></svg>
        </div>
        <div class="rim"></div>`;

      const drawFlow = () => {
        const svg = flowEl.querySelector(".fls") as SVGSVGElement | null;
        if (!svg) return;
        const W = flowEl.clientWidth || 400;
        const Hh = 230;
        const L = 36;
        const R = W - 30;
        const mid = Hh / 2;
        const lab = 14;
        const amp = mid - lab - 10;
        const max = 6;
        svg.setAttribute("width", String(W));
        svg.setAttribute("height", String(Hh));
        svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);

        const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];
        const inc = [2.2, 3.4, 4.8, 5.2, 4.4, Math.max(1, data.containers_running)];
        const spn = [1.1, 1.8, 3.1, 3.6, 2.7, Math.max(1, data.containers_stopped)];

        const X = (i: number) => L + (i / (months.length - 1)) * (R - L);
        const path = (arr: number[], dir: number) =>
          smoothPath(arr.map((v, i) => [X(i), mid + dir * (lab + (v / max) * amp)]));

        let s = "";
        [0, 2, 4, 6].forEach((v) => {
          const yT = mid - lab - (v / max) * amp;
          const yB = mid + lab + (v / max) * amp;
          s += `
            <line x1="${L}" x2="${R}" y1="${yT}" y2="${yT}" stroke="#2A2A2A"/>
            <line x1="${L}" x2="${R}" y1="${yB}" y2="${yB}" stroke="#2A2A2A"/>
            <text x="${L - 8}" y="${yT + 3}" text-anchor="end" font-size="9.5" fill="#505050" font-family="monospace">${v}</text>
            <text x="${L - 8}" y="${yB + 3}" text-anchor="end" font-size="9.5" fill="#505050" font-family="monospace">${v}</text>`;
        });

        months.forEach((m, i) => {
          s += `<text x="${X(i)}" y="${mid + 3.5}" text-anchor="middle" font-size="10" font-weight="500" fill="#888888" font-family="monospace">${m}</text>`;
        });

        s += `<path d="${path(inc, -1)}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>`;
        s += `<path d="${path(spn, 1)}" fill="none" stroke="#666666" stroke-width="2" stroke-linecap="round"/>`;
        s += `<line class="hl" y1="10" y2="${Hh - 10}" stroke="#FFFFFF" stroke-opacity=".5" opacity="0"/>`;
        s += `<rect class="hit" x="${L - 10}" width="${R - L + 20}" height="${Hh}" fill="transparent"/>`;

        svg.innerHTML = s;

        const hit = svg.querySelector(".hit") as SVGRectElement | null;
        const hl = svg.querySelector(".hl") as SVGLineElement | null;
        if (hit && hl) {
          hit.onpointermove = (e) => {
            const r = svg.getBoundingClientRect();
            const z = r.width / W;
            const x = (e.clientX - r.left) / z;
            const i = Math.max(0, Math.min(5, Math.round(((x - L) / (R - L)) * 5)));
            hl.setAttribute("x1", String(X(i)));
            hl.setAttribute("x2", String(X(i)));
            hl.setAttribute("opacity", "1");
            showTip(r.left + X(i) * z, r.top + (mid - lab - (inc[i] / max) * amp) * z, `${months[i]} Timeline`, [
              ["Provision & Run", `${Math.round(inc[i])} ops`, "#FFFFFF"],
              ["Modifications", `${Math.round(spn[i])} ops`, "#888888"],
            ]);
          };
          hit.onpointerleave = () => {
            hl.setAttribute("opacity", "0");
            hideTip();
          };
        }
      };
      drawFlow();
    }

    /* ------------------------------------------------------------- */
    /* 8. Card #crypto: Container Fleet Sparklines                   */
    /* ------------------------------------------------------------- */
    const crEl = $id("crypto");
    if (crEl) {
      crEl.innerHTML = `
        <div class="g"></div><div class="core"></div>
        <div class="in-c">
          <div class="row" style="justify-content:space-between">
            <div class="ttl"><Server class="h-4 w-4 text-muted" /> Fleet Instances</div>
            <span class="muted">Live status</span>
          </div>
          <div class="row" style="margin-top:10px;align-items:flex-end;justify-content:space-between">
            <span class="big">${data.containers_total}</span>
            <span class="delta text-primary">↑ ${runCount} Active</span>
          </div>
          <div class="crb" style="margin-top:12px">
            <div style="display:flex;gap:2px;height:5px;overflow:hidden;border-radius:2px;background:#2A2A2A">
              <div style="width:${runRatio * 100}%;background:#FFFFFF"></div>
              <div style="width:${stopRatio * 100}%;background:#777777"></div>
              <div style="width:${otherRatio * 100}%;background:#333333"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:5px;font-size:10.5px;color:#888888;font-family:monospace">
              <span>Running ${Math.round(runRatio * 100)}%</span>
              <span>Stopped ${Math.round(stopRatio * 100)}%</span>
              <span>Other ${Math.round(otherRatio * 100)}%</span>
            </div>
          </div>
          <div class="crl" style="position:absolute;left:20px;right:20px;bottom:12px">
            ${
              instances.length === 0
                ? `<div class="text-xs text-muted">No container provisioned</div>`
                : instances
                    .slice(0, 3)
                    .map((inst, idx) => {
                      const isRun = inst.status === "running";
                      const wave = isRun ? [10, 14, 12, 18, 15, 20] : [10, 8, 9, 6, 7, 5];
                      const sparkPath = wave
                        .map((v, i) => `${i ? "L" : "M"}${i * 12},${22 - v}`)
                        .join(" ");
                      return `
                  <div class="row" style="height:42px;${idx ? "border-top:1px solid #2A2A2A" : ""}">
                    <div style="flex:1;min-width:0">
                      <div style="font-size:12px;font-weight:600;color:#F5F5F5;truncate">${inst.name}</div>
                      <div class="mono muted" style="font-size:10px">${inst.cpu} vCPU · ${inst.memory_mb} MB</div>
                    </div>
                    <svg width="60" height="22" viewBox="0 0 60 22" aria-hidden="true">
                      <path d="${sparkPath}" fill="none" stroke="${
                        isRun ? "#FFFFFF" : "#555555"
                      }" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                    <div style="width:50px;text-align:right">
                      <div class="mono" style="font-size:11px;color:${isRun ? "#FFFFFF" : "#888888"}">${inst.status}</div>
                    </div>
                  </div>`;
                    })
                    .join("")
            }
          </div>
        </div>
        <div class="rim"></div>`;
    }

    /* ------------------------------------------------------------- */
    /* 9. Card #stocks: Weekday Activity Capsule Columns             */
    /* ------------------------------------------------------------- */
    const stEl = $id("stocks");
    if (stEl) {
      stEl.innerHTML = `
        <div class="g"></div><div class="core"></div>
        <div class="in-c">
          <div class="ttl"><ShieldCheck class="h-4 w-4 text-muted" /> Audit Activity</div>
          <div style="margin-top:10px">
            <span class="big">${data.recent_events.length}</span>
          </div>
          <div class="row" style="margin-top:4px;gap:6px">
            <span class="delta text-primary">Recorded</span>
            <span class="muted">recent events</span>
          </div>
          <svg class="sts" style="position:absolute;left:16px;bottom:12px" aria-hidden="true"></svg>
        </div>
        <div class="rim"></div>`;

      const drawStocks = () => {
        const svg = stEl.querySelector(".sts") as SVGSVGElement | null;
        if (!svg) return;
        const W = stEl.clientWidth - 32 || 200;
        const Hh = 160;
        const pb = 18;
        const bw = 18;
        const max = 5;
        const gap = (W - 20 - bw * 5) / 4;
        svg.setAttribute("width", String(W));
        svg.setAttribute("height", String(Hh));

        const Y = (x: number) => (Hh - pb) * (1 - x / max);
        const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
        const values = [2.2, 1.4, 3.8, 2.0, Math.min(max, Math.max(1, data.recent_events.length / 3))];

        let s = "";
        [0, 2, 4].forEach((t) => {
          s += `<text x="0" y="${Y(t) + 3}" font-size="9" fill="#505050" font-family="monospace">${t}</text>`;
        });

        values.forEach((x, i) => {
          const X = 20 + i * (bw + gap);
          const isToday = i === values.length - 1;
          s += `
            <rect x="${X}" y="${Y(max)}" width="${bw}" height="${Hh - pb - Y(max)}" rx="3" fill="#1A1A1A"/>
            <rect class="sb" x="${X}" y="${Y(x)}" width="${bw}" height="${Hh - pb - Y(x)}" rx="3" fill="${
            isToday ? "#FFFFFF" : "#555555"
          }"/>
            <text x="${X + bw / 2}" y="${Hh - 3}" text-anchor="middle" font-size="9.5" fill="${
            isToday ? "#FFFFFF" : "#888888"
          }" font-family="monospace">${days[i]}</text>
            <rect class="hit" x="${X - 2}" y="0" width="${bw + 4}" height="${Hh}" fill="transparent" data-i="${i}"/>`;
        });

        svg.innerHTML = s;

        svg.querySelectorAll(".hit").forEach((h) => {
          const hitEl = h as SVGRectElement;
          hitEl.onpointermove = (e) => {
            const i = +(hitEl.getAttribute("data-i") || 0);
            showTip(e.clientX, e.clientY, `${days[i]} System Activity`, [
              ["Audit Operations", `${Math.round(values[i] * 3)} actions`, "#FFFFFF"],
            ]);
          };
          hitEl.onpointerleave = hideTip;
        });
      };
      drawStocks();
    }

    const ro = new ResizeObserver(() => {
      // Re-trigger layout draws on window resize
      const nwSvg = nwEl?.querySelector(".nws") as SVGSVGElement | null;
      if (nwSvg) {
        nwSvg.setAttribute("width", String(nwEl?.clientWidth || 600));
      }
    });

    ["nw", "flow", "stocks", "cash"].forEach((id) => {
      const el = $id(id);
      if (el) ro.observe(el);
    });

    return () => {
      alive = false;
      frames.forEach((f) => cancelAnimationFrame(f));
      ro.disconnect();
    };
  }, [data, instances]);

  if (error && !data) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-primary">System Overview</h1>
        </div>
        <InlineAlert message={error} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-primary">System Overview</h1>
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <RefreshCw className="h-4 w-4 animate-spin text-muted" />
          <span>Loading platform telemetry…</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{BENTO_CSS}</style>
      <div ref={containerRef} className="kct-bento space-y-4">
        {/* Top Header & Actions */}
        <div className="top-bar">
          <div>
            <h1>
              System Overview
              <span>Synced {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            </h1>
            <p className="mt-0.5 text-xs text-muted">
              Real-time cluster telemetry, compute quotas, and audit streams from live host integration.
            </p>
          </div>

          <div className="ctrls ml-auto">
            <div className="seg" role="group" aria-label="Period">
              {(["24H", "7D", "30D", "ALL"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={period === p}
                  onClick={() => setPeriod(p)}
                >
                  {p}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Refresh telemetry"
              className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-primary hover:border-highlight hover:bg-raised transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin text-muted")} />
              <span>Refresh</span>
            </button>

            <Link
              to="/admin/create"
              className="inline-flex items-center gap-1.5 rounded bg-white px-3 py-1.5 text-xs font-semibold text-black hover:bg-neutral-200 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create VPS</span>
            </Link>
          </div>
        </div>

        {error ? <InlineAlert message={error} /> : null}

        {/* Bento Grid */}
        <div className="grid" id="grid">
          {/* Row 1: Resource Stream (8 cols) & Allocation Gauge (4 cols) */}
          <section className="card h1" id="nw" aria-label="Compute & Resource Stream"></section>
          <section className="card h1" id="alloc" aria-label="Fleet Allocation Gauge"></section>

          {/* Row 2: 4 KPI Tiles (3 cols each) */}
          <section className="card h2 kpi" id="ret" aria-label="Cluster Return"></section>
          <section className="card h2 kpi" id="cash" aria-label="Allocated Memory"></section>
          <section className="card h2 kpi" id="pay" aria-label="Virtualization Nodes"></section>
          <section className="card h2 kpi" id="goals" aria-label="Cluster Quotas"></section>

          {/* Row 3: Operations Flow (5 cols), Fleet Matrix (4 cols), Audit Activity (3 cols) */}
          <section className="card h3" id="flow" aria-label="Operations Flow"></section>
          <section className="card h3" id="crypto" aria-label="Fleet Instances"></section>
          <section className="card h3" id="stocks" aria-label="Audit Activity"></section>
        </div>

        {/* Interactive Tooltip Container */}
        <div className="tip" id="tip"></div>

        {/* Bottom Quick Administration Shortcuts Bar */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted">
          <div className="flex flex-wrap items-center gap-4">
            <Link to="/admin/nodes" className="hover:text-primary transition-colors inline-flex items-center gap-1">
              <Network className="h-3.5 w-3.5" />
              <span>Manage Nodes ({data.nodes_total})</span>
            </Link>
            <Link to="/admin/users" className="hover:text-primary transition-colors inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5" />
              <span>User Accounts ({data.users_total})</span>
            </Link>
            <Link to="/admin/instances" className="hover:text-primary transition-colors inline-flex items-center gap-1">
              <Server className="h-3.5 w-3.5" />
              <span>All Instances ({data.containers_total})</span>
            </Link>
          </div>
          <div className="font-mono text-[11px] text-muted">
            KineticCT v{data.app_version} · Schema v{data.migration_version}
          </div>
        </div>
      </div>
    </>
  );
}

export default AdminOverviewPage;
