import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
};

export function Button({ variant = "primary", className, ...props }: ButtonProps): React.JSX.Element {
  return (
    <button
      className={cn(
        variant === "primary" && "kct-btn-primary disabled:opacity-60",
        variant === "ghost" && "kct-btn-ghost disabled:opacity-60",
        variant === "danger" &&
          "rounded-md border border-mid bg-transparent px-4 py-2 text-sm font-semibold text-primary hover:bg-raised disabled:opacity-60",
        "inline-flex items-center justify-center gap-2",
        className
      )}
      {...props}
    />
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...props} className={cn("kct-input", props.className)} />;
}

export function Label(props: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return <label {...props} className={cn("mb-1.5 block text-sm font-medium text-primary", props.className)} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={cn("kct-card p-5", className)} />;
}

export function FieldError({ message }: { message?: string }): React.JSX.Element | null {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1.5 text-xs text-primary/90">
      {message}
    </p>
  );
}

const STATUS_STYLES: Record<string, string> = {
  running: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  stopped: "border-border bg-surface text-muted",
  starting: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  stopping: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  unknown: "border-border bg-surface text-muted",
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  disabled: "border-border bg-surface text-muted",
  online: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  offline: "border-border bg-surface text-muted",
  unconfigured: "border-border bg-surface text-muted",
  unavailable: "border-border bg-surface text-muted",
  error: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  expired: "border-border bg-surface text-muted",
  revoked: "border-border bg-surface text-muted line-through",
  missing: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  suspended: "border-purple-500/30 bg-purple-500/10 text-purple-300",
};

const STATUS_DOTS: Record<string, string> = {
  running: "bg-emerald-400",
  online: "bg-emerald-400",
  active: "bg-emerald-400",
  starting: "bg-amber-400",
  stopping: "bg-amber-400",
  stopped: "bg-zinc-500",
  offline: "bg-zinc-500",
  disabled: "bg-zinc-600",
  failed: "bg-rose-400",
  error: "bg-rose-400",
  suspended: "bg-purple-400",
  missing: "bg-amber-400",
  expired: "bg-zinc-600",
  revoked: "bg-zinc-600",
  unconfigured: "bg-zinc-600",
  unavailable: "bg-zinc-600",
};

export function StatusBadge({ status, className }: { status?: string | null; className?: string }): React.JSX.Element {
  const safeStatus = (typeof status === "string" && status.trim()) ? status.trim().toLowerCase() : "unknown";
  const label = safeStatus.charAt(0).toUpperCase() + safeStatus.slice(1);
  const dot = STATUS_DOTS[safeStatus] ?? "bg-zinc-500";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium tracking-tight",
        STATUS_STYLES[safeStatus] ?? STATUS_STYLES.unknown,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dot)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="kct-card flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-semibold text-primary">{title}</p>
      {hint ? <p className="max-w-md text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

export function InlineAlert({ message }: { message?: string }): React.JSX.Element | null {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md border border-mid bg-raised px-3 py-2 text-sm text-primary">
      {message}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-primary">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
