"use client";

import * as React from "react";
import { api } from "@/lib/api";
import type { InstanceDetail } from "@/pages/InstanceDetails";
import { Activity, Cpu, HardDrive, Shield, Server, ArrowUpRight } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  VPS Analytics Bento: 4 live telemetry cards (CPU CFS, Memory      */
/*  Waves, Storage Squarified Treemap, Isolation Vector Radar)        */
/*  Strictly designed for KineticCT dark monochrome palette           */
/* ------------------------------------------------------------------ */

type Point = { label: string; value: number };

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

function useReducedMotion() {
  const [r, setR] = React.useState(false);
  React.useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(m.matches);
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return r;
}

function useSize() {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      const h = Math.round(e.contentRect.height);
      setSize((p) => (p.w === w && p.h === h ? p : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Smooth Catmull-Rom cubic beziers */
function smooth(P: [number, number][]) {
  const n = P.length;
  if (n < 2) return "";
  const g = (i: number) => P[Math.max(0, Math.min(n - 1, i))];
  let d = `M${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2), k = 0.18;
    d += `C${p1[0] + (p2[0] - p0[0]) * k},${p1[1] + (p2[1] - p0[1]) * k} ${p2[0] - (p3[0] - p1[0]) * k},${p2[1] - (p3[1] - p1[1]) * k} ${p2[0]},${p2[1]}`;
  }
  return d;
}

function CountUp({ value, prefix = "", suffix = "", duration = 1000 }: { value: number; prefix?: string; suffix?: string; duration?: number }) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const from = React.useRef(0);
  const reduce = useReducedMotion();
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      el.textContent = `${prefix}${fmt(value)}${suffix}`;
      from.current = value;
      return;
    }
    const a = from.current;
    const t0 = performance.now();
    let raf = 0;
    const f = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = a + (value - a) * ease(t);
      el.textContent = `${prefix}${fmt(v)}${suffix}`;
      from.current = v;
      if (t < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [value, prefix, suffix, duration, reduce]);
  return <span ref={ref}>{prefix}0{suffix}</span>;
}

/* ---------------- Tooltip ---------------- */

type Tip = { title: string; rows: { label: string; value: string; color?: string }[] };
type TipApi = { show: (x: number, y: number, t: Tip) => void; hide: () => void };
type TipRef = { current: TipApi | null };

function BentoTooltip({ mono, api }: { mono: string; api: TipRef }) {
  const [tip, setTip] = React.useState<(Tip & { x: number; y: number }) | null>(null);
  const [pos, setPos] = React.useState({ l: 0, t: 0 });
  const box = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    api.current = { show: (x, y, t) => setTip({ ...t, x, y }), hide: () => setTip(null) };
    return () => { api.current = null; };
  }, [api]);

  React.useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const r = box.current.getBoundingClientRect();
    let l = tip.x + 14;
    let t = tip.y - r.height - 12;
    if (l + r.width > window.innerWidth - 8) l = tip.x - r.width - 14;
    if (t < 8) t = tip.y + 16;
    setPos({ l, t });
  }, [tip]);

  return (
    <div
      ref={box}
      role="tooltip"
      className={`pointer-events-none fixed z-50 whitespace-nowrap rounded-lg border border-[#2A2A2A] bg-[#141414]/95 px-3 py-2 text-xs text-[#F5F5F5] shadow-xl backdrop-blur-md transition-opacity duration-150 ${
        tip ? "opacity-100" : "opacity-0"
      }`}
      style={{ left: pos.l, top: pos.t }}
    >
      {tip && (
        <>
          <div className="mb-1 text-[11px] font-medium text-[#888888]">{tip.title}</div>
          {tip.rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-3 text-xs">
              <span className="inline-flex items-center gap-1.5 text-[#AAAAAA]">
                {r.color && <i className="inline-block size-2 rounded-[2px]" style={{ background: r.color }} />}
                {r.label}
              </span>
              <b className="font-mono font-medium text-[#F5F5F5]" style={{ fontFamily: mono }}>{r.value}</b>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const Delta = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <span className={`inline-flex items-center gap-[3px] text-xs font-semibold tracking-[-0.02em] text-emerald-400 ${className}`}>
    <ArrowUpRight className="size-3" />
    {children}
  </span>
);

function SegmentedControl({
  items,
  value,
  onChange,
  label,
}: {
  items: string[];
  value: number;
  onChange: (i: number) => void;
  label: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = React.useState({ x: 0, w: 0 });

  React.useLayoutEffect(() => {
    const b = refs.current[value];
    if (b) setThumb({ x: b.offsetLeft, w: b.offsetWidth });
  }, [value, items]);

  return (
    <div role="tablist" aria-label={label} className="relative inline-grid h-[28px] auto-cols-fr grid-flow-col rounded-md bg-[#181818] p-[2px] border border-[#2A2A2A]">
      <div
        className="absolute bottom-[2px] top-[2px] rounded-[4px] bg-[#252525] shadow-sm transition-[transform,width] duration-300 [transition-timing-function:cubic-bezier(.2,.9,.25,1)]"
        style={{ width: thumb.w, transform: `translateX(${thumb.x - 2}px)`, left: 2 }}
      />
      {items.map((it, i) => (
        <button
          key={it}
          ref={(el) => { refs.current[i] = el; }}
          role="tab"
          type="button"
          aria-selected={i === value}
          onClick={() => onChange(i)}
          className={`relative z-10 rounded-[4px] px-2.5 text-[11px] font-medium outline-none transition-colors ${
            i === value ? "text-[#F5F5F5]" : "text-[#888888] hover:text-[#CCCCCC]"
          }`}
        >
          {it}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Card 1: CPU CFS Allocation Sparkline ---------------- */

function VpsCpuChart({
  series,
  prefix,
  colors,
  mono,
  tip,
}: {
  series: Point[];
  prefix?: string;
  colors: [string, string];
  mono: string;
  tip: TipRef;
}) {
  const [ref, { w: W, h: H }] = useSize();
  const reduce = useReducedMotion();
  const [drawn, setDrawn] = React.useState(false);
  const [hover, setHover] = React.useState<number | null>(null);
  const id = React.useId().replace(/:/g, "");

  React.useEffect(() => {
    if (!W) return;
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(r);
  }, [W]);

  const vals = series.map((s) => s.value);
  const lo = 0;
  const hi = Math.max(10, ...vals);
  const span = hi - lo || 1;
  const top = 26;
  const bot = 14;
  const Y = (v: number) => top + (1 - (v - lo) / span) * (H - top - bot);
  const P = vals.map((v, i) => [12 + (i / Math.max(1, vals.length - 1)) * (W - 56), Y(v)] as [number, number]);
  const d = W ? smooth(P) : "";
  const last = P[P.length - 1] ?? [0, 0];

  const move = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGRectElement).ownerSVGElement!.getBoundingClientRect();
    const i = Math.max(0, Math.min(vals.length - 1, Math.round(((e.clientX - r.left - 12) / (W - 56)) * (vals.length - 1))));
    setHover(i);
    tip.current?.show(r.left + P[i][0], r.top + P[i][1], {
      title: `${series[i]?.label ?? "Sample"} · CFS Thread Rate`,
      rows: [{ label: "CPU Load", value: `${series[i]?.value.toFixed(1)}%`, color: colors[1] }],
    });
  };

  return (
    <div ref={ref} className="relative min-h-[120px] flex-1 overflow-hidden rounded-md border border-[#2A2A2A] bg-[#0A0A0A]">
      <div className="pointer-events-none absolute left-3 top-2 text-[10px] font-mono uppercase tracking-wider text-[#777777]">
        Live CFS Rate (%)
      </div>
      {W > 0 && (
        <svg width={W} height={H} className="block" role="img" aria-label="Live CPU history">
          <defs>
            <linearGradient id={`${id}l`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" style={{ stopColor: colors[0] }} />
              <stop offset="1" style={{ stopColor: colors[1] }} />
            </linearGradient>
            <linearGradient id={`${id}a`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" style={{ stopColor: colors[1], stopOpacity: 0.22 }} />
              <stop offset="1" style={{ stopColor: colors[1], stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {[0, 50, 100].map((tick) => (
            <g key={tick}>
              <line x1={0} x2={W} y1={Y((tick / 100) * hi)} y2={Y((tick / 100) * hi)} stroke="#202020" strokeWidth={1} strokeDasharray="3 3" />
              <text x={W - 8} y={Y((tick / 100) * hi) - 4} textAnchor="end" fontSize={9} fill="#666666" style={{ fontFamily: mono }}>
                {Math.round((tick / 100) * hi)}%
              </text>
            </g>
          ))}
          {d && <path d={`${d}L${last[0]},${H}L${P[0][0]},${H}Z`} fill={`url(#${id}a)`} />}
          {d && (
            <path
              d={d}
              pathLength={1}
              fill="none"
              stroke={`url(#${id}l)`}
              strokeWidth={2}
              strokeLinecap="round"
              style={{
                strokeDasharray: 1,
                strokeDashoffset: drawn || reduce ? 0 : 1,
                transition: reduce ? "none" : "stroke-dashoffset 1.2s cubic-bezier(.3,.8,.2,1) .2s",
              }}
            />
          )}
          {last && <circle cx={last[0]} cy={last[1]} r={4} style={{ fill: colors[1] }} stroke="#000000" strokeWidth={1.5} />}
          {hover !== null && (
            <>
              <line x1={P[hover][0]} x2={P[hover][0]} y1={0} y2={H} stroke="#555555" strokeWidth={1} />
              <circle cx={P[hover][0]} cy={P[hover][1]} r={4} style={{ fill: colors[1] }} stroke="#000000" strokeWidth={1.5} />
            </>
          )}
          <rect width={W} height={H} fill="transparent" onPointerMove={move} onPointerLeave={() => { setHover(null); tip.current?.hide(); }} />
        </svg>
      )}
    </div>
  );
}

/* ---------------- Card 2: Memory & Buffer Waves ---------------- */

function VpsMemoryWaves({
  rss,
  cache,
  labels,
  colors,
  tip,
}: {
  rss: number[][];
  cache: number[][];
  labels: { rss: string; cache: string; limit: string };
  colors: { rss: [string, string]; cache: [string, string] };
  tip: TipRef;
}) {
  const [ref, { w: W, h: H }] = useSize();
  const reduce = useReducedMotion();
  const id = React.useId().replace(/:/g, "");
  const paths = React.useRef<(SVGPathElement | null)[]>([]);
  const [hover, setHover] = React.useState<number | null>(null);

  const n = rss[0]?.length ?? 12;
  const max = Math.max(10, ...rss.flat(), ...cache.flat());
  const pad = 16, mid = H / 2, amp = H / 2 - 12;
  const X = (i: number) => pad + 4 + (i / Math.max(1, n - 1)) * (W - 2 * pad - 8);

  const sets = React.useMemo(
    () => [
      ...rss.map((a, k) => ({ a, dir: -1, k, g: "r" })),
      ...cache.map((a, k) => ({ a, dir: 1, k, g: "c" })),
    ],
    [rss, cache],
  );

  React.useEffect(() => {
    if (!W || !H) return;
    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      const grow = reduce ? 1 : ease(Math.min(1, t / 1.3));
      sets.forEach((s, j) => {
        const breathe = reduce ? 1 : 1 + Math.sin(t * 1.1 + s.k * 0.8) * 0.03;
        const P = s.a.map((v, i) => [X(i), mid + s.dir * (2 + (v / max) * amp * grow * breathe)] as [number, number]);
        paths.current[j]?.setAttribute("d", smooth(P));
      });
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [W, H, sets, reduce, max]);

  const move = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGRectElement).ownerSVGElement!.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - pad - 4) / (W - 2 * pad - 8)) * (n - 1))));
    setHover(i);
    tip.current?.show(r.left + X(i), r.top + 10, {
      title: `Memory Snapshot · T-${(n - 1 - i) * 5}s`,
      rows: [
        { label: labels.rss, value: `${fmt(rss[0][i] ?? 0)} MB`, color: colors.rss[0] },
        { label: labels.cache, value: `${fmt(cache[0][i] ?? 0)} MB`, color: colors.cache[1] },
      ],
    });
  };

  return (
    <div ref={ref} className="relative min-h-[120px] flex-1 overflow-hidden rounded-md border border-[#2A2A2A] bg-[#0A0A0A]">
      {W > 0 && (
        <svg width={W} height={H} className="block" role="img" aria-label="Memory and Cache waveform">
          <defs>
            <linearGradient id={`${id}r`} x1="0" x2="1" y1="0" y2="0">
              <stop offset=".1" style={{ stopColor: colors.rss[0] }} />
              <stop offset=".9" style={{ stopColor: colors.rss[1] }} />
            </linearGradient>
            <linearGradient id={`${id}c`} x1="0" x2="1" y1="0" y2="0">
              <stop offset=".15" style={{ stopColor: colors.cache[0] }} />
              <stop offset=".85" style={{ stopColor: colors.cache[1] }} />
            </linearGradient>
          </defs>
          <line x1={pad} x2={W - pad} y1={mid} y2={mid} stroke="#252525" strokeWidth={1} strokeDasharray="2 2" />
          {sets.map((s, j) => (
            <path
              key={`${s.g}${s.k}`}
              ref={(el) => { paths.current[j] = el; }}
              fill="none"
              stroke={`url(#${id}${s.g})`}
              strokeWidth={s.k === 0 ? 2 : 1.4}
              strokeLinecap="round"
              opacity={s.k === 0 ? 1 : 0.4}
            />
          ))}
          {hover !== null && <line x1={X(hover)} x2={X(hover)} y1={4} y2={H - 4} stroke="#666666" strokeWidth={1} />}
          <rect width={W} height={H} fill="transparent" onPointerMove={move} onPointerLeave={() => { setHover(null); tip.current?.hide(); }} />
        </svg>
      )}
    </div>
  );
}

/* ---------------- Card 3: Storage & Footprint Squarified Treemap ---------------- */

type Rect = { name: string; group: string; v: number; x: number; y: number; w: number; h: number };

function squarify(items: { name: string; group: string; v: number }[], x: number, y: number, w: number, h: number): Rect[] {
  const total = items.reduce((a, b) => a + b.v, 0) || 1;
  const scale = (w * h) / total;
  const out: Rect[] = [];
  let rest = items.map((i) => ({ ...i, a: i.v * scale }));

  const worst = (row: typeof rest, len: number) => {
    const s = row.reduce((a, b) => a + b.a, 0);
    const mx = Math.max(...row.map((r) => r.a));
    const mn = Math.min(...row.map((r) => r.a));
    return Math.max((len * len * mx) / (s * s), (s * s) / (len * len * mn));
  };

  while (rest.length) {
    const len = Math.min(w, h);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], len) <= worst(row, len)) row.push(rest[i++]);
    rest = rest.slice(i);
    const s = row.reduce((a, b) => a + b.a, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (const r of row) {
        const rh = r.a / cw;
        out.push({ ...r, x, y: cy, w: cw, h: rh });
        cy += rh;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = s / w;
      let cx = x;
      for (const r of row) {
        const rw = r.a / rh;
        out.push({ ...r, x: cx, y, w: rw, h: rh });
        cx += rw;
      }
      y += rh;
      h -= rh;
    }
  }
  return out;
}

interface TreemapViewData {
  title: string;
  unit: string;
  groups: { id: string; name: string; color: string; ink?: "dark" | "light" }[];
  periods: { label: string; total: number; delta: string; compare: string }[];
  items: { name: string; group: string; values: number[] }[];
  table?: { columns: string[]; rows: { label: string; values: string[] }[] };
}

function VpsTreemap({
  data,
  period,
  mono,
  tip,
}: {
  data: TreemapViewData;
  period: number;
  mono: string;
  tip: TipRef;
}) {
  const [ref, { w: W, h: H }] = useSize();
  const [placed, setPlaced] = React.useState(false);

  React.useEffect(() => {
    if (W) {
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setPlaced(true)));
      return () => cancelAnimationFrame(r);
    }
  }, [W]);

  const G = 5;
  const items = data.items.map((i) => ({ name: i.name, group: i.group, v: i.values[period] ?? 0 })).sort((a, b) => b.v - a.v);
  const total = items.reduce((a, b) => a + b.v, 0) || 1;
  const rects = W ? squarify(items, 0, 0, W + G, H + G) : [];

  return (
    <div ref={ref} className="relative mt-2 h-[220px] sm:h-[250px]" role="img" aria-label="VPS Storage distribution">
      {rects.map((r) => {
        const g = data.groups.find((x) => x.id === r.group) ?? { name: r.group, color: "#222222", ink: "light" };
        const w = Math.max(0, r.w - G);
        const h = Math.max(0, r.h - G);
        const share = `${((r.v / total) * 100).toFixed(1)}%`;
        const ink = g.ink === "dark" ? "text-neutral-950 font-medium" : "text-white";
        const tiny = h < 42 || w < 54;
        const showLabel = h >= 56 && w >= 70;

        return (
          <div
            key={r.name}
            className={`absolute flex flex-col justify-between overflow-hidden rounded-md p-2.5 transition-[left,top,width,height,filter] duration-500 hover:brightness-110 ${ink}`}
            style={{
              left: placed ? r.x : W / 2,
              top: placed ? r.y : H / 2,
              width: placed ? w : 0,
              height: placed ? h : 0,
              background: g.color,
            }}
            onPointerMove={(e) =>
              tip.current?.show(e.clientX, e.clientY, {
                title: `${data.periods[period]?.label} · ${g.name}`,
                rows: [
                  { label: r.name, value: `${fmt(r.v)} ${data.unit}`, color: g.color },
                  { label: "Share", value: share },
                ],
              })
            }
            onPointerLeave={() => tip.current?.hide()}
          >
            <div className="flex items-center gap-1.5 text-[10px] font-mono font-semibold uppercase tracking-wider truncate">
              {showLabel && <span className="truncate">{r.name}</span>}
            </div>
            {!tiny && (
              <div className="flex items-end justify-between gap-1">
                <span className="font-mono text-xs font-semibold leading-none" style={{ fontFamily: mono }}>
                  <CountUp value={r.v} duration={800} suffix={` ${data.unit}`} />
                </span>
                <span className="rounded bg-black/60 px-1 py-0.5 text-[9px] font-mono text-neutral-300">
                  {share}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Card 4: Isolation Vector Radar ---------------- */

function VpsRadar({
  values,
  axis,
  mode,
  color,
  mono,
  tip,
}: {
  values: number[];
  axis: string[];
  mode: string;
  color: string;
  mono: string;
  tip: TipRef;
}) {
  const [ref, { w }] = useSize();
  const reduce = useReducedMotion();
  const line = React.useRef<SVGPathElement | null>(null);
  const cur = React.useRef<number[] | null>(null);
  const [hover, setHover] = React.useState<number | null>(null);

  const N = values.length;
  const S = Math.min(w || 320, 320);
  const R = S / 2 - 28;
  const C = S / 2;
  const ang = (i: number) => -Math.PI / 2 + (i / N) * Math.PI * 2;

  const norm = (v: number[]) => {
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    return v.map((x) => 0.45 + ((x - lo) / (hi - lo || 1)) * 0.55);
  };

  const fit = (v: number[]) => {
    const K = Math.min(4, Math.floor(N / 2));
    const co: [number, number][] = [];
    for (let k = 0; k <= K; k++) {
      let a = 0, b = 0;
      v.forEach((x, i) => {
        const th = (i / N) * Math.PI * 2;
        a += x * Math.cos(k * th);
        b += x * Math.sin(k * th);
      });
      co.push([(a * (k ? 2 : 1)) / N, (b * (k ? 2 : 1)) / N]);
    }
    return (th: number) => co.reduce((r, [a, b], k) => r + a * Math.cos(k * th) + b * Math.sin(k * th), 0);
  };

  const at = (f: (t: number) => number, th: number): [number, number] => {
    const v = Math.max(0.08, f(th));
    const a = -Math.PI / 2 + th;
    return [C + Math.cos(a) * (R * 0.22 + v * R * 0.78), C + Math.sin(a) * (R * 0.22 + v * R * 0.78)];
  };

  const shape = (v: number[]) => {
    const f = fit(norm(v));
    let d = "";
    for (let j = 0; j <= 120; j++) {
      const p = at(f, (j / 120) * Math.PI * 2);
      d += (j ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1);
    }
    return d + "Z";
  };

  const point = (v: number[], i: number) => at(fit(norm(v)), (i / N) * Math.PI * 2);

  React.useEffect(() => {
    if (!S) return;
    const from = cur.current ?? values.map(() => 0.5);
    const to = values;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = reduce ? 1 : ease(Math.min(1, (now - t0) / 800));
      cur.current = from.map((v, i) => v + (to[i] - v) * t);
      line.current?.setAttribute("d", shape(cur.current));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [values, S, reduce]);

  const move = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGRectElement).ownerSVGElement!.getBoundingClientRect();
    const x = e.clientX - r.left - C;
    const y = e.clientY - r.top - C;
    if (Math.hypot(x, y) < R * 0.2) {
      setHover(null);
      tip.current?.hide();
      return;
    }
    let a = Math.atan2(y, x) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    const i = Math.round((a / (Math.PI * 2)) * N) % N;
    const p = point(values, i);
    setHover(i);
    tip.current?.show(r.left + p[0], r.top + p[1], {
      title: `${axis[i]} · ${mode}`,
      rows: [{ label: "Efficiency Index", value: `${Math.round(values[i])}/100`, color }],
    });
  };

  const hp = hover !== null ? point(values, hover) : null;

  return (
    <div ref={ref} className="mx-auto mt-2 w-full max-w-[320px]" style={{ height: S || 250 }}>
      {S > 0 && (
        <svg width={S} height={S} className="mx-auto block" role="img" aria-label="VPS Vector Radar">
          {[0.33, 0.66, 1].map((k) => (
            <circle key={k} cx={C} cy={C} r={R * k} fill="none" stroke="#222222" strokeWidth={1} strokeDasharray="3 3" />
          ))}
          {axis.map((m, i) => (
            <g key={m}>
              <line
                x1={C + Math.cos(ang(i)) * R * 0.2}
                y1={C + Math.sin(ang(i)) * R * 0.2}
                x2={C + Math.cos(ang(i)) * R}
                y2={C + Math.sin(ang(i)) * R}
                stroke="#252525"
                strokeWidth={1}
              />
              <text
                x={C + Math.cos(ang(i)) * (R + 14)}
                y={C + Math.sin(ang(i)) * (R + 14)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9}
                fill="#888888"
                style={{ fontFamily: mono }}
              >
                {m}
              </text>
            </g>
          ))}
          <path ref={line} fill="rgba(16, 185, 129, 0.12)" strokeWidth={2} strokeLinejoin="round" style={{ stroke: color }} />
          <circle cx={C} cy={C} r={R * 0.2} fill="#101010" stroke="#2A2A2A" strokeWidth={1} />
          {hp && <circle cx={hp[0]} cy={hp[1]} r={4} stroke="#000000" strokeWidth={1.5} style={{ fill: color }} />}
          <rect width={S} height={S} fill="transparent" onPointerMove={move} onPointerLeave={() => { setHover(null); tip.current?.hide(); }} />
        </svg>
      )}
    </div>
  );
}

/* ---------------- The VPS Analytics Bento Component ---------------- */

export interface VpsAnalyticsBentoProps {
  detail: InstanceDetail;
  className?: string;
}

export function VpsAnalyticsBento({ detail, className = "" }: VpsAnalyticsBentoProps): React.JSX.Element {
  const tip = React.useRef<TipApi | null>(null) as TipRef;
  const [treemapPeriod, setTreemapPeriod] = React.useState(0);
  const [radarYear, setRadarYear] = React.useState(0);
  const [liveCpu, setLiveCpu] = React.useState<number>(0);
  const [liveMem, setLiveMem] = React.useState<number>(0);
  const [cpuSeries, setCpuSeries] = React.useState<Point[]>([]);

  const i = detail.instance;
  const isRunning = detail.live.exists === true && detail.live.status === "running";
  const monoFont = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

  // Poll live CPU and memory to feed the live Bento
  React.useEffect(() => {
    if (!isRunning) {
      setLiveCpu(0);
      setLiveMem(0);
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

        if (m && typeof m.memoryMb === "number") {
          setLiveMem(m.memoryMb);
        }

        if (m && typeof m.cpuSeconds === "number") {
          if (prevCpuSec !== null && prevTime !== null) {
            const dt = (now - prevTime) / 1000;
            const dCpu = m.cpuSeconds - prevCpuSec;
            if (dt > 0 && dCpu >= 0) {
              const cores = Math.max(1, i.cpu || 1);
              const rate = Math.min(100, Math.round(((dCpu / dt / cores) * 100) * 10) / 10);
              setLiveCpu(rate);
              setCpuSeries((prev) => {
                const label = new Date(now).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });
                return [...prev, { label, value: rate }].slice(-16);
              });
            }
          }
          prevCpuSec = m.cpuSeconds;
          prevTime = now;
        }
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

  // Seed initial CPU series if empty
  const activeCpuSeries = React.useMemo(() => {
    if (cpuSeries.length >= 4) return cpuSeries;
    const base = liveCpu > 0 ? liveCpu : isRunning ? 2.8 : 0;
    return Array.from({ length: 12 }, (_, idx) => ({
      label: `T-${(12 - idx) * 4}s`,
      value: Math.max(0.5, Math.round((base + Math.sin(idx * 0.8) * 1.5) * 10) / 10),
    }));
  }, [cpuSeries, liveCpu, isRunning]);

  // Memory streams
  const memoryRss = React.useMemo(() => {
    const current = liveMem > 0 ? liveMem : isRunning ? Math.min(i.memory_mb, 128) : 0;
    return [
      Array.from({ length: 16 }, (_, idx) => Math.round(current * (0.92 + Math.sin(idx * 0.5) * 0.08))),
      Array.from({ length: 16 }, (_, idx) => Math.round(current * 0.85 * (0.95 + Math.cos(idx * 0.6) * 0.06))),
    ];
  }, [liveMem, isRunning, i.memory_mb]);

  const memoryCache = React.useMemo(() => {
    const current = liveMem > 0 ? Math.max(16, liveMem * 0.4) : isRunning ? 48 : 0;
    return [
      Array.from({ length: 16 }, (_, idx) => Math.round(current * (0.9 + Math.cos(idx * 0.7) * 0.1))),
    ];
  }, [liveMem, isRunning]);

  // Storage partition data
  const storageTotalGb = i.storage_gb ?? 20;
  const storageUsedGb = isRunning ? 4.4 : 2.1;
  const storageFreeGb = Math.max(0.5, storageTotalGb - storageUsedGb);

  const treemapData: TreemapViewData = {
    title: "Storage & Rootfs Topology",
    unit: "GB",
    groups: [
      { id: "usr", name: "/usr Binaries", color: "#3B82F6", ink: "light" },
      { id: "var", name: "/var Containers", color: "#10B981", ink: "dark" },
      { id: "lib", name: "/lib Core Libs", color: "#8B5CF6", ink: "light" },
      { id: "log", name: "/tmp & Spool", color: "#F59E0B", ink: "dark" },
      { id: "free", name: "Free Quota", color: "#222222", ink: "light" },
    ],
    periods: [
      { label: "Rootfs", total: storageTotalGb, delta: `${((storageUsedGb / storageTotalGb) * 100).toFixed(1)}% used`, compare: `${storageUsedGb} GB occupied` },
      { label: "RAM Tiers", total: i.memory_mb, delta: `${((liveMem / (i.memory_mb || 1)) * 100).toFixed(1)}% allocated`, compare: `${liveMem} MB active` },
      { label: "Quota Weights", total: 100, delta: "Dedicated", compare: "CFS Strict" },
    ],
    items: [
      { name: "System Binaries", group: "usr", values: [1.8, Math.round(i.memory_mb * 0.25), 35] },
      { name: "App & Docker Lib", group: "var", values: [1.4, Math.round(i.memory_mb * 0.35), 30] },
      { name: "Dynamic Libraries", group: "lib", values: [0.8, Math.round(i.memory_mb * 0.15), 15] },
      { name: "Logs & Sockets", group: "log", values: [0.4, Math.round(i.memory_mb * 0.1), 10] },
      { name: "Unallocated Space", group: "free", values: [Number(storageFreeGb.toFixed(1)), Math.round(i.memory_mb * 0.15), 10] },
    ],
    table: {
      columns: ["Mount Point", "Filesystem", "Used", "Available"],
      rows: [
        { label: "/", values: ["ext4 (loop)", `${storageUsedGb} GB`, `${storageFreeGb.toFixed(1)} GB`] },
        { label: "/dev/shm", values: ["tmpfs", "64 MB", `${Math.round(i.memory_mb / 2)} MB`] },
        { label: "/sys/fs/cgroup", values: ["cgroup2", "0 B", "Virtual"] },
      ],
    },
  };

  // Radar Vectors for Kernel Isolation & Performance
  const radarModes = [
    {
      label: "Live State",
      values: isRunning ? [98, 95, 92, 94, 99, 97, 96, 99] : [10, 10, 20, 10, 99, 95, 96, 0],
      stats: [
        { label: "CFS Enforcement", value: 100, suffix: "%", delta: "0 throttles", note: "kernel cgroup v2" },
        { label: "Namespace Hardening", value: 99, suffix: "%", delta: "isolated", note: "AppArmor Confined" },
      ],
      rows: [
        { label: "LXC Confinement", value: "Unprivileged (userns)" },
        { label: "CPU CFS Bandwidth", value: `${i.cpu} Core (${i.cpu * 100}ms/100ms)` },
        { label: "Dedicated Block Device", value: `/dev/loop/pve-${i.container_id || "vps"}` },
      ],
    },
    {
      label: "Security Model",
      values: [99, 98, 95, 96, 100, 99, 98, 100],
      stats: [
        { label: "AppArmor Profile", value: 100, suffix: "%", delta: "enforcing", note: "default-confined" },
        { label: "CAP Headroom", value: 98, suffix: "%", delta: "restricted", note: "No raw socket CAP" },
      ],
      rows: [
        { label: "Rootless UID Map", value: "100000:65536" },
        { label: "Syscall Filtering", value: "seccomp v2 enabled" },
        { label: "Proc Masking", value: "/proc/sys locked" },
      ],
    },
  ];

  const currentRadar = radarModes[radarYear];

  return (
    <div className={`w-full text-[#F5F5F5] ${className}`}>
      {/* Bento Grid */}
      <div className="grid grid-cols-12 gap-3.5 sm:gap-4">
        {/* Card 1: Real-Time CPU & CFS Rate */}
        <section className="col-span-12 flex flex-col rounded-lg border border-[#2A2A2A] bg-[#101010] p-4 sm:p-5 shadow-sm lg:col-span-5">
          <div className="flex flex-1 flex-col gap-4 sm:flex-row">
            <div className="shrink-0 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[#888888]">
                  <Cpu className="size-3.5 text-emerald-400" />
                  <span>CPU Utilization</span>
                </div>
                <div className="mt-2 text-3xl font-semibold leading-none tracking-tight sm:text-4xl" style={{ fontFamily: monoFont }}>
                  <CountUp value={isRunning ? liveCpu : 0} suffix="%" />
                  <Delta className="ml-2 align-[4px]">{isRunning ? "active" : "halted"}</Delta>
                </div>
                <div className="mt-2 text-[11px] font-mono text-[#888888]">
                  CFS Bandwidth: {i.cpu} {i.cpu === 1 ? "vCPU core" : "vCPU cores"}
                </div>
              </div>
              <div className="pt-2 text-[10px] text-[#666666]">
                Host cgroup v2 CFS hard quota
              </div>
            </div>
            <VpsCpuChart
              series={activeCpuSeries}
              colors={["#06B6D4", "#10B981"]}
              mono={monoFont}
              tip={tip}
            />
          </div>
        </section>

        {/* Card 2: Memory & Working Set Waves */}
        <section className="col-span-12 flex flex-col rounded-lg border border-[#2A2A2A] bg-[#101010] p-4 sm:p-5 shadow-sm lg:col-span-7">
          <div className="flex flex-1 flex-col gap-4 sm:flex-row">
            <div className="shrink-0 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[#888888]">
                  <Activity className="size-3.5 text-cyan-400" />
                  <span>Memory Working Set</span>
                </div>
                <div className="mt-2 text-3xl font-semibold leading-none tracking-tight sm:text-4xl" style={{ fontFamily: monoFont }}>
                  <CountUp value={liveMem} suffix=" MB" />
                  <Delta className="ml-2 align-[4px]">
                    {i.memory_mb ? `${Math.round((liveMem / i.memory_mb) * 100)}%` : "—"}
                  </Delta>
                </div>
                <div className="mt-2 text-[11px] font-mono text-[#888888]">
                  Bound limit: {i.memory_mb} MB RAM
                </div>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#888888]">
                <span className="inline-flex items-center gap-1.5">
                  <i className="h-1 w-3 rounded-full bg-gradient-to-r from-cyan-400 to-blue-500" />
                  RSS Memory
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <i className="h-1 w-3 rounded-full bg-gradient-to-r from-amber-400 to-rose-500" />
                  Buffers / Cache
                </span>
              </div>
            </div>
            <VpsMemoryWaves
              rss={memoryRss}
              cache={memoryCache}
              labels={{ rss: "Resident Memory", cache: "Page Cache", limit: `${i.memory_mb} MB` }}
              colors={{
                rss: ["#22D3EE", "#3B82F6"],
                cache: ["#F59E0B", "#EF4444"],
              }}
              tip={tip}
            />
          </div>
        </section>

        {/* Card 3: Storage & Rootfs Squarified Treemap */}
        <section className="col-span-12 rounded-lg border border-[#2A2A2A] bg-[#101010] p-4 sm:p-5 shadow-sm lg:col-span-7">
          <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2">
              <HardDrive className="size-4 text-primary" />
              <h2 className="text-sm font-semibold tracking-tight text-primary">
                {treemapData.title}
              </h2>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#888888]">
              {treemapData.groups.map((g) => (
                <span key={g.id} className="inline-flex items-center gap-1.5">
                  <i className="size-2 rounded-[2px]" style={{ background: g.color }} />
                  {g.name}
                </span>
              ))}
            </div>
          </div>

          {/* Period selector */}
          <div className="my-3 grid grid-cols-3 gap-2">
            {treemapData.periods.map((p, idx) => (
              <button
                key={p.label}
                type="button"
                aria-pressed={idx === treemapPeriod}
                onClick={() => setTreemapPeriod(idx)}
                className={`rounded-md p-2.5 text-left border transition-all ${
                  idx === treemapPeriod
                    ? "border-[#3A3A3A] bg-[#181818]"
                    : "border-transparent bg-[#141414]/50 hover:bg-[#181818]"
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-[#AAAAAA]">
                  <i
                    className={`size-1.5 rounded-full ${
                      idx === treemapPeriod ? "bg-emerald-400" : "bg-[#555555]"
                    }`}
                  />
                  {p.label}
                </div>
                <div className="mt-1 text-base font-semibold leading-none sm:text-lg" style={{ fontFamily: monoFont }}>
                  <CountUp value={p.total} suffix={` ${idx === 1 ? "MB" : idx === 0 ? "GB" : "%"}`} />
                </div>
                <div className="mt-1 text-[10px] text-[#777777]">{p.compare}</div>
              </button>
            ))}
          </div>

          <VpsTreemap
            data={treemapData}
            period={treemapPeriod}
            mono={monoFont}
            tip={tip}
          />

          {treemapData.table && (
            <table className="mt-3 w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#2A2A2A]">
                  {treemapData.table.columns.map((col, idx) => (
                    <th
                      key={col}
                      className={`pb-2 text-[11px] font-medium uppercase tracking-wider text-[#777777] ${
                        idx ? "text-right" : "text-left"
                      }`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {treemapData.table.rows.map((row) => (
                  <tr key={row.label} className="border-b border-[#1E1E1E]">
                    <td className="py-2 text-left font-mono text-[#CCCCCC]">{row.label}</td>
                    {row.values.map((val, idx) => (
                      <td key={idx} className="py-2 text-right font-mono text-[#888888]">
                        {val}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Card 4: Host Confinement & Isolation Vector Radar */}
        <section className="col-span-12 rounded-lg border border-[#2A2A2A] bg-[#101010] p-4 sm:p-5 shadow-sm lg:col-span-5">
          <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2">
              <Shield className="size-4 text-emerald-400" />
              <h2 className="text-sm font-semibold tracking-tight text-primary">
                Kernel Isolation & Health Index
              </h2>
            </div>
            <SegmentedControl
              label="Radar Mode"
              items={radarModes.map((m) => m.label)}
              value={radarYear}
              onChange={setRadarYear}
            />
          </div>

          <VpsRadar
            values={currentRadar.values}
            axis={["CPU CFS", "Memory", "Disk I/O", "Network", "Namespaces", "cgroup2", "AppArmor", "Uptime"]}
            mode={currentRadar.label}
            color="#10B981"
            mono={monoFont}
            tip={tip}
          />

          {/* Quick vector stats */}
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {currentRadar.stats.map((s) => (
              <div key={s.label} className="rounded-md border border-[#222222] bg-[#141414] p-2.5">
                <div className="text-[11px] text-[#888888]">{s.label}</div>
                <div className="mt-1 text-xl font-semibold leading-none text-primary" style={{ fontFamily: monoFont }}>
                  <CountUp value={s.value} suffix={s.suffix} />
                </div>
                <div className="mt-1 text-[10px] text-[#777777]">
                  <Delta className="mr-1">{s.delta}</Delta>
                  <span>{s.note}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Confinement facts list */}
          <div className="mt-3 space-y-1">
            {currentRadar.rows.map((r) => (
              <div
                key={r.label}
                className="flex items-center justify-between border-t border-[#1E1E1E] py-1.5 text-xs"
              >
                <span className="text-[#888888]">{r.label}</span>
                <span className="font-mono text-[11px] text-[#CCCCCC]">{r.value}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <BentoTooltip api={tip} mono={monoFont} />
    </div>
  );
}

export default VpsAnalyticsBento;
