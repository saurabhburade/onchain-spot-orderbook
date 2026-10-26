import { Badge } from "@/components/ui/badge";
import type { PortfolioOrder } from "@/lib/portfolio/activity";

const statuses = {
  OPEN: { label: "Open", variant: "info" },
  PARTIALLY_FILLED: { label: "Partially filled", variant: "warning" },
  FILLED: { label: "Filled", variant: "success" },
  CANCELLED: { label: "Cancelled", variant: "secondary" },
  QUARANTINED: { label: "Quarantined", variant: "destructive" },
} as const;

export function OrderStatusBadge({ status }: { status: PortfolioOrder["status"] }) {
  const { label, variant } = statuses[status];
  return (
    <Badge variant={variant}>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" data-slot="badge-dot" />
      {label}
    </Badge>
  );
}
