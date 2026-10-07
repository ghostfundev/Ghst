import "server-only";
import type { LaunchCost, Market, NetworkStats } from "@/lib/types";

export const FACTORY = "nearlytrade.near";
export const DCL = "dclv2.ref-labs.near";
export const WNEAR = "wrap.near";
const RPC = "https://rpc.mainnet.fastnear.com";
const SOURCE = "https://nearly.trade";

export function isValidToken(token: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,90}\.nearlytrade\.near$/.test(token);
}

type RawMarket = Record<string, unknown> & { links?: Record<string, unknown> };

function normaliseMarket(raw: RawMarket): Market | null {
  if (typeof raw.token !== "string" || !isValidToken(raw.token)) return null;
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const links = raw.links || {};
  return {
    id: number(raw.id),
    token: raw.token,
    creator: text(raw.creator),
    name: text(raw.name) || text(raw.symbol),
    symbol: text(raw.symbol),
    icon: typeof raw.icon === "string" && raw.icon.startsWith("https://") ? raw.icon : null,
    description: text(raw.description),
    poolId: text(raw.pool_id),
    quote: text(raw.quote),
    priceUsd: number(raw.price_usd),
    priceNear: number(raw.price_near),
    marketCapUsd: number(raw.fdv_usd),
    volume24hUsd: number(raw.volume_24h_near) * number(raw.near_usd),
    volume24hNear: number(raw.volume_24h_near),
    change24h: number(raw.change_24h),
    holders: number(raw.holders),
    trades24h: number(raw.trades_24h),
    createdAt: number(raw.created_at_ms),
    feeMode: text(raw.fee_mode) || "creator",
    creatorShareBps: number(raw.share_bps),
    nearUsd: number(raw.near_usd),
    links: {
      website: typeof links.website === "string" ? links.website : null,
      twitter: typeof links.twitter === "string" ? links.twitter : null,
      telegram: typeof links.telegram === "string" ? links.telegram : null,
    },
  };
}

export async function getMarkets(sort: "volume" | "trending" | "new" = "volume", limit = 30): Promise<Market[]> {
  try {
    const url = new URL("/api/launches", SOURCE);
    url.searchParams.set("sort", sort);
    url.searchParams.set("limit", String(Math.max(10, Math.min(100, limit))));
    const response = await fetch(url, { next: { revalidate: 25 }, signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error("Market feed unavailable");
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error("Invalid market feed");
    return data.map((item) => normaliseMarket(item as RawMarket)).filter((item): item is Market => Boolean(item && item.quote === WNEAR && item.poolId && item.symbol));
  } catch (error) {
    console.error("Market feed:", error);
    return [];
  }
}

export async function getMarket(token: string): Promise<Market | null> {
  if (!isValidToken(token)) return null;
  try {
    const response = await fetch(`${SOURCE}/api/launch/${encodeURIComponent(token)}`, { next: { revalidate: 12 }, signal: AbortSignal.timeout(9000) });
    if (!response.ok) return null;
    const data = (await response.json()) as RawMarket;
    const market = normaliseMarket(data);
    return market?.quote === WNEAR ? market : null;
  } catch (error) {
    console.error("Market detail:", error);
    return null;
  }
}

export async function getStats(): Promise<NetworkStats | null> {
  try {
    const response = await fetch(`${SOURCE}/api/stats`, { next: { revalidate: 30 }, signal: AbortSignal.timeout(9000) });
    if (!response.ok) return null;
    const data = await response.json();
    const nearUsd = Number(data.near_usd) || 0;
    return { launches: Number(data.launches) || 0, trades: Number(data.trades) || 0, volumeUsd: (Number(data.volume_near) || 0) * nearUsd, nearUsd };
  } catch {
    return null;
  }
}

type RpcResponse = { error?: { message?: string; data?: string }; result?: { result?: number[] } };

export async function nearView<T>(accountId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nearcore", method: "query", params: {
      request_type: "call_function", finality: "final", account_id: accountId,
      method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    } }),
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("NEAR RPC is unavailable right now.");
  const payload = (await response.json()) as RpcResponse;
  if (payload.error) throw new Error(payload.error.message || "NEAR RPC failed to process the request.");
  if (!payload.result?.result) throw new Error("Invalid NEAR RPC response.");
  return JSON.parse(Buffer.from(payload.result.result).toString("utf8")) as T;
}

export async function getLaunchCost(iconBytes: number, devBuyYocto: string | null, taxed: boolean): Promise<LaunchCost> {
  return nearView<LaunchCost>(FACTORY, "quote_launch", { icon_bytes: iconBytes, dev_buy: devBuyYocto, tax: taxed });
}

export async function getTax(launchId: number): Promise<{ buy_bps: number; sell_bps: number } | null> {
  return nearView<{ buy_bps: number; sell_bps: number } | null>(FACTORY, "get_tax", { launch_id: String(launchId) });
}

export async function getTokenDecimals(token: string): Promise<number> {
  const metadata = await nearView<{ decimals: number }>(token, "ft_metadata");
  const decimals = Number(metadata.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) throw new Error("Invalid token decimals.");
  return decimals;
}

/** Rhea DCL fee tiers, cheapest first. A token may have a pool in any of them. */
export const FEE_TIERS = [100, 400, 2000, 10000] as const;

export function poolIdFor(tokenA: string, tokenB: string, fee: number): string {
  const [x, y] = [tokenA, tokenB].sort();
  return `${x}|${y}|${fee}`;
}

type DclPool = { pool_id: string; fee: number; state: string; liquidity: string };

/** Returns every running pool with liquidity for token/quote, across all fee tiers. */
export async function discoverPools(token: string, quote: string): Promise<{ poolId: string; fee: number }[]> {
  const ids = FEE_TIERS.map((fee) => poolIdFor(token, quote, fee));
  try {
    const pools = await nearView<(DclPool | null)[]>(DCL, "get_pools", { pool_ids: ids });
    return (pools || [])
      .filter((pool): pool is DclPool => Boolean(pool && pool.state === "Running" && pool.liquidity !== "0"))
      .map((pool) => ({ poolId: pool.pool_id, fee: pool.fee }));
  } catch {
    return [];
  }
}

/**
 * Quotes every available pool and returns the one paying out the most.
 * This is what keeps the user from overpaying on a 1% pool when a cheaper
 * tier holds enough liquidity to fill the same trade.
 */
export async function bestQuote(
  pools: { poolId: string; fee: number }[],
  inputToken: string,
  outputToken: string,
  inputAmount: string,
): Promise<{ poolId: string; fee: number; amount: bigint } | null> {
  const results = await Promise.all(
    pools.map(async (pool) => {
      try {
        const quote = await nearView<{ amount: string }>(DCL, "quote", {
          pool_ids: [pool.poolId], input_token: inputToken, output_token: outputToken,
          input_amount: inputAmount, tag: "Auto",
        });
        const amount = BigInt(quote?.amount || "0");
        return amount > 0n ? { ...pool, amount } : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is { poolId: string; fee: number; amount: bigint } => r !== null)
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))[0] || null;
}

export async function getNearAvailable(accountId: string): Promise<string> {
  const response = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ jsonrpc: "2.0", id: "balance", method: "query", params: {
      request_type: "view_account", finality: "final", account_id: accountId,
    } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("Could not read the NEAR balance.");
  const payload = await response.json() as { result?: { amount: string; storage_usage: number }; error?: { message: string } };
  if (!payload.result) throw new Error(payload.error?.message || "NEAR account not found.");
  const available = BigInt(payload.result.amount) - BigInt(payload.result.storage_usage) * 10n ** 19n;
  return (available > 0n ? available : 0n).toString();
}
