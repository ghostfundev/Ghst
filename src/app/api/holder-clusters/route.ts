import { CLUSTER_POLICY, isAccountId } from "@/lib/holder-model";
import { getHolderMap } from "@/lib/holders";
import { scanHolderBatch } from "@/lib/holder-history";
import { isValidToken } from "@/lib/near";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 4096) return Response.json({ error: "Scan request is too large." }, { status: 413 });
  try {
    const body = await request.json();
    if (typeof body.token !== "string" || !isValidToken(body.token)) return Response.json({ error: "Invalid token." }, { status: 400 });
    if (!Array.isArray(body.accounts) || !body.accounts.length || body.accounts.length > CLUSTER_POLICY.batchSize
      || body.accounts.some((account: unknown) => typeof account !== "string" || !isAccountId(account))) {
      return Response.json({ error: `Scan between 1 and ${CLUSTER_POLICY.batchSize} valid holder accounts per batch.` }, { status: 400 });
    }
    const accounts: string[] = [...new Set<string>(body.accounts)];
    const map = await getHolderMap(body.token);
    if (!map) return Response.json({ error: "A live holder snapshot is required before scanning connections." }, { status: 503 });
    const holders = new Set(map.holders.map((holder) => holder.account));
    if (accounts.some((account) => !holders.has(account))) return Response.json({ error: "The holder snapshot changed. Refresh the map before scanning these accounts." }, { status: 409 });
    const result = await scanHolderBatch(map, accounts);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "On-chain connection analysis is unavailable." }, { status: 503 });
  }
}
