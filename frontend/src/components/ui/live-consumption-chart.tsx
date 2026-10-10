import * as React from "react";
import {
  Bar,
  BarChart,
  Rectangle,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { MotionConfig, useMotionValueEvent, useSpring } from "motion/react";
import NumberFlow from "@number-flow/react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ChartPoint {
  label: string;
  value: number;
}

interface HoverTraceChartProps {
  title: string;
  unit: string;
  decimals?: number;
  data: ChartPoint[];
  /** Optional enforced limit, drawn as a dashed reference line. */
  limit?: number | null;
}

const CHART_MARGIN = 38;
const BAR_COLOR = "#F5F5F5";
const MUTED = "#888888";
const TRACK = "#505050";

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

interface TraceShapeProps {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  fill?: unknown;
  index?: unknown;
  isActive?: unknown;
  highlightedIndex: number;
}

function HoverTraceBarShape(props: TraceShapeProps): React.JSX.Element {
  const { highlightedIndex } = props;
  const x = num(props.x);
  const y = num(props.y);
  const width = num(props.width);
  const height = num(props.height);
  const index = typeof props.index === "number" ? props.index : Number(props.index ?? -1);
  const fillOpacity = props.isActive === true || index === highlightedIndex ? 1 : 0.2;
  return (
    <g>
      <Rectangle x={x} y={y} width={width} height={height} fill="transparent" />
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        radius={4}
        fill={typeof props.fill === "string" ? props.fill : BAR_COLOR}
        fillOpacity={fillOpacity}
        className="transition-opacity duration-200"
      />
    </g>
  );
}

function HoverTraceLabel({ viewBox, value }: { viewBox?: unknown; value: number }): React.JSX.Element {
  const box = (viewBox ?? {}) as { x?: unknown; y?: unknown };
  const x = num(box.x);
  const y = num(box.y);
  const formattedValue = value.toLocaleString();
  const width = formattedValue.length * 8 + 12;
  return (
    <>
      <rect x={x - CHART_MARGIN} y={y - 9} width={width} height={18} fill={BAR_COLOR} rx={4} />
      <text className="font-mono text-[11px]" fontWeight={600} x={x - CHART_MARGIN + 7} y={y + 4} fill="#000000">
        {formattedValue}
      </text>
      <ellipse cx="99.5%" cy={y} rx={3} ry={3} fill={BAR_COLOR} />
    </>
  );
}

export function HoverTraceChart({ title, unit, decimals = 0, data, limit = null }: HoverTraceChartProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);

  const maxData = React.useMemo(() => {
    let best = { index: 0, label: data[0]?.label ?? "", value: data[0]?.value ?? 0 };
    data.forEach((item, index) => {
      if (item.value > best.value) best = { index, label: item.label, value: item.value };
    });
    return best;
  }, [data]);

  const selectedData =
    activeIndex != null && data[activeIndex]
      ? { index: activeIndex, label: data[activeIndex].label, value: data[activeIndex].value }
      : maxData;

  const valueSpring = useSpring(selectedData.value, { stiffness: 110, damping: 20 });
  const [springValue, setSpringValue] = React.useState(selectedData.value);

  const handleBarHover = React.useCallback(
    (index: number) => {
      setActiveIndex(index);
      valueSpring.set(data[index]?.value ?? maxData.value);
    },
    [data, maxData.value, valueSpring]
  );

  useMotionValueEvent(valueSpring, "change", (latest) => {
    setSpringValue(Math.round(latest));
  });

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full flex-col" role="img" aria-label={`${title} history chart`}>
        <div className="mb-4 flex items-end justify-between">
          <div className="space-y-1">
            <p className="font-mono text-xs text-muted">[{title}] {unit}</p>
            <p className="font-mono text-3xl tracking-tighter text-primary">
              <NumberFlow value={selectedData.value} format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals }} />
            </p>
          </div>
          <div className="space-y-1 text-right">
            <p className="font-mono text-[10px] text-muted">[time]</p>
            <p className="font-mono text-xs text-primary">{selectedData.label}</p>
          </div>
        </div>

        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              accessibilityLayer
              data={data}
              margin={{ left: CHART_MARGIN }}
              onMouseMove={(state) => {
                const s = state as unknown as { activeTooltipIndex?: unknown } | null | undefined;
                const idx = s?.activeTooltipIndex;
                const n = typeof idx === "number" ? idx : Number(idx);
                if (Number.isInteger(n) && n >= 0) handleBarHover(n);
              }}
              onMouseLeave={() => {
                setActiveIndex(null);
                valueSpring.set(maxData.value);
              }}
            >
              <XAxis
                dataKey="label"
                tickLine={false}
                tickMargin={10}
                axisLine={false}
                minTickGap={24}
                tick={{ fill: MUTED, fontSize: 11 }}
              />
              <Tooltip cursor={false} content={() => null} />
              <Bar
                dataKey="value"
                fill={BAR_COLOR}
                radius={4}
                shape={(props) => <HoverTraceBarShape {...props} highlightedIndex={selectedData.index} />}
              />
              {limit !== null ? (
                <ReferenceLine y={limit} stroke={TRACK} strokeDasharray="3 3" />
              ) : null}
              <ReferenceLine
                y={springValue}
                stroke={BAR_COLOR}
                strokeDasharray="3 3"
                label={<HoverTraceLabel value={selectedData.value} />}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </MotionConfig>
  );
}

interface LiveSample {
  t: number;
  cpuSeconds: number | null;
  memoryMb: number | null;
}

const SAMPLE_INTERVAL_MS = 5000;
const MAX_SAMPLES = 24;

function timeLabel(t: number): string {
  try {
    return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export interface LiveConsumptionChartsProps {
  instanceId: string;
  running: boolean;
  /** Allocated vCPUs; CPU % is expressed against this allocation. */
  vcpu: number;
  /** Enforced memory limit in MB, drawn as a reference line. */
  memoryLimitMb: number | null;
}

/**
 * Live CPU/memory history built by polling the real metrics endpoint.
 * No fabricated data: charts render only from collected samples, and CPU %
 * is the measured rate against the vCPU allocation.
 */
export function LiveConsumptionCharts({ instanceId, running, vcpu, memoryLimitMb }: LiveConsumptionChartsProps): React.JSX.Element {
  const [samples, setSamples] = React.useState<LiveSample[]>([]);

  React.useEffect(() => {
    if (!running) {
      setSamples([]);
      return;
    }
    let cancelled = false;
    const take = async (): Promise<void> => {
      try {
        const d = await api.get<{ metrics: { cpuSeconds: number | null; memoryMb: number | null } | null }>(
          `/api/instances/${instanceId}/live`
        );
        if (cancelled) return;
        setSamples((prev) =>
          [...prev, { t: Date.now(), cpuSeconds: d.metrics?.cpuSeconds ?? null, memoryMb: d.metrics?.memoryMb ?? null }].slice(-MAX_SAMPLES)
        );
      } catch {
        /* keep previous samples; a gap beats invented points */
      }
    };
    void take();
    const timer = setInterval(() => void take(), SAMPLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [instanceId, running]);

  const memoryData: ChartPoint[] = React.useMemo(
    () =>
      samples
        .filter((s) => s.memoryMb !== null)
        .map((s) => ({ label: timeLabel(s.t), value: s.memoryMb as number })),
    [samples]
  );

  const cpuData: ChartPoint[] = React.useMemo(() => {
    const out: ChartPoint[] = [];
    const safeVcpu = vcpu > 0 ? vcpu : 1;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      if (prev.cpuSeconds === null || cur.cpuSeconds === null) continue;
      const dt = (cur.t - prev.t) / 1000;
      const delta = cur.cpuSeconds - prev.cpuSeconds;
      if (!(dt > 0) || delta < 0) continue;
      out.push({ label: timeLabel(cur.t), value: Math.round(((delta / dt / safeVcpu) * 100) * 10) / 10 });
    }
    return out;
  }, [samples, vcpu]);

  if (!running) {
    return <p className="text-sm text-muted">Unavailable — the container is not running.</p>;
  }
  if (memoryData.length < 2 && cpuData.length < 2) {
    return <p className="text-sm text-muted" role="status">Collecting live samples (every 5s)…</p>;
  }
  return (
    <div className={cn("grid grid-cols-1 gap-5", memoryData.length >= 2 && cpuData.length >= 2 && "lg:grid-cols-2")}>
      {memoryData.length >= 2 ? (
        <div className="rounded-md border border-border px-3 py-2">
          <HoverTraceChart title="memory" unit="MB" decimals={0} data={memoryData} limit={memoryLimitMb} />
        </div>
      ) : null}
      {cpuData.length >= 2 ? (
        <div className="rounded-md border border-border px-3 py-2">
          <HoverTraceChart title="cpu" unit="% of allocation" decimals={1} data={cpuData} limit={100} />
        </div>
      ) : null}
      <p className="text-xs text-muted lg:col-span-2">
        Live samples from the host every 5s. CPU % is the measured rate against the {vcpu} vCPU allocation; the dashed line marks 100%.
      </p>
    </div>
  );
}
