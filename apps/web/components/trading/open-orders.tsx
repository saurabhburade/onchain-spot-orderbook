"use client";

import { LoaderCircle, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import type { OpenOrder } from "./market-data";
import { SectionHeading } from "./section-heading";

export function OpenOrders({
  orders,
  loading,
  error,
  onCancel,
}: {
  orders: OpenOrder[];
  loading?: boolean;
  error?: string | null;
  onCancel?: (orderId: `0x${string}`) => Promise<void>;
}) {
  const [cancellingId, setCancellingId] = useState<`0x${string}` | null>(null);

  async function cancel(orderId: `0x${string}`) {
    if (!onCancel) return;
    setCancellingId(orderId);
    try {
      await onCancel(orderId);
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <Card className="ring-1 ring-border/60">
      <CardHeader className="border-b border-border/50 pb-4">
        <SectionHeading title="Open orders" />
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-2 sm:px-5">
        {error ? <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
        {loading ? (
          <p className="px-2 py-5 text-center text-xs text-muted-foreground">Loading your open orders…</p>
        ) : null}
        {!loading && !error && orders.length === 0 ? (
          <p className="px-2 py-5 text-center text-xs text-muted-foreground">No open orders for this market.</p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow className="border-0 hover:bg-transparent">
              <TableHead className="h-9 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Market
              </TableHead>
              <TableHead className="h-9 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Side / type
              </TableHead>
              <TableHead className="h-9 px-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                Price
              </TableHead>
              <TableHead className="h-9 px-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                Amount
              </TableHead>
              <TableHead className="h-9 px-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                Filled
              </TableHead>
              <TableHead className="h-9 px-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                {" "}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow
                className="border-border/35 hover:bg-muted/35"
                key={`${order.market}-${order.side}-${order.price}`}
              >
                <TableCell className="px-2 py-3 text-xs font-medium text-foreground">{order.market}</TableCell>
                <TableCell className="px-2 py-3">
                  <span className={cn("font-medium", order.side === "buy" ? "text-chart-3" : "text-destructive")}>
                    {order.side === "buy" ? "Buy" : "Sell"}
                  </span>
                  <span className="ml-1.5 text-xs text-muted-foreground">· {order.type}</span>
                </TableCell>
                <TableCell className="px-2 py-3 text-right font-mono text-xs tabular-nums text-foreground">
                  {order.price}
                </TableCell>
                <TableCell className="px-2 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {order.amount}
                </TableCell>
                <TableCell className="px-2 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {order.filled}
                </TableCell>
                <TableCell className="px-2 py-3 text-right">
                  <Button
                    aria-label={`Cancel ${order.side} order at ${order.price}`}
                    className="size-7 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    disabled={cancellingId === order.orderId}
                    size="icon"
                    onClick={() => {
                      void cancel(order.orderId);
                    }}
                    variant="ghost"
                  >
                    {cancellingId === order.orderId ? (
                      <LoaderCircle aria-hidden="true" className="animate-spin" />
                    ) : (
                      <X aria-hidden="true" />
                    )}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
