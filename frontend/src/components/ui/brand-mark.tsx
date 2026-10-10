import { Server } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Application brand mark: the uploaded logo when configured, otherwise the
 * default Server glyph. Decorative (adjacent name text carries the label).
 */
export function BrandMark({ logoUrl, label }: { logoUrl?: string; label: string }): React.JSX.Element {
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-raised"
      aria-hidden="true"
      title={label}
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" className={cn("h-6 w-6 object-contain")} draggable={false} />
      ) : (
        <Server className="h-4 w-4 text-logo" />
      )}
    </span>
  );
}
