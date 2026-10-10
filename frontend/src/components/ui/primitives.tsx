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
  running: "border-highlight bg-raised text-primary",
  stopped: "border-border bg-surface text-muted",
  starting: "border-mid bg-raised text-primary",
  stopping: "border-mid bg-raised text-primary",
  failed: "border-mid bg-raised text-primary",
  unknown: "border-border bg-surface text-muted",
  active: "border-highlight bg-raised text-primary",
  disabled: "border-border bg-surface text-muted",
  online: "border-highlight bg-raised text-primary",
  offline: "border-border bg-surface text-muted",
  unconfigured: "border-border bg-surface text-muted",
  unavailable: "border-border bg-surface text-muted",
  error: "border-mid bg-raised text-primary",
  expired: "border-border bg-surface text-muted",
  revoked: "border-border bg-surface text-muted line-through",
};

export function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
        STATUS_STYLES[status] ?? STATUS_STYLES.unknown
      )}
    >
      {label}
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
