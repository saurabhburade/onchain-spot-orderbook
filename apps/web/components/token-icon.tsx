"use client";

import { BadgeQuestionMark } from "lucide-react";
import Image from "next/image";

export function TokenIcon({
  alt = "",
  className = "",
  fallbackClassName = "size-1/2",
  sizes,
  url,
}: {
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  sizes: string;
  url?: string;
}) {
  return (
    <span
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full text-muted-foreground outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 ${className}`}
    >
      <BadgeQuestionMark aria-hidden="true" className={fallbackClassName} strokeWidth={1.5} />
      {url ? (
        <Image
          alt={alt}
          className="object-cover"
          fill
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          sizes={sizes}
          src={url}
        />
      ) : null}
    </span>
  );
}
