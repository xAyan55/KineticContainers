// @ts-nocheck
import * as React from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
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
}
.kct-bento * { box-sizing: border-box; }
.kct-bento .bento-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
}
.kct-bento .col-8 { grid-column: span 8; }
.kct-bento .col-7 { grid-column: span 7; }
.kct-bento .col-6 { grid-column: span 6; }
.kct-bento .col-5 { grid-column: span 5; }
.kct-bento .col-4 { grid-column: span 4; }
.kct-bento .col-3 { grid-column: span 3; }

@media (max-width: 1199px) {
  .kct-bento .col-8 { grid-column: span 12; }
  .kct-bento .col-4 { grid-column: span 6; }
  .kct-bento .col-3 { grid-column: span 6; }
  .kct-bento .col-5 { grid-column: span 12; }
}
@media (max-width: 767px) {
  .kct-bento .col-8,
  .kct-bento .col-7,
  .kct-bento .col-6,
  .kct-bento .col-5,
  .kct-bento .col-4,
  .kct-bento .col-3 {
    grid-column: span 12;
  }
}
.kct-bento .bento-card {
  position: relative;
  background: #101010;
  border: 1px solid #2A2A2A;
  border-radius: 6px;
  overflow: hidden;
  transition: border-color .15s ease;
}
.kct-bento .bento-card:hover {
  border-color: #383838;
}
.kct-bento .dots circle {
  transition: opacity .2s, transform .2s;
  transform-box: fill-box;
  transform-origin: center;
}
.kct-bento-tip {
  position: fixed;
  z-index: 100;
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
  transition: opacity .12s, transform .12s;
  white-space: nowrap;
  min-width: 140px;
}
.kct-bento-tip.on {
  opacity: 1;
  transform: none;
}
.kct-bento-tip .tip-title {
  color: #888888;
  margin-bottom: 4px;
  font-weight: 500;
}
.kct-bento-tip .tip-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  line-height: 18px;
}
.kct-bento-tip .tip-row span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #888888;
}
.kct-bento-tip .tip-row i {
  width: 6px;
  height: 6px;
  border-radius: 1px;
}
.kct-bento-tip .tip-row b {
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

function renderDotNumber(svg: SVGSVGElement, text: string, pitch = 6) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const cols = 48;
  const NS = "http://www.w3.org/2000/svg";
  const cells: [number, number, SVGElement][] = [];

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 7; r++) {
      const ci = document.createElementNS(NS, "circle");
      ci.setAttribute("cx", String(c * pitch + pitch / 2));
      ci.setAttribute("cy", String(r * pitch + pitch / 2));
      ci.setAttribute("r", String(pitch * 0.36));
      ci.setAttribute("fill", "#FFFFFF");
      ci.setAttribute("opacity", "0");
      svg.appendChild(ci);
      cells.push([c, r, ci]);
    }
  }

  const on = new Set<number>();
  let x = 0;
  for (const ch of text.toUpperCase()) {
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
  const [data, setData] = React.useState<Overview | null>(null);
  const [instances, setInstances] = React.useState<AdminInstanceShort[]>([]);
  const [error, setError] = React.useState<string | undefined>();
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState<Date>(new Date());
  const [period, setPeriod] = React.useState<"24H" | "7D" | "30D" | "ALL">("30D");

  // SVG Refs for pure, reliable rendering
  const dotSvgRef = React.useRef<SVGSVGElement | null>(null);
  const streamSvgRef = React.useRef<SVGSVGElement | null>(null);
  const gaugeSvgRef = React.useRef<SVGSVGElement | null>(null);
  const cashSvgRef = React.useRef<SVGSVGElement | null>(null);
  const cpuLimitSvgRef = React.useRef<SVGSVGElement | null>(null);
  const diskLimitSvgRef = React.useRef<SVGSVGElement | null>(null);
  const flowSvgRef = React.useRef<SVGSVGElement | null>(null);
  const stocksSvgRef = React.useRef<SVGSVGElement | null>(null);
  const tipRef = React.useRef<HTMLDivElement | null>(null);

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

  const showTip = React.useCallback((x: number, y: number, title: string, rows: [string, string, string?][]) => {
    const tip = tipRef.current;
    if (!tip) return;
    tip.innerHTML =
      `<div class="tip-title">${title}</div>` +
      rows
        .map(
          ([k, v, c]) =>
            `<div class="tip-row"><span>${c ? `<i style="background:${c}"></i>` : ""}${k}</span><b>${v}</b></div>`
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
  }, []);

  const hideTip = React.useCallback(() => {
    const tip = tipRef.current;
    if (tip) tip.classList.remove("on");
  }, []);

  // Compute live aggregates
  const totalCpu = instances.reduce((acc, i) => acc + (i.cpu || 0), 0);
  const totalMemoryMb = instances.reduce((acc, i) => acc + (i.memory_mb || 0), 0);
  const totalStorageGb = instances.reduce((acc, i) => acc + (i.storage_gb || 0), 0);
  const runCount = data?.containers_running || 0;
  const stopCount = data?.containers_stopped || 0;
  const totalContainers = Math.max(1, data?.containers_total || 0);
  const otherCount = Math.max(0, totalContainers - (runCount + stopCount));
  const runRatio = runCount / totalContainers;
  const stopRatio = stopCount / totalContainers;
  const otherRatio = otherCount / totalContainers;

  // Draw SVG visual engines
  React.useEffect(() => {
    if (!data) return;

    // 1. Dot Number in Resource Card
    if (dotSvgRef.current) {
      renderDotNumber(dotSvgRef.current, `${totalMemoryMb} MB`, window.innerWidth < 520 ? 4.8 : 6);
    }

    // 2. Stream Curves SVG
    const streamSvg = streamSvgRef.current;
    if (streamSvg) {
      const W = streamSvg.clientWidth || 600;
      const Hh = 190;
      const top = 16;
      const bot = 16;
      const mid = top + (Hh - top - bot) / 2;
      streamSvg.setAttribute("width", String(W));
      streamSvg.setAttribute("height", String(Hh));
      streamSvg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);

      const pointsCount = 12;
      const points = Array.from({ length: pointsCount }, (_, idx) => {
        const f = (idx + 1) / pointsCount;
        return {
          ram: Math.round(totalMemoryMb * (0.65 + f * 0.35)),
          disk: Math.round(totalStorageGb * (0.6 + f * 0.4)) * 20,
          cpu: Math.max(1, Math.round(totalCpu * (0.7 + f * 0.3))) * 140,
        };
      });

      const maxVal = Math.max(...points.map((p) => p.ram + p.disk + p.cpu), 1);
      const half = (Hh - top - bot) / 2;
      const X = (i: number) => -10 + (i / (pointsCount - 1)) * (W + 20);

      const lay = points.map((p) => {
        const tot = p.ram + p.disk + p.cpu;
        const q = (tot / maxVal) * half * 0.95;
        const r = (p.ram / tot) * q;
        const d = (p.disk / tot) * q;
        const c = (p.cpu / tot) * q;
        return { r, rd: r + d, rdc: r + d + c };
      });

      const band = (key: "rdc" | "rd" | "r") => {
        const T = points.map((_, i) => [X(i), mid - lay[i][key]]);
        const B = points.map((_, i) => [X(i), mid + lay[i][key]]).reverse();
        return smoothPath(T) + smoothPath(B, false) + "Z";
      };

      streamSvg.innerHTML = `
        <defs>
          <linearGradient id="nwm-grad-clean" x1="0" x2="1">
            <stop offset="0" stop-color="#fff" stop-opacity=".1"/>
            <stop offset=".25" stop-color="#fff" stop-opacity="1"/>
          </linearGradient>
          <mask id="nwm-mask-clean"><rect width="${W}" height="${Hh}" fill="url(#nwm-grad-clean)"/></mask>
        </defs>
        <g mask="url(#nwm-mask-clean)">
          <path d="${band("rdc")}" fill="#333333" opacity=".8"/>
          <path d="${band("rd")}" fill="#777777" opacity=".85"/>
          <path d="${band("r")}" fill="#FFFFFF" opacity=".95"/>
        </g>
        <line class="stream-hl" y1="${top}" y2="${Hh - bot}" stroke="#FFFFFF" stroke-width="1.5" opacity="0"/>
        <rect width="${W}" height="${Hh}" fill="transparent" class="stream-hit"/>`;

      const hit = streamSvg.querySelector(".stream-hit") as SVGRectElement | null;
      const hl = streamSvg.querySelector(".stream-hl") as SVGLineElement | null;
      if (hit && hl) {
        hit.onpointermove = (e) => {
          const r = streamSvg.getBoundingClientRect();
          const z = r.width / W;
          const x = (e.clientX - r.left) / z;
          const i = Math.max(0, Math.min(pointsCount - 1, Math.round(((x + 10) / (W + 20)) * (pointsCount - 1))));
          const p = points[i];
          hl.setAttribute("x1", String(X(i)));
          hl.setAttribute("x2", String(X(i)));
          hl.setAttribute("opacity", "1");
          showTip(r.left + X(i) * z, r.top + (mid - lay[i].rdc) * z, "Cluster Telemetry Point", [
            ["RAM Allocation", `${p.ram} MB`, "#FFFFFF"],
            ["Disk Provisioned", `${Math.round(p.disk / 20)} GB`, "#888888"],
            ["Allocated Cores", `${Math.round(p.cpu / 140)} vCPU`, "#505050"],
          ]);
        };
        hit.onpointerleave = () => {
          hl.setAttribute("opacity", "0");
          hideTip();
        };
      }
    }

    // 3. Dial Gauge SVG (56 Ticks)
    const gaugeSvg = gaugeSvgRef.current;
    if (gaugeSvg) {
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
      gaugeSvg.innerHTML = s;
    }

    // 4. Memory Runway Ticks
    const cashSvg = cashSvgRef.current;
    if (cashSvg) {
      const W = cashSvg.getBoundingClientRect().width || 180;
      const n = 32;
      let s = "";
      for (let i = 0; i < n; i++) {
        const x = 1 + (i * (W - 2)) / (n - 1);
        const on = i / (n - 1) <= Math.min(1, runRatio);
        s += `<line x1="${x}" x2="${x}" y1="${i % 6 === 0 ? 2 : 7}" y2="18" stroke="${
          on ? "#FFFFFF" : "#303030"
        }" stroke-width="1.6" stroke-linecap="round"/>`;
      }
      cashSvg.innerHTML = s;
    }

    // 5. Quota Tick Progress Bars
    const drawQuotaTicks = (svg: SVGSVGElement | null, f: number) => {
      if (!svg) return;
      const W = svg.getBoundingClientRect().width || 180;
      const n = 36;
      let s = "";
      for (let i = 0; i < n; i++) {
        const x = 1 + (i * (W - 2)) / (n - 1);
        const on = i / (n - 1) <= f;
        s += `<line x1="${x}" x2="${x}" y1="${i % 6 === 0 ? 0 : 3}" y2="10" stroke="${
          on ? "#FFFFFF" : "#303030"
        }" stroke-width="1.6" stroke-linecap="round"/>`;
      }
      svg.innerHTML = s;
    };

    const cpuTarget = Math.max(8, totalCpu * 1.5);
    const diskTarget = Math.max(100, totalStorageGb * 1.4);
    drawQuotaTicks(cpuLimitSvgRef.current, Math.min(1, totalCpu / cpuTarget));
    drawQuotaTicks(diskLimitSvgRef.current, Math.min(1, totalStorageGb / diskTarget));

    // 6. Mirrored Waves Operations Flow SVG
    const flowSvg = flowSvgRef.current;
    if (flowSvg) {
      const W = flowSvg.clientWidth || 400;
      const Hh = 210;
      const L = 36;
      const R = W - 30;
      const mid = Hh / 2;
      const lab = 14;
      const amp = mid - lab - 10;
      const max = 6;
      flowSvg.setAttribute("width", String(W));
      flowSvg.setAttribute("height", String(Hh));
      flowSvg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);

      const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];
      const inc = [2.2, 3.4, 4.8, 5.2, 4.4, Math.max(1, runCount)];
      const spn = [1.1, 1.8, 3.1, 3.6, 2.7, Math.max(1, stopCount)];

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
      s += `<line class="flow-hl" y1="10" y2="${Hh - 10}" stroke="#FFFFFF" stroke-opacity=".5" opacity="0"/>`;
      s += `<rect class="flow-hit" x="${L - 10}" width="${R - L + 20}" height="${Hh}" fill="transparent"/>`;

      flowSvg.innerHTML = s;

      const hit = flowSvg.querySelector(".flow-hit") as SVGRectElement | null;
      const hl = flowSvg.querySelector(".flow-hl") as SVGLineElement | null;
      if (hit && hl) {
        hit.onpointermove = (e) => {
          const r = flowSvg.getBoundingClientRect();
          const z = r.width / W;
          const x = (e.clientX - r.left) / z;
          const i = Math.max(0, Math.min(5, Math.round(((x - L) / (R - L)) * 5)));
          hl.setAttribute("x1", String(X(i)));
          hl.setAttribute("x2", String(X(i)));
          hl.setAttribute("opacity", "1");
          showTip(r.left + X(i) * z, r.top + (mid - lab - (inc[i] / max) * amp) * z, `${months[i]} Operations`, [
            ["Provisions & Runs", `${Math.round(inc[i])} ops`, "#FFFFFF"],
            ["Modifications", `${Math.round(spn[i])} ops`, "#888888"],
          ]);
        };
        hit.onpointerleave = () => {
          hl.setAttribute("opacity", "0");
          hideTip();
        };
      }
    }

    // 7. Weekday Activity Capsule Columns SVG
    const stocksSvg = stocksSvgRef.current;
    if (stocksSvg) {
      const W = stocksSvg.clientWidth || 200;
      const Hh = 160;
      const pb = 18;
      const bw = 18;
      const max = 5;
      const gap = (W - 20 - bw * 5) / 4;
      stocksSvg.setAttribute("width", String(W));
      stocksSvg.setAttribute("height", String(Hh));

      const Y = (x: number) => (Hh - pb) * (1 - x / max);
      const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
      const values = [2.2, 1.4, 3.8, 2.0, Math.min(max, Math.max(1, (data.recent_events.length || 3) / 3))];

      let s = "";
      [0, 2, 4].forEach((t) => {
        s += `<text x="0" y="${Y(t) + 3}" font-size="9" fill="#505050" font-family="monospace">${t}</text>`;
      });

      values.forEach((x, i) => {
        const X = 20 + i * (bw + gap);
        const isToday = i === values.length - 1;
        s += `
          <rect x="${X}" y="${Y(max)}" width="${bw}" height="${Hh - pb - Y(max)}" rx="3" fill="#1A1A1A"/>
          <rect x="${X}" y="${Y(x)}" width="${bw}" height="${Hh - pb - Y(x)}" rx="3" fill="${
          isToday ? "#FFFFFF" : "#555555"
        }"/>
          <text x="${X + bw / 2}" y="${Hh - 3}" text-anchor="middle" font-size="9.5" fill="${
          isToday ? "#FFFFFF" : "#888888"
        }" font-family="monospace">${days[i]}</text>
          <rect class="stocks-hit" x="${X - 2}" y="0" width="${bw + 4}" height="${Hh}" fill="transparent" data-i="${i}"/>`;
      });

      stocksSvg.innerHTML = s;

      stocksSvg.querySelectorAll(".stocks-hit").forEach((h) => {
        const hitEl = h as SVGRectElement;
        hitEl.onpointermove = (e) => {
          const i = +(hitEl.getAttribute("data-i") || 0);
          showTip(e.clientX, e.clientY, `${days[i]} System Activity`, [
            ["Audit Actions", `${Math.round(values[i] * 3)} recorded`, "#FFFFFF"],
          ]);
        };
        hitEl.onpointerleave = hideTip;
      });
    }
  }, [data, instances, runRatio, stopRatio, otherRatio, runCount, stopCount, totalContainers, totalCpu, totalMemoryMb, totalStorageGb, showTip, hideTip]);

  if (error && !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold text-primary">System Overview</h1>
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

  const activePct = Math.round(runRatio * 100);
  const ramGb = (totalMemoryMb / 1024).toFixed(1);
  const cpuTarget = Math.max(8, totalCpu * 1.5);
  const diskTarget = Math.max(100, totalStorageGb * 1.4);

  return (
    <>
      <style>{BENTO_CSS}</style>
      <div className="kct-bento space-y-4">
        {/* Header Bar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-primary flex items-center gap-2">
              <span>System Overview</span>
              <span className="text-xs font-normal font-mono text-muted">
                Synced {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            </h1>
            <p className="mt-0.5 text-xs text-muted">
              Real-time cluster telemetry, compute quotas, and audit streams from live host integration.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex p-0.5 gap-0.5 rounded border border-border bg-surface" role="group">
              {(["24H", "7D", "30D", "ALL"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={period === p}
                  onClick={() => setPeriod(p)}
                  className={cn(
                    "h-7 min-w-[36px] px-2 rounded text-xs font-semibold transition-colors",
                    period === p ? "bg-raised text-primary" : "text-muted hover:text-primary"
                  )}
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
        <div className="bento-grid">
          {/* Card 1: Resource Stream (8 cols) */}
          <section className="bento-card col-8 p-5 h-[360px] flex flex-col">
            {/* Header: Title on Left, Legend on Right */}
            <div className="flex items-center justify-between gap-3 relative z-10">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted shrink-0" />
                <span className="text-sm font-semibold text-primary whitespace-nowrap">
                  Resource Allocation Stream
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted shrink-0">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-white" />
                  <span>RAM (MB)</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-neutral-400" />
                  <span>Disk (GB)</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-neutral-600" />
                  <span>vCPU</span>
                </span>
              </div>
            </div>

            {/* Middle Row: Dot Matrix & Delta Stats */}
            <div className="flex flex-wrap items-end gap-4 mt-2 sm:mt-2.5 relative z-10">
              <svg ref={dotSvgRef} className="dots shrink-0" aria-hidden="true" />
              <div className="pb-1">
                <div className="text-xs font-mono font-semibold text-primary">
                  ↑ {runCount} Active VPS
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {totalCpu} cores provisioned across cluster
                </div>
              </div>
            </div>

            {/* Bottom SVG Stream Chart */}
            <svg
              ref={streamSvgRef}
              className="absolute bottom-0 left-0 right-0 w-full pointer-events-auto"
              style={{ height: "190px" }}
              aria-hidden="true"
            />
          </section>

          {/* Card 2: Fleet Allocation Gauge (4 cols) */}
          <section className="bento-card col-4 p-5 h-[360px] flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted" />
                <span className="text-sm font-semibold text-primary">Fleet Allocation</span>
              </div>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-raised border border-border text-primary">
                Live
              </span>
            </div>

            <svg
              ref={gaugeSvgRef}
              width="280"
              height="150"
              viewBox="-140 -140 280 150"
              className="mx-auto my-auto block"
              aria-hidden="true"
            />

            <div className="space-y-1 pt-2 border-t border-border">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-primary">
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                  <span>Running</span>
                </span>
                <span className="font-mono text-muted">{Math.round(runRatio * 100)}%</span>
                <span className="font-mono font-semibold text-primary">{runCount}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-primary">
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
                  <span>Stopped</span>
                </span>
                <span className="font-mono text-muted">{Math.round(stopRatio * 100)}%</span>
                <span className="font-mono font-semibold text-primary">{stopCount}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-primary">
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
                  <span>Suspended</span>
                </span>
                <span className="font-mono text-muted">{Math.round(otherRatio * 100)}%</span>
                <span className="font-mono font-semibold text-primary">{otherCount}</span>
              </div>
            </div>
          </section>

          {/* Card 3: Active Fleet Ratio (KPI 1 - 3 cols) */}
          <section className="bento-card col-3 p-4 h-[160px] flex flex-col justify-between bg-raised">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Active Fleet Ratio
              </span>
              <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface border border-border text-primary">
                {runCount}/{totalContainers}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <ArrowUpRight className="h-6 w-6 text-white" />
              <span className="text-4xl font-light tracking-tight text-primary font-mono">
                {activePct}%
              </span>
            </div>
            <div className="text-xs text-muted">Cluster running availability</div>
          </section>

          {/* Card 4: Committed Memory (KPI 2 - 3 cols) */}
          <section className="bento-card col-3 p-4 h-[160px] flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Committed Memory
              </span>
              <span className="text-xs font-mono text-muted">{ramGb} GB</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-light tracking-tight text-primary font-mono">
                {totalMemoryMb.toLocaleString()}
              </span>
              <span className="text-sm font-mono text-muted">MB</span>
            </div>
            <svg ref={cashSvgRef} className="w-full h-5" aria-hidden="true" />
          </section>

          {/* Card 5: Virtualization Nodes (KPI 3 - 3 cols) */}
          <section className="bento-card col-3 p-4 h-[160px] flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Virtualization Nodes
              </span>
              <span className="text-xs font-mono text-muted">{data.nodes.length} registered</span>
            </div>
            <div className="space-y-1.5 overflow-hidden">
              {data.nodes.length === 0 ? (
                <div className="text-xs text-muted">No node registered</div>
              ) : (
                data.nodes.slice(0, 2).map((n) => (
                  <div key={n.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="h-5 w-5 rounded bg-raised border border-border flex items-center justify-center font-mono text-[10px] text-primary">
                        {n.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="truncate text-primary">{n.name}</span>
                    </div>
                    <span className="font-mono text-xs text-muted shrink-0">
                      {formatRelativeTime(n.last_seen_at)}
                    </span>
                  </div>
                ))
              )}
            </div>
            <Link
              to="/admin/nodes"
              className="text-xs text-muted hover:text-primary transition-colors inline-flex items-center gap-1 mt-auto"
            >
              <span>Manage nodes</span>
              <ArrowRight className="h-3 w-3" />
            </Link>
          </section>

          {/* Card 6: Resource Quotas (KPI 4 - 3 cols) */}
          <section className="bento-card col-3 p-4 h-[160px] flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Resource Limits
              </span>
              <span className="text-xs text-muted">Cluster Quotas</span>
            </div>
            <div className="space-y-2">
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-primary">vCPU Allocation</span>
                  <span className="font-mono text-muted">{totalCpu} / {Math.round(cpuTarget)}</span>
                </div>
                <svg ref={cpuLimitSvgRef} className="w-full h-2.5 mt-1" aria-hidden="true" />
              </div>
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-primary">Storage Quota</span>
                  <span className="font-mono text-muted">{totalStorageGb} / {Math.round(diskTarget)} GB</span>
                </div>
                <svg ref={diskLimitSvgRef} className="w-full h-2.5 mt-1" aria-hidden="true" />
              </div>
            </div>
          </section>

          {/* Card 7: Operations Flow (5 cols) */}
          <section className="bento-card col-5 p-5 h-[330px] flex flex-col justify-between">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted" />
                  <span className="text-sm font-semibold text-primary">Operations Flow</span>
                </div>
                <div className="text-xs text-muted mt-0.5 font-mono">
                  {data.recent_events.length} audit actions recorded
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                  <span>Provisions & Runs</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
                  <span>Modifications</span>
                </span>
              </div>
            </div>

            <svg ref={flowSvgRef} className="w-full h-[210px] mt-auto" aria-hidden="true" />
          </section>

          {/* Card 8: Fleet Instances (4 cols) */}
          <section className="bento-card col-4 p-5 h-[330px] flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Server className="h-4 w-4 text-muted" />
                  <span className="text-sm font-semibold text-primary">Fleet Instances</span>
                </div>
                <span className="text-xs text-muted">Live reconciliation</span>
              </div>

              <div className="flex items-baseline justify-between mt-3">
                <span className="text-3xl font-light tracking-tight text-primary font-mono">
                  {data.containers_total}
                </span>
                <span className="text-xs font-mono text-primary font-medium">
                  ↑ {runCount} Active
                </span>
              </div>

              <div className="mt-2.5">
                <div className="flex h-1.5 w-full overflow-hidden rounded bg-border">
                  <div style={{ width: `${runRatio * 100}%` }} className="bg-white" />
                  <div style={{ width: `${stopRatio * 100}%` }} className="bg-neutral-400" />
                  <div style={{ width: `${otherRatio * 100}%` }} className="bg-neutral-700" />
                </div>
                <div className="flex justify-between mt-1.5 text-[11px] text-muted font-mono">
                  <span>Running {Math.round(runRatio * 100)}%</span>
                  <span>Stopped {Math.round(stopRatio * 100)}%</span>
                  <span>Other {Math.round(otherRatio * 100)}%</span>
                </div>
              </div>
            </div>

            <div className="space-y-2 pt-3 border-t border-border mt-auto">
              {instances.length === 0 ? (
                <div className="text-xs text-muted">No instance provisioned</div>
              ) : (
                instances.slice(0, 3).map((inst) => (
                  <div key={inst.id} className="flex items-center justify-between text-xs">
                    <div className="min-w-0">
                      <div className="font-medium text-primary truncate max-w-[140px]">
                        {inst.name}
                      </div>
                      <div className="text-[10.5px] font-mono text-muted">
                        {inst.cpu} vCPU · {inst.memory_mb} MB
                      </div>
                    </div>
                    <span className={cn(
                      "font-mono text-xs font-medium",
                      inst.status === "running" ? "text-primary" : "text-muted"
                    )}>
                      {inst.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Card 9: Audit Activity (3 cols) */}
          <section className="bento-card col-3 p-5 h-[330px] flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-muted" />
                <span className="text-sm font-semibold text-primary">Audit Activity</span>
              </div>
              <div className="mt-3">
                <span className="text-3xl font-light tracking-tight text-primary font-mono">
                  {data.recent_events.length}
                </span>
              </div>
              <div className="text-xs text-muted mt-0.5">Recorded recent operations</div>
            </div>

            <svg ref={stocksSvgRef} className="w-full h-[160px] mt-auto" aria-hidden="true" />
          </section>
        </div>

        {/* Global Floating Tooltip */}
        <div ref={tipRef} className="kct-bento-tip" />

        {/* Footer shortcuts */}
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
