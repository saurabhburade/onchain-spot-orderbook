"use client";

import { DiamondMinus } from "lucide-react";
import { MotionConfig, motion, type Transition, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useId } from "react";

import { ChainSwitcher } from "@/components/chain-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { WalletButton } from "@/components/wallet-button";
import { useClobChain } from "@/lib/clob";

type ActiveNavigation = "trade" | "markets" | "deploy" | "faucet";

// A deliberately weighty, no-overshoot spring keeps the shared pill inside
// the navigation row while still making route changes feel continuous.
const navigationTabsTransition: Transition = {
  type: "spring",
  stiffness: 170,
  damping: 30,
  mass: 1.2,
};

function Navigation({ active, mobile = false }: { active: ActiveNavigation; mobile?: boolean }) {
  const { chainId, config } = useClobChain();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const layoutId = useId();
  const navigationItems = [
    {
      id: "trade",
      label: "Trade",
      href: config.defaultPoolId ? `/${chainId}/markets/${config.defaultPoolId}/trade` : `/${chainId}/trade`,
    },
    { id: "markets", label: "Markets", href: `/${chainId}/markets` },
    { id: "deploy", label: "Deploy", href: `/${chainId}/deploy` },
    { id: "faucet", label: "Faucet", href: `/${chainId}/faucet` },
  ] as const;
  const pathnameSegments = pathname.split("/");
  const pathnameActive =
    pathnameSegments[2] === "deploy"
      ? "deploy"
      : pathnameSegments[2] === "faucet"
        ? "faucet"
        : pathnameSegments[2] === "trade" || (pathnameSegments[2] === "markets" && pathnameSegments[4] === "trade")
          ? "trade"
          : pathnameSegments[2] === "markets"
            ? "markets"
            : active;

  return (
    <MotionConfig transition={reduceMotion ? { duration: 0 } : navigationTabsTransition}>
      <motion.nav
        aria-label={mobile ? "Primary mobile" : "Primary"}
        className={mobile ? "flex gap-1" : "hidden items-center gap-1 lg:flex"}
        layoutRoot
      >
        {navigationItems.map((item) => {
          const selected = item.id === pathnameActive;
          return (
            <span className="relative inline-flex" key={item.label}>
              {selected ? (
                <motion.span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-muted"
                  initial={false}
                  layout="position"
                  layoutId={layoutId}
                  style={{ borderRadius: 9999 }}
                />
              ) : null}
              <Link
                aria-current={selected ? "page" : undefined}
                className={`relative z-10 inline-flex h-8 min-w-10 items-center justify-center rounded-full px-4 text-xs font-medium outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 ${selected ? "text-foreground" : "text-muted-foreground"}`}
                href={item.href}
              >
                {item.label}
              </Link>
            </span>
          );
        })}
      </motion.nav>
    </MotionConfig>
  );
}

export function AppHeader({ active, actions }: { active: ActiveNavigation; actions?: ReactNode }) {
  const { chainId } = useClobChain();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/92 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[1540px] items-center gap-3 px-3 sm:px-4 lg:px-5 xl:px-6">
        <Link className="flex shrink-0 items-center gap-2 text-foreground" href={`/${chainId}/markets`}>
          <DiamondMinus aria-hidden="true" className="size-6 rounded-[7px]" strokeWidth={2} />
          <span className="hidden text-sm font-semibold sm:inline">Orderbook</span>
        </Link>
        <Navigation active={active} />
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {actions}
          <ChainSwitcher />
          <WalletButton />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[1540px] gap-1 overflow-x-auto border-t border-border px-3 py-1.5 sm:px-4 lg:hidden">
        <Navigation active={active} mobile />
      </div>
    </header>
  );
}
