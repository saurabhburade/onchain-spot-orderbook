"use client";

import { Menu } from "@base-ui/react/menu";
import { DiamondMinus, Menu as MenuIcon } from "lucide-react";
import { MotionConfig, motion, type Transition, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useId } from "react";

import { ChainSwitcher } from "@/components/chain-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { floatingMenuItemClassName, floatingMenuPopupClassName } from "@/components/ui/floating-menu-styles";
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

function navigationItems(chainId: number, defaultPoolId?: `0x${string}`) {
  return [
    {
      id: "trade" as const,
      label: "Trade",
      href: defaultPoolId ? `/${chainId}/markets/${defaultPoolId}/trade` : `/${chainId}/trade`,
    },
    { id: "markets" as const, label: "Markets", href: `/${chainId}/markets` },
    { id: "faucet" as const, label: "Faucet", href: `/${chainId}/faucet` },
  ];
}

function selectedNavigation(pathname: string, active: ActiveNavigation) {
  const pathnameSegments = pathname.split("/");
  return pathnameSegments[2] === "deploy"
    ? "deploy"
    : pathnameSegments[2] === "faucet"
      ? "faucet"
      : pathnameSegments[2] === "trade" || (pathnameSegments[2] === "markets" && pathnameSegments[4] === "trade")
        ? "trade"
        : pathnameSegments[2] === "markets"
          ? "markets"
          : active;
}

function Navigation({ active }: { active: ActiveNavigation }) {
  const { chainId, config } = useClobChain();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const layoutId = useId();
  const items = navigationItems(chainId, config.defaultPoolId);
  const pathnameActive = selectedNavigation(pathname, active);

  return (
    <MotionConfig transition={reduceMotion ? { duration: 0 } : navigationTabsTransition}>
      <motion.nav aria-label="Primary" className="hidden items-center gap-1 lg:flex" layoutRoot>
        {items.map((item) => {
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

function MobileNavigation({ active }: { active: ActiveNavigation }) {
  const { chainId, config } = useClobChain();
  const pathname = usePathname();
  const items = navigationItems(chainId, config.defaultPoolId);
  const pathnameActive = selectedNavigation(pathname, active);

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Open navigation menu"
        className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground outline-none transition-[color,background-color,transform] hover:bg-secondary/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96] active:bg-secondary data-popup-open:bg-secondary/70 data-popup-open:text-foreground lg:hidden"
      >
        <MenuIcon aria-hidden="true" className="size-4" strokeWidth={2} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" className="z-50 outline-none" sideOffset={8}>
          <Menu.Popup className={`w-40 ${floatingMenuPopupClassName}`}>
            {items.map((item) => {
              const selected = item.id === pathnameActive;
              return (
                <Menu.Item
                  aria-current={selected ? "page" : undefined}
                  className={`${floatingMenuItemClassName} ${selected ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                  key={item.id}
                  render={<Link href={item.href} />}
                >
                  {item.label}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function AppHeader({ active, actions }: { active: ActiveNavigation; actions?: ReactNode }) {
  const { chainId } = useClobChain();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/92 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[1540px] items-center gap-3 px-3 sm:px-4 lg:px-5 xl:px-6">
        <Link className="flex shrink-0 items-center gap-2 text-foreground" href={`/${chainId}/markets`}>
          <DiamondMinus aria-hidden="true" className="size-6 rounded-[7px]" strokeWidth={2} />
        </Link>
        <Navigation active={active} />
        <MobileNavigation active={active} />
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <ChainSwitcher />
          <WalletButton />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
