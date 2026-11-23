import { Copy, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface CopyableErrorProps {
  message: string;
}

export const CopyableError = ({ message }: CopyableErrorProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm break-words max-w-[300px]">{message}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className="w-fit h-7 text-xs bg-background/20 border-border/50 hover:bg-background/40"
      >
        {copied ? (
          <>
            <Check className="w-3 h-3 mr-1" />
            Copied!
          </>
        ) : (
          <>
            <Copy className="w-3 h-3 mr-1" />
            Copy Error
          </>
        )}
      </Button>
    </div>
  );
};

// Parse Solana/Anchor errors into user-friendly messages
// Anchor custom errors start at 6000 (0x1770). Order matches FuturesError in the program.
const PROGRAM_ERRORS: Record<number, string> = {
  6003: "You are not allowed to do that.",
  6004: "This position is already closed.",
  6005: "This position is not at risk of liquidation.",
  6007: "Minimum collateral is 0.01 SOL.",
  6008: "Leverage must be between 1x and 10x.",
  6009: "This market is paused.",
  6012: "The price is stale. Wait for the next oracle update.",
  6014: "That price update was too large and was rejected.",
  6015: "The market reserve is too low for this trade. Take the other side, trade smaller, or use lower leverage.",
};

export function parseSolanaError(error: unknown): { userMessage: string; fullError: string } {
  const fullError = error instanceof Error ? error.message : String(error);

  const hex = fullError.match(/custom program error: 0x([0-9a-fA-F]+)/);
  const dec = fullError.match(/Error Number: (\d+)/);
  const code = hex ? parseInt(hex[1], 16) : dec ? parseInt(dec[1], 10) : null;
  if (code !== null && PROGRAM_ERRORS[code]) {
    return { userMessage: PROGRAM_ERRORS[code], fullError };
  }

  if (/insufficient (funds|lamports)/i.test(fullError)) {
    return { userMessage: "Not enough SOL in your wallet for this order plus network fees.", fullError };
  }
  if (fullError.includes("User rejected")) {
    return { userMessage: "Transaction was rejected in your wallet.", fullError };
  }
  if (fullError.includes("Blockhash not found")) {
    return { userMessage: "Transaction expired. Please try again.", fullError };
  }

  return {
    userMessage: fullError.length > 100 ? fullError.slice(0, 100) + "..." : fullError,
    fullError,
  };
}
