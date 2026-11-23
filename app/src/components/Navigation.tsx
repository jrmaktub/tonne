import { Link } from "react-router-dom";
import { Gem } from "lucide-react";
import { BRAND } from "@/brand";

const Navigation = () => (
  <nav className="fixed top-0 left-0 right-0 z-50 bg-background/70 backdrop-blur-xl border-b border-border/50">
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
      <Link to="/" className="flex items-center gap-2.5 group">
        <div className="relative">
          <Gem className="w-5 h-5 text-primary group-hover:scale-110 transition-transform" />
          <div className="absolute inset-0 blur-md bg-primary/30 group-hover:bg-primary/50 transition-all" />
        </div>
        <span className="text-xl font-bold tracking-tight text-foreground">{BRAND}</span>
      </Link>
      <span className="text-xs text-muted-foreground hidden sm:block">Solana</span>
    </div>
  </nav>
);

export default Navigation;
