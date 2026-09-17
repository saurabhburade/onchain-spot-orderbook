import type { ReactNode } from "react";

type SectionHeadingProps = {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
};

export function SectionHeading({ eyebrow, title, action }: SectionHeadingProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</p>
        ) : null}
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
      </div>
      {action}
    </div>
  );
}
