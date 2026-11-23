import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usePriceHistory } from "@/hooks/usePriceHistory";
import { COMMODITY_LABEL, type CommodityName } from "@/constants/mineralFutures";

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString()}`;
const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export default function PriceChart({ commodity, refreshKey }: { commodity: CommodityName; refreshKey?: unknown }) {
  const { points, loading } = usePriceHistory(commodity, refreshKey);

  if (loading) {
    return <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading price history…</div>;
  }
  if (points.length < 2) {
    return (
      <div className="h-64 flex flex-col items-center justify-center gap-1 text-center px-6">
        <p className="text-sm text-foreground">Not enough recorded prices yet for {COMMODITY_LABEL[commodity]}.</p>
        <p className="text-xs text-muted-foreground">
          Every oracle update is stored on-chain. The chart appears once there are two or more.
        </p>
      </div>
    );
  }

  // If everything happened within two days, label the axis with times instead of repeating one date.
  const shortSpan = points[points.length - 1].ts - points[0].ts < 2 * 86_400;
  const tick = shortSpan ? fmtTime : fmtDate;
  const first = points[0].price;
  const last = points[points.length - 1].price;
  const change = ((last - first) / first) * 100;
  const up = change >= 0;
  const color = up ? "hsl(145,80%,50%)" : "hsl(0,80%,60%)";
  const prices = points.map((p) => p.price);
  const pad = (Math.max(...prices) - Math.min(...prices)) * 0.1 || last * 0.02;

  return (
    <div>
      <div className="flex items-end justify-between mb-2">
        <div>
          <div className="text-2xl font-bold font-mono">
            {fmtUsd(last)}
            <span className="text-xs text-muted-foreground"> / tonne</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {points.length} recorded updates since {fmtDate(points[0].ts)}
          </div>
        </div>
        <div className={`text-sm font-mono ${up ? "text-[hsl(145,80%,50%)]" : "text-[hsl(0,80%,60%)]"}`}>
          {up ? "+" : ""}
          {change.toFixed(2)}%
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="ts"
              tickFormatter={tick}
              tick={{ fontSize: 11, fill: "hsl(0,0%,60%)" }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={[Math.min(...prices) - pad, Math.max(...prices) + pad]}
              tickFormatter={fmtUsd}
              tick={{ fontSize: 11, fill: "hsl(0,0%,60%)" }}
              axisLine={false}
              tickLine={false}
              width={72}
            />
            <Tooltip
              contentStyle={{ background: "hsl(0,0%,8%)", border: "1px solid hsl(0,0%,20%)", borderRadius: 8, fontSize: 12 }}
              labelFormatter={(ts: number) => new Date(ts * 1000).toLocaleString()}
              formatter={(v: number) => [fmtUsd(v), "Price per tonne"]}
            />
            <Area type="stepAfter" dataKey="price" stroke={color} strokeWidth={2} fill="url(#fill)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
