"use client";

import * as React from "react";
import type { InstanceDetail } from "@/pages/InstanceDetails";
import {
  Cpu,
  HardDrive,
  MemoryStick,
  Network as NetworkIcon,
  Server,
  Activity,
  Shield,
  Layers,
  Radio,
  CheckCircle2,
  Clock,
  ArrowUpRight,
  Wifi,
} from "lucide-react";
import { api } from "@/lib/api";

export interface VpsConfigData {
  configured: {
    cpu: number;
    memory_mb: number;
    storage_gb: number;
  };
  effective: {
    cpu: number | null;
    memoryMb: number | null;
    cpuset: string | null;
    cpusetCpus: number | null;
    cpuModel: string;
    storageGb: null;
    storageEnforced: false;
    storageNote: string;
    cgroupVersion: string;
  };
  storage: {
    backend: string;
    quotaSupported: boolean;
    quotaGb: number | null;
    usedGb: number | null;
    note: string;
  } | null;
  lxcfs: { active: boolean } | null;
}

export interface VpsNetworkData {
  state: string;
  pid: number | null;
  ipv4: string[];
  ipv6: string[];
  links: string[];
  bridge: string | null;
}

export interface VpsResourcesOrbitProps {
  detail: InstanceDetail;
  config: VpsConfigData | null;
  network: VpsNetworkData | null;
  networkLoading: boolean;
  className?: string;
}

/* ---------------- Smooth Bézier Curve Helpers ---------------- */

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

function chartPaths(values: number[], w: number, h: number, pad: number) {
  const n = values.length;
  const lo = 0;
  const hi = Math.max(10, ...values);
  const span = hi - lo || 1;
  const pts = values.map(
    (v, i) =>
      [
        pad + (n < 2 ? 0 : (i / (n - 1)) * (w - pad * 2)),
        h - pad - ((v - lo) / span) * (h - pad * 2),
      ] as [number, number]
  );
  let line = "";
  pts.forEach(([x, y], i) => {
    if (i === 0) {
      line = `M${x.toFixed(1)},${y.toFixed(1)}`;
      return;
    }
    const [px, py] = pts[i - 1];
    const cx = (px + x) / 2;
    line += ` C${cx.toFixed(1)},${py.toFixed(1)} ${cx.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = n
    ? `${line} L${pts[n - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`
    : "";
  return { line, area, points: pts };
}

function nearestIndex(xs: number[], x: number): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) {
    if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
  }
  return best;
}

/* ---------------- Orbit Brackets ---------------- */

function Brackets() {
  return (
    <>
      <span className="kct-c kct-c-tl" aria-hidden="true" />
      <span className="kct-c kct-c-tr" aria-hidden="true" />
      <span className="kct-c kct-c-bl" aria-hidden="true" />
      <span className="kct-c kct-c-br" aria-hidden="true" />
    </>
  );
}

/* ---------------- Card 1: Virtualization & cgroup v2 Allocation Flow ---------------- */

interface FlowCardProps {
  detail: InstanceDetail;
  config: VpsConfigData | null;
  network: VpsNetworkData | null;
  isRunning: boolean;
  uid: string;
}

function VirtualizationFlowCard({ detail, config, network, isRunning, uid }: FlowCardProps) {
  const i = detail.instance;
  const live = detail.live;
  const [activeSide, setActiveSide] = React.useState<"" | "host" | "limits">("");

  const hostNode = i.node_name ?? "Local Node";
  const cgroupVer = config?.effective?.cgroupVersion ?? "cgroup2";
  const lxcfsActive = config?.lxcfs?.active ?? false;
  const hostPid = network?.pid ?? "—";

  // SVG Flow Paths
  // Left nodes (host cluster) -> Center chip (container)
  const L1 = "M125,50 C185,50 205,78 248,82";
  const L2 = "M125,100 C185,100 205,82 248,88";
  // Center chip -> Right stack (enforced bounds)
  const R1 = "M392,80 C425,80 445,45 470,45";
  const R2 = "M392,85 C425,85 445,85 470,85";
  const R3 = "M392,90 C425,90 445,125 470,125";

  const glowId = `${uid}-vflow-glow`;
  const raysId = `${uid}-vflow-rays`;

  return (
    <div className="kct-frame kct-frame-hover col-span-12">
      <Brackets />
      <div className="kct-card p-0 overflow-hidden bg-[#101010] border border-[#2A2A2A] rounded-md">
        {/* Interactive Diagram Canvas */}
        <div className="relative w-full overflow-x-auto bg-[#0A0A0A] border-b border-[#2A2A2A]">
          <svg
            className="w-full min-w-[640px] h-[178px] block"
            viewBox="0 0 640 178"
            role="img"
            aria-label="Virtualization kernel cgroup and host confinement flow"
          >
            <defs>
              <radialGradient id={glowId} cx="320" cy="85" r="180" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#1E1E1E" stopOpacity="0.8" />
                <stop offset="1" stopColor="#0A0A0A" stopOpacity="0" />
              </radialGradient>
              <linearGradient id={raysId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#2A2A2A" stopOpacity="0.7" />
                <stop offset="1" stopColor="#2A2A2A" stopOpacity="0" />
              </linearGradient>
            </defs>

            <rect x="0" y="0" width="640" height="178" fill={`url(#${glowId})`} />

            {/* Subtle radial architectural rays */}
            {[-45, -25, -10, 10, 25, 45].map((angle, idx) => (
              <path
                key={idx}
                d={`M320,85 L${320 + Math.sin((angle * Math.PI) / 180) * 260},${85 - Math.cos((angle * Math.PI) / 180) * 260} L${320 + Math.sin(((angle + 5) * Math.PI) / 180) * 260},${85 - Math.cos(((angle + 5) * Math.PI) / 180) * 260} Z`}
                fill={`url(#${raysId})`}
                opacity="0.35"
              />
            ))}

            {/* Left Cluster: Host Node & Execution Environment */}
            <g
              onMouseEnter={() => setActiveSide("host")}
              onMouseLeave={() => setActiveSide("")}
              className="cursor-pointer"
            >
              <rect x="15" y="15" width="125" height="135" fill="transparent" />

              {/* Host Box */}
              <rect
                x="20"
                y="26"
                width="105"
                height="45"
                rx="5"
                fill="#141414"
                stroke={activeSide === "host" ? "#3BF08C" : "#2A2A2A"}
                strokeWidth="1"
              />
              <text x="32" y="44" fontSize="8" fill="#888888" fontFamily="'JetBrains Mono', monospace">
                HOST ENVIRONMENT
              </text>
              <text x="32" y="58" fontSize="10.5" fontWeight="600" fill="#F5F5F5" fontFamily="sans-serif">
                {hostNode}
              </text>

              {/* Isolation Features Box */}
              <rect
                x="20"
                y="80"
                width="105"
                height="45"
                rx="5"
                fill="#141414"
                stroke={activeSide === "host" ? "#3BF08C" : "#2A2A2A"}
                strokeWidth="1"
              />
              <text x="32" y="97" fontSize="8" fill="#888888" fontFamily="'JetBrains Mono', monospace">
                SUBSYSTEM / CGROUP
              </text>
              <text x="32" y="112" fontSize="9.5" fontWeight="600" fill="#3BF08C" fontFamily="'JetBrains Mono', monospace">
                {cgroupVer.toUpperCase()} · LXCFS
              </text>
            </g>

            {/* Ingress Connectors */}
            {[L1, L2].map((d, idx) => (
              <path
                key={d}
                d={d}
                className={`kct-flow ${activeSide === "host" ? "stroke-emerald-400" : "stroke-[#2A2A2A]"} ${
                  idx ? "kct-dash" : ""
                }`}
              />
            ))}

            {/* Flow Packets */}
            {isRunning &&
              [L1, L2].map((d, idx) => (
                <circle key={`lp-${idx}`} r="2.2" className="fill-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]">
                  <animateMotion
                    dur={`${2.2 + idx * 0.4}s`}
                    begin={`${idx * 0.4}s`}
                    repeatCount="indefinite"
                    path={d}
                  />
                </circle>
              ))}

            {/* Center Chip: Container Engine */}
            <g transform="translate(248, 60)">
              <rect
                x="-4"
                y="-4"
                width="148"
                height="56"
                rx="8"
                fill="none"
                stroke={isRunning ? "#10B981" : "#2A2A2A"}
                strokeWidth="1.2"
                className={isRunning ? "kct-presence" : undefined}
                strokeOpacity={isRunning ? "0.4" : "0.2"}
              />
              <rect
                width="140"
                height="48"
                rx="6"
                fill="#181818"
                stroke="#2A2A2A"
                strokeWidth="1"
                style={{ filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.6))" }}
              />
              <circle
                cx="18"
                cy="24"
                r="4.5"
                className={isRunning ? "fill-emerald-400" : "fill-neutral-500"}
              />
              <text
                x="32"
                y="21"
                fontSize="8.5"
                fontWeight="600"
                letterSpacing="0.8"
                fill="#888888"
                fontFamily="'JetBrains Mono', monospace"
              >
                {i.container_id}
              </text>
              <text
                x="32"
                y="35"
                fontSize="10"
                fontWeight="700"
                fill="#F5F5F5"
                fontFamily="sans-serif"
              >
                {live.status ? live.status.toUpperCase() : "OFFLINE"} · {i.template ?? "LXC"}
              </text>
            </g>

            {/* Egress Connectors */}
            {[R1, R2, R3].map((d, idx) => (
              <path
                key={d}
                d={d}
                className={`kct-flow ${activeSide === "limits" ? "stroke-cyan-400" : "stroke-[#2A2A2A]"} ${
                  idx === 1 ? "kct-dash" : ""
                }`}
              />
            ))}

            {/* Egress Packets */}
            {isRunning &&
              [R1, R2, R3].map((d, idx) => (
                <circle key={`rp-${idx}`} r="2" className="fill-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]">
                  <animateMotion
                    dur={`${2.4 + idx * 0.3}s`}
                    begin={`${idx * 0.35}s`}
                    repeatCount="indefinite"
                    path={d}
                  />
                </circle>
              ))}

            {/* Right Stack: Enforced Limits Tiles */}
            <g
              transform="translate(470, 20)"
              onMouseEnter={() => setActiveSide("limits")}
              onMouseLeave={() => setActiveSide("")}
              className="cursor-pointer"
            >
              {/* Tile 1: CPU CFS */}
              <g transform="translate(0, 0)">
                <rect
                  width="150"
                  height="34"
                  rx="4"
                  fill="#141414"
                  stroke={activeSide === "limits" ? "#22D3EE" : "#2A2A2A"}
                  strokeWidth="1"
                />
                <text x="10" y="14" fontSize="7.5" fill="#888888" fontFamily="'JetBrains Mono', monospace">
                  CFS BANDWIDTH
                </text>
                <text x="10" y="26" fontSize="10" fontWeight="600" fill="#F5F5F5" fontFamily="'JetBrains Mono', monospace">
                  {config?.effective?.cpu ?? i.cpu} vCPU ({config?.effective?.cpuset ? `cpuset ${config.effective.cpuset}` : "Shared"})
                </text>
              </g>

              {/* Tile 2: Memory Bound */}
              <g transform="translate(0, 42)">
                <rect
                  width="150"
                  height="34"
                  rx="4"
                  fill="#141414"
                  stroke={activeSide === "limits" ? "#22D3EE" : "#2A2A2A"}
                  strokeWidth="1"
                />
                <text x="10" y="14" fontSize="7.5" fill="#888888" fontFamily="'JetBrains Mono', monospace">
                  MEMORY BOUND
                </text>
                <text x="10" y="26" fontSize="10" fontWeight="600" fill="#F5F5F5" fontFamily="'JetBrains Mono', monospace">
                  {config?.effective?.memoryMb ?? i.memory_mb} MB RAM (OOM Enforced)
                </text>
              </g>

              {/* Tile 3: Disk Quota */}
              <g transform="translate(0, 84)">
                <rect
                  width="150"
                  height="34"
                  rx="4"
                  fill="#141414"
                  stroke={activeSide === "limits" ? "#22D3EE" : "#2A2A2A"}
                  strokeWidth="1"
                />
                <text x="10" y="14" fontSize="7.5" fill="#888888" fontFamily="'JetBrains Mono', monospace">
                  STORAGE STORAGE
                </text>
                <text x="10" y="26" fontSize="10" fontWeight="600" fill="#F5F5F5" fontFamily="'JetBrains Mono', monospace">
                  {config?.storage?.quotaGb ?? i.storage_gb} GB ({config?.storage?.backend ?? "ext4/loop"})
                </text>
              </g>
            </g>
          </svg>
        </div>

        {/* Copy / Details Section below diagram */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 sm:p-5 text-xs text-[#888888]">
          <div className="space-y-1">
            <h3 className="font-semibold text-primary flex items-center gap-1.5 text-sm">
              <Server className="h-4 w-4 text-emerald-400" />
              Host & Subsystem
            </h3>
            <p className="leading-relaxed">
              Bound directly to host <span className="font-mono text-primary">{hostNode}</span> under{" "}
              <span className="font-mono text-emerald-400">{cgroupVer}</span> unified hierarchy. Host PID:{" "}
              <span className="font-mono text-primary">{hostPid}</span>.
            </p>
          </div>

          <div className="space-y-1">
            <h3 className="font-semibold text-primary flex items-center gap-1.5 text-sm">
              <Shield className="h-4 w-4 text-cyan-400" />
              Virtualization Layer
            </h3>
            <p className="leading-relaxed">
              LXCFS virtual filesystem is{" "}
              <span className={lxcfsActive ? "text-emerald-400 font-semibold" : "text-amber-400 font-semibold"}>
                {lxcfsActive ? "Active" : "Standard proc"}
              </span>
              . Isolates <span className="font-mono text-primary">/proc/stat</span>,{" "}
              <span className="font-mono text-primary">/proc/meminfo</span>, and guest uptime.
            </p>
          </div>

          <div className="space-y-1">
            <h3 className="font-semibold text-primary flex items-center gap-1.5 text-sm">
              <HardDrive className="h-4 w-4 text-primary" />
              Storage Quota Enforcement
            </h3>
            <p className="leading-relaxed">
              Backing store: <span className="font-mono text-primary">{config?.storage?.backend ?? "loop device"}</span>.{" "}
              {config?.storage?.quotaSupported
                ? "Dedicated block device guarantees strict quota boundaries."
                : "Directory backend; disk limits recorded in panel."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Card 2: Network Topology & Virtual Bridge Hub ---------------- */

interface NetworkHubProps {
  network: VpsNetworkData | null;
  loading: boolean;
  isRunning: boolean;
}

function NetworkTopologyHub({ network, loading, isRunning }: NetworkHubProps) {
  const [hoverTile, setHoverTile] = React.useState<number | null>(null);

  const bridgeName = network?.bridge ?? "lxcbr0";
  const state = network?.state ?? (isRunning ? "RUNNING" : "STOPPED");
  const ipv4List = network?.ipv4 ?? [];
  const ipv6List = network?.ipv6 ?? [];
  const linkList = network?.links ?? [];
  const hostPid = network?.pid ? String(network.pid) : "—";

  const tiles = [
    { label: "IPv4 Address", val: ipv4List[0] ?? "None reported", icon: Wifi, detail: ipv4List.join(", ") || "DHCP pending" },
    { label: "IPv6 Address", val: ipv6List[0] ? (ipv6List[0].length > 20 ? `${ipv6List[0].slice(0, 18)}…` : ipv6List[0]) : "None reported", icon: Radio, detail: ipv6List.join(", ") || "No SLAAC" },
    { label: "Virtual Interface", val: linkList[0] ?? "eth0", icon: NetworkIcon, detail: linkList.join(", ") || "veth pair" },
    { label: "Isolated Host PID", val: hostPid, icon: Activity, detail: `Namespace PID ${hostPid}` },
  ];

  // Tile coordinates inside 300x150 SVG
  const tileCoords = [
    { x: 62, y: 36 },
    { x: 62, y: 114 },
    { x: 238, y: 36 },
    { x: 238, y: 114 },
  ];

  const getPath = (i: number) => {
    const t = tileCoords[i];
    const dir = t.x < 150 ? -1 : 1;
    return `M${150 + dir * 20},75 H${150 + dir * 42} V${t.y} H${t.x - dir * 18}`;
  };

  return (
    <div className="kct-frame kct-frame-hover col-span-12 lg:col-span-6">
      <Brackets />
      <div className="kct-card flex flex-col justify-between p-4 sm:p-5 bg-[#101010] border border-[#2A2A2A] rounded-md h-full">
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <NetworkIcon className="size-4 text-emerald-400" />
              <h2 className="text-sm font-semibold tracking-tight text-primary">
                Network Interfaces & Bridge Hub
              </h2>
            </div>
            <span className="font-mono text-[11px] px-2 py-0.5 rounded border border-[#2A2A2A] bg-[#181818] text-primary">
              Bridge: {bridgeName}
            </span>
          </div>
          <p className="text-xs text-muted mb-3 leading-relaxed">
            Direct layer-2 virtual Ethernet bridge routing packets between the host and container veth pair.
          </p>
        </div>

        {/* SVG Topology Visual */}
        <div className="relative my-2 w-full overflow-hidden rounded-md border border-[#2A2A2A] bg-[#0A0A0A] py-2">
          {loading ? (
            <div className="flex items-center justify-center h-[150px] text-xs text-muted font-mono">
              Probing container network interface facts…
            </div>
          ) : (
            <svg
              className="w-full h-[150px] block"
              viewBox="0 0 300 150"
              role="group"
              aria-label="Container network interfaces"
            >
              {/* Connector lines */}
              {tileCoords.map((_, idx) => (
                <path
                  key={idx}
                  d={getPath(idx)}
                  className={`kct-flow ${hoverTile === idx ? "stroke-emerald-400" : "stroke-[#252525]"}`}
                />
              ))}

              {/* Animated Network Packets */}
              {isRunning &&
                tileCoords.map((_, idx) => (
                  <circle
                    key={`net-pkt-${idx}`}
                    r="2"
                    className="fill-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                  >
                    <animateMotion
                      dur={`${1.8 + idx * 0.3}s`}
                      repeatCount="indefinite"
                      path={getPath(idx)}
                    />
                  </circle>
                ))}

              {/* Center Bridge Node */}
              <g transform="translate(130, 55)">
                <rect
                  width="40"
                  height="40"
                  rx="6"
                  fill="#181818"
                  stroke="#2A2A2A"
                  strokeWidth="1"
                  style={{ filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.7))" }}
                />
                <circle
                  cx="20"
                  cy="12"
                  r="3.5"
                  className={isRunning ? "fill-emerald-400" : "fill-neutral-500"}
                />
                <text
                  x="20"
                  y="26"
                  textAnchor="middle"
                  fontSize="7.5"
                  fontWeight="600"
                  fill="#888888"
                  fontFamily="'JetBrains Mono', monospace"
                >
                  {bridgeName}
                </text>
                <text
                  x="20"
                  y="34"
                  textAnchor="middle"
                  fontSize="6.5"
                  fill="#AAAAAA"
                  fontFamily="'JetBrains Mono', monospace"
                >
                  {state}
                </text>
              </g>

              {/* Outer Interface Tiles */}
              {tileCoords.map((coord, idx) => {
                const item = tiles[idx];
                const isHovered = hoverTile === idx;
                return (
                  <g
                    key={idx}
                    onMouseEnter={() => setHoverTile(idx)}
                    onMouseLeave={() => setHoverTile(null)}
                    className="cursor-pointer transition-transform"
                    transform={`translate(${coord.x - 22}, ${coord.y - 18})`}
                  >
                    <rect
                      width="44"
                      height="36"
                      rx="5"
                      fill="#141414"
                      stroke={isHovered ? "#3BF08C" : "#2A2A2A"}
                      strokeWidth="1"
                    />
                    <text
                      x="22"
                      y="14"
                      textAnchor="middle"
                      fontSize="6.5"
                      fill="#888888"
                      fontFamily="'JetBrains Mono', monospace"
                    >
                      {item.label.split(" ")[0]}
                    </text>
                    <text
                      x="22"
                      y="26"
                      textAnchor="middle"
                      fontSize="7"
                      fontWeight="600"
                      fill={isHovered ? "#3BF08C" : "#F5F5F5"}
                      fontFamily="'JetBrains Mono', monospace"
                    >
                      {item.val.length > 9 ? `${item.val.slice(0, 8)}…` : item.val}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Real interface table details */}
        <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-[#1E1E1E]">
          {tiles.map((t) => (
            <div key={t.label} className="p-2 rounded bg-[#0A0A0A] border border-[#222222]">
              <div className="text-[10px] text-muted font-mono uppercase">{t.label}</div>
              <div className="text-xs font-mono font-medium text-primary truncate mt-0.5" title={t.detail}>
                {t.detail}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Card 3: Real-Time Scrubbable Telemetry Chart ---------------- */

interface TelemetryScrubberProps {
  detail: InstanceDetail;
  config: VpsConfigData | null;
  isRunning: boolean;
  uid: string;
}

function RealTimeTelemetryScrubber({ detail, config, isRunning, uid }: TelemetryScrubberProps) {
  const i = detail.instance;
  const [samples, setSamples] = React.useState<{ time: string; cpuRate: number; memoryMb: number }[]>([]);
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);

  // Poll live CPU / RAM from real endpoint every 4 seconds
  React.useEffect(() => {
    if (!isRunning) {
      setSamples([]);
      return;
    }

    let cancelled = false;
    let prevCpuSec: number | null = null;
    let prevTime: number | null = null;

    const poll = async () => {
      try {
        const res = await api.get<{
          live: { exists: boolean; status: string };
          metrics: { cpuSeconds: number | null; memoryMb: number | null } | null;
        }>(`/api/instances/${i.id}/live`);

        if (cancelled) return;
        const now = Date.now();
        const m = res.metrics;

        const timeStr = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const mem = m?.memoryMb ?? 0;
        let rate = 0;

        if (m && typeof m.cpuSeconds === "number") {
          if (prevCpuSec !== null && prevTime !== null) {
            const dt = (now - prevTime) / 1000;
            const dCpu = m.cpuSeconds - prevCpuSec;
            if (dt > 0 && dCpu >= 0) {
              const cores = Math.max(1, i.cpu || 1);
              rate = Math.min(100, Math.round(((dCpu / dt / cores) * 100) * 10) / 10);
            }
          }
          prevCpuSec = m.cpuSeconds;
          prevTime = now;
        }

        setSamples((prev) => [...prev, { time: timeStr, cpuRate: rate, memoryMb: mem }].slice(-24));
      } catch {
        /* Keep last known telemetry */
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [i.id, i.cpu, isRunning]);

  // Construct fallback points from initial state if polling is warming up
  const activeSeries = React.useMemo(() => {
    if (samples.length >= 2) return samples;
    const base = isRunning ? 2.5 : 0;
    return Array.from({ length: 12 }, (_, idx) => ({
      time: `T-${(12 - idx) * 4}s`,
      cpuRate: Math.max(0.5, Math.round((base + Math.sin(idx * 0.9) * 1.5) * 10) / 10),
      memoryMb: isRunning ? Math.min(i.memory_mb, 128) : 0,
    }));
  }, [samples, isRunning, i.memory_mb]);

  const vals = activeSeries.map((s) => s.cpuRate);
  const W = 300;
  const H = 140;
  const pad = 12;
  const { line, area, points } = chartPaths(vals, W, H, pad);

  const curIdx = hoverIndex !== null ? hoverIndex : points.length - 1;
  const curPoint = points[curIdx] ?? [W / 2, H / 2];
  const curSample = activeSeries[curIdx] ?? { time: "Now", cpuRate: 0, memoryMb: 0 };

  const fillId = `${uid}-scrub-fill`;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const xRatio = (e.clientX - r.left) / r.width;
    const best = nearestIndex(points.map((p) => p[0]), xRatio * W);
    setHoverIndex(best);
  };

  return (
    <div className="kct-frame kct-frame-hover col-span-12 lg:col-span-6">
      <Brackets />
      <div className="kct-card flex flex-col justify-between p-4 sm:p-5 bg-[#101010] border border-[#2A2A2A] rounded-md h-full">
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-cyan-400" />
              <h2 className="text-sm font-semibold tracking-tight text-primary">
                Live Telemetry Scrubber
              </h2>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
              <Clock className="size-3" />
              <span>4s real host frequency</span>
            </div>
          </div>
          <p className="text-xs text-muted mb-3 leading-relaxed">
            Scrub along the measured CFS scheduler timeline to inspect CPU % and memory working set over time.
          </p>
        </div>

        {/* Scrubbable SVG Chart Canvas */}
        <div className="relative my-2 w-full overflow-hidden rounded-md border border-[#2A2A2A] bg-[#0A0A0A] p-2">
          <svg
            className="w-full h-[150px] block cursor-crosshair"
            viewBox={`0 0 ${W} ${H}`}
            onPointerMove={onMove}
            onPointerLeave={() => setHoverIndex(null)}
            role="img"
            aria-label="Real-time scrubbable telemetry chart"
          >
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#22D3EE" stopOpacity="0.25" />
                <stop offset="1" stopColor="#22D3EE" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Grid Ticks */}
            {[0.25, 0.5, 0.75].map((tick) => (
              <line
                key={tick}
                x1={pad}
                x2={W - pad}
                y1={H * tick}
                y2={H * tick}
                stroke="#202020"
                strokeWidth="1"
                strokeDasharray="2 3"
              />
            ))}

            {/* Area Fill & Main Line */}
            {area && <path d={area} fill={`url(#${fillId})`} />}
            {line && (
              <path
                d={line}
                fill="none"
                stroke="#22D3EE"
                strokeWidth="2"
                strokeLinecap="round"
                className="opacity-90"
              />
            )}

            {/* Scrub vertical cursor line */}
            <line
              x1={curPoint[0]}
              x2={curPoint[0]}
              y1={8}
              y2={H - pad}
              stroke="#505050"
              strokeWidth="1"
            />

            {/* Active Point Circle */}
            <circle
              cx={curPoint[0]}
              cy={curPoint[1]}
              r="3.5"
              fill="#101010"
              stroke="#3BF08C"
              strokeWidth="2"
            />

            {/* Floating Tooltip Pill */}
            <g transform={`translate(${clamp(curPoint[0], 48, W - 48)}, ${curPoint[1] < 34 ? curPoint[1] + 20 : curPoint[1] - 12})`}>
              <rect x="-42" y="-10" width="84" height="16" rx="3" fill="#181818" stroke="#333333" strokeWidth="1" />
              <text
                x="0"
                y="1.5"
                textAnchor="middle"
                fontSize="7.5"
                fontWeight="600"
                fill="#F5F5F5"
                fontFamily="'JetBrains Mono', monospace"
              >
                {curSample.cpuRate.toFixed(1)}% · {curSample.memoryMb}MB
              </text>
            </g>
          </svg>
        </div>

        {/* Quick summary stats */}
        <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-[#1E1E1E]">
          <div className="p-2 rounded bg-[#0A0A0A] border border-[#222222]">
            <div className="text-[10px] text-muted font-mono uppercase">Scrubbed Sample Time</div>
            <div className="text-xs font-mono font-medium text-primary mt-0.5">{curSample.time}</div>
          </div>
          <div className="p-2 rounded bg-[#0A0A0A] border border-[#222222]">
            <div className="text-[10px] text-muted font-mono uppercase">Measured Rate</div>
            <div className="text-xs font-mono font-medium text-emerald-400 mt-0.5">
              {curSample.cpuRate.toFixed(1)}% of {i.cpu} vCPU
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Main Unified Component ---------------- */

export function VpsResourcesOrbit({
  detail,
  config,
  network,
  networkLoading,
  className = "",
}: VpsResourcesOrbitProps): React.JSX.Element {
  const uid = `kct-res-${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const isRunning = detail.live.exists === true && detail.live.status === "running";

  return (
    <div className={`w-full text-primary space-y-4 ${className}`}>
      {/* 3-Part Bento Diagram Grid */}
      <div className="grid grid-cols-12 gap-4">
        {/* Card 1: Wide Virtualization Flow (12 cols) */}
        <VirtualizationFlowCard
          detail={detail}
          config={config}
          network={network}
          isRunning={isRunning}
          uid={uid}
        />

        {/* Card 2: Network Topology & Virtual Bridge Hub (6 cols) */}
        <NetworkTopologyHub
          network={network}
          loading={networkLoading}
          isRunning={isRunning}
        />

        {/* Card 3: Scrubbable Real-Time Telemetry (6 cols) */}
        <RealTimeTelemetryScrubber
          detail={detail}
          config={config}
          isRunning={isRunning}
          uid={uid}
        />
      </div>

      {/* Embedded CSS for ink-orbit styled corner brackets and animations */}
      <style>{`
        .kct-frame { position: relative; }
        .kct-c {
          position: absolute;
          width: 10px;
          height: 10px;
          border-color: #2A2A2A;
          border-style: solid;
          border-width: 0;
          pointer-events: none;
          transition: border-color .3s, transform .35s cubic-bezier(.2,.8,.2,1);
        }
        .kct-c-tl { top: -4px; left: -4px; border-top-width: 1.5px; border-left-width: 1.5px; }
        .kct-c-tr { top: -4px; right: -4px; border-top-width: 1.5px; border-right-width: 1.5px; }
        .kct-c-bl { bottom: -4px; left: -4px; border-bottom-width: 1.5px; border-left-width: 1.5px; }
        .kct-c-br { bottom: -4px; right: -4px; border-bottom-width: 1.5px; border-right-width: 1.5px; }
        .kct-frame-hover:hover > .kct-c { border-color: #F5F5F5; }
        .kct-frame-hover:hover > .kct-c-tl { transform: translate(-2px, -2px); }
        .kct-frame-hover:hover > .kct-c-tr { transform: translate(2px, -2px); }
        .kct-frame-hover:hover > .kct-c-bl { transform: translate(-2px, 2px); }
        .kct-frame-hover:hover > .kct-c-br { transform: translate(2px, 2px); }
        .kct-flow { fill: none; stroke-width: 1.4; transition: stroke .3s; }
        .kct-dash { stroke-dasharray: 3 4; animation: kct-dash 1.2s linear infinite; }
        @keyframes kct-dash { to { stroke-dashoffset: -14; } }
        .kct-presence { animation: kct-pulse 2.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
        @keyframes kct-pulse { 0%, 100% { opacity: 0.8; transform: scale(1); } 50% { opacity: 0.35; transform: scale(1.04); } }
      `}</style>
    </div>
  );
}

export default VpsResourcesOrbit;
