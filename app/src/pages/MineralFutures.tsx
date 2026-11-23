import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Loader2, RefreshCw, Shield, Wallet } from "lucide-react";
import { toast, Toaster } from "sonner";
import { parseSolanaError } from "@/components/CopyableErrorToast";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import PriceChart from "@/components/PriceChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSolanaWallet } from "@/hooks/useSolanaWallet";
import { useMineralFutures, type PositionData } from "@/hooks/useMineralFutures";
import {
  COMMODITIES,
  COMMODITY_LABEL,
  COMMODITY_SYMBOL,
  IS_DEVNET,
  LEVERAGE_OPTIONS,
  MARKET_PDAS,
  type CommodityName,
} from "@/constants/mineralFutures";
import { calcPnl, wouldAcceptTrade } from "@/lib/futuresMath";

const LAMPORTS_PER_SOL = 1_000_000_000;
const FEE_RATE = 0.0005;
const GREEN = "hsl(145,80%,50%)";
const RED = "hsl(0,80%,60%)";

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);
const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;

function commodityForMarket(address: string): CommodityName | null {
  const hit = Object.entries(MARKET_PDAS).find(([, pda]) => pda === address);
  return hit ? (hit[0] as CommodityName) : null;
}

function showError(e: unknown) {
  const { userMessage, fullError } = parseSolanaError(e);
  toast.error(userMessage, {
    description: fullError.length > 100 ? fullError.slice(0, 100) + "..." : undefined,
    action: { label: "Copy", onClick: () => navigator.clipboard.writeText(fullError) },
  });
}

export default function MineralFutures() {
  const { connected, publicKey, provider, connect, disconnect, isPhantomInstalled } = useSolanaWallet();
  const { markets, positions, solBalance, loading, refresh, openPosition, closePosition } = useMineralFutures(publicKey);

  const [selected, setSelected] = useState<CommodityName>("ANTIMONY");
  const [direction, setDirection] = useState<0 | 1>(0);
  const [leverage, setLeverage] = useState<number>(1);
  const [amount, setAmount] = useState("");
  const [placing, setPlacing] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);

  const market = markets[selected] ?? null;
  const collateralLamports = Math.round((parseFloat(amount) || 0) * LAMPORTS_PER_SOL);

  // Same rule the program applies. Warn before the user pays a network fee for a rejected trade.
  const check = useMemo(() => {
    if (!market || collateralLamports < 10_000_000) return null;
    const net = collateralLamports - Math.floor(collateralLamports * FEE_RATE);
    return wouldAcceptTrade(market, direction, net, leverage);
  }, [market, collateralLamports, direction, leverage]);

  const place = async () => {
    if (!provider || !publicKey || !market) return toast.error("Connect your wallet first");
    if (collateralLamports < 10_000_000) return toast.error("Minimum order is 0.01 SOL");
    if (collateralLamports / LAMPORTS_PER_SOL > solBalance) return toast.error("Insufficient SOL balance");
    setPlacing(true);
    try {
      const tx = await openPosition(provider, market, direction, collateralLamports, leverage);
      toast.success(`Position opened. ${tx.slice(0, 8)}...`);
      setAmount("");
    } catch (e) {
      showError(e);
    } finally {
      setPlacing(false);
    }
  };

  const close = async (pos: PositionData) => {
    if (!provider) return;
    setClosing(pos.publicKey);
    try {
      const tx = await closePosition(provider, pos);
      toast.success(`Position closed. ${tx.slice(0, 8)}...`);
    } catch (e) {
      showError(e);
    } finally {
      setClosing(null);
    }
  };

  const pnlOf = (pos: PositionData) => {
    const name = commodityForMarket(pos.market);
    const m = name ? markets[name] : null;
    if (!m) return { pnl: 0, pct: 0 };
    const pnl = calcPnl(pos.direction, m.markPrice, pos.entryPrice, pos.collateral, pos.leverage);
    return { pnl, pct: pos.collateral ? pnl / pos.collateral : 0 };
  };

  const stale = market ? Date.now() / 1000 - market.lastPriceUpdate > 86_400 : false;

  return (
    <div className="min-h-screen bg-background">
      <Toaster theme="dark" position="top-center" />
      <Navigation />
      <main className="pt-20 pb-12 px-3 sm:px-6 max-w-[1400px] mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Critical Mineral Futures</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Cash-settled perpetuals on metals with no exchange of their own. Prices in USD per tonne.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={refresh} disabled={loading} aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            {connected ? (
              <Button variant="outline" onClick={disconnect} className="text-xs">
                <Wallet className="w-3 h-3 mr-1" /> {short(publicKey!)}
              </Button>
            ) : (
              <Button onClick={connect}>
                <Wallet className="w-4 h-4 mr-2" />
                {isPhantomInstalled ? "Connect Phantom" : "Install Phantom"}
              </Button>
            )}
          </div>
        </div>

        {IS_DEVNET && (
          <div className="mb-4 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-xs text-foreground">
            <Shield className="inline w-3 h-3 mr-1 text-primary" />
            Devnet demo. Transactions use devnet SOL.
          </div>
        )}

        <Card className="border-border/50 bg-card mb-4">
          <CardContent className="p-4">
            <PriceChart commodity={selected} refreshKey={market?.lastPriceUpdate} />
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Markets */}
          <div className="lg:col-span-3 space-y-3">
            <Card className="border-border/50 bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Markets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 p-3 pt-0">
                {COMMODITIES.map((name) => {
                  const m = markets[name];
                  const active = selected === name;
                  return (
                    <button
                      key={name}
                      onClick={() => setSelected(name)}
                      className={`w-full flex items-center justify-between px-3 py-3 rounded-lg text-left transition-all ${
                        active ? "bg-primary/15 border border-primary/40" : "hover:bg-muted/40 border border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-8 text-center font-mono text-xs font-bold text-primary">{COMMODITY_SYMBOL[name]}</span>
                        <span className={`font-semibold text-sm ${active ? "text-foreground" : "text-muted-foreground"}`}>
                          {COMMODITY_LABEL[name]}
                        </span>
                      </div>
                      <span className="font-mono text-sm">{m ? usd(m.markPrice) : "—"}</span>
                    </button>
                  );
                })}
              </CardContent>
            </Card>

            {market && (
              <Card className="border-border/50 bg-card">
                <CardContent className="p-4 space-y-3 text-sm">
                  <Row label="Oracle price" value={`${usd(market.markPrice)} / t`} bold />
                  <Row
                    label="Last update"
                    value={new Date(market.lastPriceUpdate * 1000).toLocaleString()}
                    valueClass={stale ? "text-destructive" : "text-muted-foreground"}
                  />
                  {stale && <p className="text-xs text-destructive">Price is over 24 hours old. New trades are blocked.</p>}
                  <Row label="Open interest long" value={`${sol(market.oiLong)} SOL`} valueStyle={{ color: GREEN }} />
                  <Row label="Open interest short" value={`${sol(market.oiShort)} SOL`} valueStyle={{ color: RED }} />
                  <Row label="Free reserve" value={`${sol(market.freeReserve)} SOL`} />
                  <Row label="Reserve in use" value={`${sol(market.requiredReserve)} SOL`} />
                </CardContent>
              </Card>
            )}
          </div>

          {/* Order */}
          <div className="lg:col-span-4">
            <Card className="border-border/50 bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">{COMMODITY_LABEL[selected]} perpetual</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!market && (
                  <p className="text-sm text-muted-foreground">This market is not live yet.</p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <DirButton active={direction === 0} long onClick={() => setDirection(0)} />
                  <DirButton active={direction === 1} onClick={() => setDirection(1)} />
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Leverage</label>
                  <div className="flex gap-2">
                    {LEVERAGE_OPTIONS.map((l) => (
                      <button
                        key={l}
                        onClick={() => setLeverage(l)}
                        className={`flex-1 py-2 rounded-lg text-sm font-mono border transition-all ${
                          leverage === l ? "bg-primary/20 border-primary/50 text-foreground" : "border-border/50 text-muted-foreground hover:bg-muted/40"
                        }`}
                      >
                        {l}x
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Collateral (SOL)</label>
                  <Input
                    type="number"
                    placeholder="0.00"
                    step="0.01"
                    min="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="font-mono text-lg"
                  />
                  {connected && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Balance: {solBalance.toFixed(4)} SOL</span>
                      <button onClick={() => setAmount(Math.max(0, solBalance - 0.01).toFixed(4))} className="text-xs text-primary hover:underline">
                        MAX
                      </button>
                    </div>
                  )}
                </div>

                {market && collateralLamports >= 10_000_000 && (
                  <div className="bg-muted/30 rounded-lg p-3 text-sm space-y-1">
                    <Row label="Entry price" value={`${usd(market.markPrice)} / t`} />
                    <Row label="Position size" value={`${(amount ? parseFloat(amount) * leverage : 0).toFixed(3)} SOL`} />
                    <Row label="Fee (0.05%)" value={`${(parseFloat(amount) * FEE_RATE).toFixed(5)} SOL`} />
                    <Row label="Profit is capped at a 30% price move" value="" />
                  </div>
                )}

                {check && !check.ok && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-foreground">
                    The market cannot back this trade right now. It would need {sol(check.needAfter)} SOL of reserve and has{" "}
                    {sol(check.reserve)} SOL free. Take the other side, trade smaller, or use less leverage.
                  </div>
                )}

                {connected ? (
                  <Button
                    onClick={place}
                    disabled={placing || !amount || !market || (check ? !check.ok : false)}
                    className="w-full h-12 font-bold text-base text-white"
                    style={{ background: direction === 0 ? "hsl(145,80%,40%)" : "hsl(0,80%,50%)" }}
                  >
                    {placing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    {placing ? "Placing order..." : `${direction === 0 ? "Long" : "Short"} ${COMMODITY_LABEL[selected]}`}
                  </Button>
                ) : (
                  <Button onClick={connect} className="w-full h-12">
                    <Wallet className="w-4 h-4 mr-2" /> Connect Phantom to trade
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Positions */}
          <div className="lg:col-span-5">
            <Card className="border-border/50 bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  My positions {positions.length > 0 && `(${positions.length})`}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-0">
                {!connected ? (
                  <Empty text="Connect a wallet to see positions" />
                ) : positions.length === 0 ? (
                  <Empty text="No open positions" />
                ) : (
                  <div className="space-y-2">
                    {positions.map((pos) => {
                      const name = commodityForMarket(pos.market);
                      const { pnl, pct } = pnlOf(pos);
                      const profit = pnl >= 0;
                      return (
                        <div key={pos.publicKey} className="rounded-lg border border-border/40 p-3 space-y-2 bg-muted/20">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm">{name ? COMMODITY_LABEL[name] : "Unknown"}</span>
                              <Badge variant="outline" className="text-xs" style={{ color: pos.direction === 0 ? GREEN : RED }}>
                                {pos.direction === 0 ? "LONG" : "SHORT"} {pos.leverage}x
                              </Badge>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => close(pos)}
                              disabled={closing === pos.publicKey}
                              className="text-xs h-7 border-destructive/50 text-destructive hover:bg-destructive/10"
                            >
                              {closing === pos.publicKey ? <Loader2 className="w-3 h-3 animate-spin" /> : "Close"}
                            </Button>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-xs">
                            <Cell label="Collateral" value={`${sol(pos.collateral)} SOL`} />
                            <Cell label="Entry" value={usd(pos.entryPrice)} />
                            <div>
                              <span className="text-muted-foreground block">Est. PnL</span>
                              <span className="font-mono font-bold" style={{ color: profit ? GREEN : RED }}>
                                {profit ? "+" : ""}
                                {sol(pnl)} SOL
                                <span className="text-[10px] ml-1">({(pct * 100).toFixed(1)}%)</span>
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-[11px] text-muted-foreground pt-1">
                      Estimate before funding and the 0.05% close fee. Final amount is set by the program when you close.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function Row({ label, value, bold, valueClass, valueStyle }: { label: string; value: string; bold?: boolean; valueClass?: string; valueStyle?: React.CSSProperties }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm ${bold ? "font-bold" : ""} ${valueClass ?? ""}`} style={valueStyle}>
        {value}
      </span>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted-foreground block">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-center py-12 text-muted-foreground text-sm">{text}</div>;
}

function DirButton({ active, long, onClick }: { active: boolean; long?: boolean; onClick: () => void }) {
  const c = long ? "145,80%" : "0,80%";
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all border"
      style={
        active
          ? { background: `hsl(${c},${long ? 40 : 50}%)`, color: "white", borderColor: "transparent" }
          : { background: `hsl(${c},${long ? 40 : 50}%,0.1)`, color: `hsl(${c},${long ? 50 : 60}%)`, borderColor: `hsl(${c},${long ? 40 : 50}%,0.3)` }
      }
    >
      {long ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
      {long ? "LONG" : "SHORT"}
    </button>
  );
}
