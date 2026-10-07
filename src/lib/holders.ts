import "server-only";
import { nearView } from "@/lib/near";
import { classifyHolder, isAccountId, isInfrastructure, type Holder, type HolderMap } from "@/lib/holder-model";

export type { Holder, HolderKind, HolderMap } from "@/lib/holder-model";
export { isInfrastructure } from "@/lib/holder-model";

type RawHolder = { account_id?: string; account?: string; balance?: string };

async function fetchHolders(token: string, provider: "FastNEAR" | "Nearly"): Promise<RawHolder[] | null> {
  try {
    const url = provider === "FastNEAR"
      ? `https://api.fastnear.com/v1/ft/${encodeURIComponent(token)}/top`
      : `https://nearly.trade/api/holders/${encodeURIComponent(token)}`;
    const headers: Record<string, string> = {};
    if (provider === "FastNEAR" && process.env.FASTNEAR_API_KEY) headers.Authorization = `Bearer ${process.env.FASTNEAR_API_KEY}`;
    const response = await fetch(url, { headers, next: { revalidate: 60 }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return null;
    const data = await response.json();
    const rows = provider === "FastNEAR" ? data?.accounts : data;
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/** Indexed balances + a final contract supply read. No invented holders or balances. */
export async function getHolderMap(token: string): Promise<HolderMap | null> {
  const [fast, supply, metadata] = await Promise.all([
    fetchHolders(token, "FastNEAR"),
    nearView<string>(token, "ft_total_supply").catch(() => null),
    nearView<{ decimals: number }>(token, "ft_metadata").catch(() => null),
  ]);
  let raw = fast;
  let source: "FastNEAR" | "Nearly" = "FastNEAR";
  if (!raw?.length) { raw = await fetchHolders(token, "Nearly"); source = "Nearly"; }
  if (!raw?.length || !supply || !/^\d+$/.test(supply) || !metadata) return null;
  const total = BigInt(supply);
  const decimals = Number(metadata.decimals);
  if (total <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;

  const distinct = new Map<string, string>();
  for (const entry of raw) {
    const account = String(entry.account_id || entry.account || "");
    const balance = String(entry.balance || "0");
    if (isAccountId(account) && /^\d+$/.test(balance) && BigInt(balance) > 0n) distinct.set(account, balance);
  }
  const holders: Holder[] = [...distinct].map(([account, balance]) => ({ account, balance }))
    .sort((a, b) => BigInt(a.balance) === BigInt(b.balance) ? a.account.localeCompare(b.account) : BigInt(a.balance) > BigInt(b.balance) ? -1 : 1)
    .slice(0, 100)
    .map((entry, index) => ({
      ...entry, ...classifyHolder(entry.account),
      percent: Number(BigInt(entry.balance) * 1_000_000n / total) / 10_000,
      rank: index + 1,
    }));
  if (!holders.length) return null;
  const real = holders.filter((holder) => !isInfrastructure(holder.kind));
  const sum = (list: Holder[]) => list.reduce((value, holder) => value + holder.percent, 0);
  return {
    token, totalSupply: supply, decimals, holders,
    circulating: { top10: sum(real.slice(0, 10)), top25: sum(real.slice(0, 25)), realHolders: real.length },
    infrastructure: sum(holders.filter((holder) => isInfrastructure(holder.kind))),
    source, fetchedAt: Date.now(),
  };
}
