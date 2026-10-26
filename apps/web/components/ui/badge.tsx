import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-[10px] font-medium whitespace-nowrap focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "border-border bg-muted text-muted-foreground",
        destructive: "border-destructive/20 bg-destructive/10 text-foreground [&_[data-slot=badge-dot]]:bg-destructive",
        outline: "border-border text-foreground",
        info: "border-chart-2/20 bg-chart-2/10 text-foreground [&_[data-slot=badge-dot]]:bg-chart-2",
        success: "border-chart-3/20 bg-chart-3/10 text-foreground [&_[data-slot=badge-dot]]:bg-chart-3",
        warning: "border-chart-4/20 bg-chart-4/10 text-foreground [&_[data-slot=badge-dot]]:bg-chart-4",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">({ className: cn(badgeVariants({ variant }), className) }, props),
    render,
    state: { slot: "badge", variant },
  });
}

export { Badge, badgeVariants };
