import { BRAND, TAGLINE } from "@/brand";

const Footer = () => (
  <footer className="border-t border-border/30 py-10 px-6 mt-24 bg-background/50">
    <div className="max-w-3xl mx-auto text-center space-y-3">
      <div className="text-lg font-bold text-foreground">{BRAND}</div>
      <p className="text-sm text-muted-foreground">{TAGLINE}</p>
      <p className="text-xs text-muted-foreground">
        Prices come from published market assessments and are for information only. Not investment advice.
      </p>
    </div>
  </footer>
);

export default Footer;
