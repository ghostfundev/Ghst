import "server-only";

/**
 * NEAR Intents (1Click) integration — the private-exit rail.
 *
 * We deliberately do NOT roll our own cryptography. Privacy here comes from
 * Zcash's audited zk-SNARK shielded pool, reached through NEAR's solver
 * network. This app only routes the swap.
 *
 * Public quotes work without credentials. Confidential Intents (NEAR's TEE
 * private shard) is invite-only: set ONECLICK_JWT once you have partner
 * access and CONFIDENTIAL_MODE flips on automatically.
 */

const BASE = "https://1click.chaindefuser.com";
const JWT = process.env.ONECLICK_JWT?.trim() || "";

export const confidentialAvailable = (): boolean => JWT.length > 0;

/** Zcash destination. u1 = unified (shielded-capable), zs = Sapling, t1/t3 = transparent. */
export type ZcashAddressKind = "unified" | "sapling" | "transparent" | "invalid";

export function classifyZcashAddress(address: string): ZcashAddressKind {
  const value = address.trim();
  if (/^u1[a-z0-9]{80,}$/i.test(value)) return "unified";
  if (/^zs1[a-z0-9]{60,}$/i.test(value)) return "sapling";
  if (/^t[13][a-zA-Z0-9]{30,40}$/.test(value)) return "transparent";
  return "invalid";
}

export const ZEC_ASSET = "nep141:zec.omft.near";
export const WNEAR_ASSET = "nep141:wrap.near";

export type ExitQuote = {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  timeEstimate: number;
  withdrawFee: string;
  depositAddress?: string;
  deadline?: string;
};

type QuoteArgs = {
  amountYocto: string;
  recipient: string;
  refundTo: string;
  slippageBps: number;
  dry: boolean;
  confidential: boolean;
};

export async function quoteExit(args: QuoteArgs): Promise<ExitQuote> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (JWT) headers.Authorization = `Bearer ${JWT}`;

  const body: Record<string, unknown> = {
    dry: args.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: args.slippageBps,
    originAsset: WNEAR_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ZEC_ASSET,
    amount: args.amountYocto,
    recipient: args.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: args.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  // Only send the flag when we actually hold partner credentials; the public
  // endpoint returns 401 for confidential quotes.
  if (args.confidential && JWT) body.confidentiality = "basic";

  const response = await fetch(`${BASE}/v0/quote`, {
    method: "POST", headers, body: JSON.stringify(body),
    cache: "no-store", signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  let data: Record<string, unknown> | null = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }

  if (!response.ok) {
    const message = (data?.message as string) || `NEAR Intents menolak permintaan (${response.status}).`;
    throw new Error(response.status === 401 ? "Confidential mode requires NEAR Intents partner access." : message);
  }

  const quote = (data?.quote ?? {}) as Record<string, string>;
  if (!quote.amountOut) throw new Error("No route for this amount. Try a larger size.");

  return {
    amountIn: quote.amountIn, amountInFormatted: quote.amountInFormatted, amountInUsd: quote.amountInUsd,
    amountOut: quote.amountOut, amountOutFormatted: quote.amountOutFormatted, amountOutUsd: quote.amountOutUsd,
    minAmountOut: quote.minAmountOut, timeEstimate: Number(quote.timeEstimate) || 0,
    withdrawFee: quote.withdrawFee || "0",
    depositAddress: (data?.quote as Record<string, string>)?.depositAddress || (data?.depositAddress as string) || undefined,
    deadline: (data?.quoteRequest as Record<string, string>)?.deadline,
  };
}

export async function exitStatus(depositAddress: string): Promise<{ status: string; detail?: string }> {
  const headers: Record<string, string> = {};
  if (JWT) headers.Authorization = `Bearer ${JWT}`;
  const response = await fetch(`${BASE}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
    headers, cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Status unavailable.");
  const data = await response.json();
  return { status: String(data?.status || "UNKNOWN"), detail: data?.swapDetails ? JSON.stringify(data.swapDetails).slice(0, 200) : undefined };
}
