"use client";

import { Check, CircleDollarSign, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";

import { usePrivyConfigured } from "@/components/providers";
import { Card, CardContent } from "@/components/ui/card";

export function GasStatus() {
  const isConfigured = usePrivyConfigured();

  return (
    <Card className="ring-1 ring-chart-3/25 bg-chart-3/[0.06]">
      <CardContent className="flex items-start gap-3 p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-chart-3/12 text-chart-3">
          <CircleDollarSign aria-hidden="true" className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold text-foreground">
              {isConfigured ? "Wallet provider configured" : "Wallet setup needed"}
            </p>
            <span className="inline-flex items-center gap-1 rounded-full bg-chart-3/12 px-1.5 py-0.5 text-[10px] font-medium text-chart-3">
              <motion.span
                animate={{ opacity: [0.5, 1, 0.5] }}
                aria-hidden="true"
                className="size-1.5 rounded-full bg-chart-3"
                transition={{ duration: 2.4, ease: "easeInOut", repeat: Infinity }}
              />
              <Check aria-hidden="true" className="size-3" /> Privy
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {isConfigured
              ? "Your Privy wallet signs and Privy sponsors Monad orders from the same address. You do not need MON for gas."
              : "Add your Privy app IDs to enable wallet connection for on-chain trading."}
          </p>
        </div>
        <ShieldCheck aria-label="Wallet connection status" className="mt-0.5 size-4 shrink-0 text-chart-3" />
      </CardContent>
    </Card>
  );
}
