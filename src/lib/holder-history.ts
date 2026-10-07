import "server-only";
import { candidateFromRow, isBulkDistribution, verifyTransferReceipt, type ExecutedTransaction, type TransferRow } from "@/lib/cluster-engine";
import { CLUSTER_POLICY, classifyHolder, isAccountId, isInfrastructure, type ClusterBatch, type HolderMap, type SourceExclusion, type TransferEvidence, type WalletScan } from "@/lib/holder-model";

const TRANSFERS = "https://transfers.main.fastnear.com/v0/transfers";
const TRANSACTIONS = "https://tx.main.fastnear.com/v0/transactions";
const RPC = "https://rpc.mainnet.fastnear.com";
const EMPTY_CODE = "11111111111111111111111111111111";

type TransferPage = { rows: TransferRow[]; hasMore: boolean; error: string | null };

function headers(): Record<string, string> {
  return { "content-type": "application/json", ...(process.env.FASTNEAR_API_KEY ? { Authorization: `Bearer ${process.env.FASTNEAR_API_KEY}` } : {}) };
}

async function post(url: string, body: Record<string, unknown>, seconds = 12): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST", headers: headers(), body: JSON.stringify(body),
    next: { revalidate: 300 }, signal: AbortSignal.timeout(seconds * 1000),
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error("FastNEAR rate limit reached. Retry later or configure a server-side FASTNEAR_API_KEY.");
    if (response.status === 401 || response.status === 403) throw new Error("History access requires a server-side FASTNEAR_API_KEY.");
    throw new Error(`On-chain history provider returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function transferPage(body: Record<string, unknown>): Promise<TransferPage> {
  try {
    const data = await post(TRANSFERS, body) as { transfers?: TransferRow[]; resume_token?: string | null };
    if (!Array.isArray(data.transfers)) throw new Error("Transfer history response was incomplete.");
    return { rows: data.transfers, hasMore: Boolean(data.resume_token), error: null };
  } catch (error) {
    return { rows: [], hasMore: false, error: error instanceof Error ? error.message : "Transfer history unavailable." };
  }
}

/** Unknown smart contracts are excluded conservatively; services with plain keys need fan-out screening too. */
async function accountRole(account: string): Promise<string | null> {
  const known = classifyHolder(account);
  if (isInfrastructure(known.kind)) return known.label || "Known infrastructure or service";
  if (account === "system" || !isAccountId(account)) return "System or invalid account";
  try {
    const data = await post(RPC, { jsonrpc: "2.0", id: "holder-role", method: "query", params: {
      request_type: "view_account", finality: "final", account_id: account,
    } }) as { result?: { code_hash?: string; global_contract_hash?: string; global_contract_account_id?: string } };
    if (!data.result?.code_hash) return "Account classification unavailable";
    if (data.result.global_contract_hash || data.result.global_contract_account_id || data.result.code_hash !== EMPTY_CODE) return "Smart-contract account";
    return null;
  } catch {
    return "Account classification unavailable";
  }
}

async function screenFundingSource(account: string, window: { from: number; to: number }): Promise<SourceExclusion | null> {
  const role = await accountRole(account);
  if (role) return { account, reason: role };
  const outgoing = await transferPage({
    account_id: account, asset_id: "native:near", direction: "sender", desc: true,
    limit: CLUSTER_POLICY.sourceRows, min_amount: CLUSTER_POLICY.minFundingRaw,
    ignore_system: true, from_timestamp_ms: window.from, to_timestamp_ms: window.to,
  });
  if (outgoing.error) return { account, reason: "Funding-source screening unavailable" };
  const recipients = new Set(outgoing.rows.filter((row) => row.transfer_type === "NativeTransfer" && row.other_account_id && row.other_account_id !== "system").map((row) => row.other_account_id));
  if (recipients.size >= CLUSTER_POLICY.highFanoutRecipients) return {
    account, reason: `High-fan-out source: ${recipients.size} recipients in ${outgoing.rows.length} sampled transfers. Not treated as evidence of common control.`,
  };
  return null;
}

async function concurrentMap<T, R>(items: T[], work: (item: T) => Promise<R>, concurrency = 2): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await work(items[index]); }
  }));
  return result;
}

/**
 * Bounded scan: four wallets per invocation, two upstream calls in flight at a time.
 * The client assembles batches progressively so Cloudflare does not need one
 * hundreds-of-subrequests invocation to analyse the entire holder table.
 */
export async function scanHolderBatch(map: HolderMap, accounts: string[]): Promise<ClusterBatch> {
  const to = Math.floor(Date.now() / 300000) * 300000;
  const window = { from: to - CLUSTER_POLICY.lookbackDays * 86400000, to };
  const allWallets = new Set(map.holders.filter((holder) => !isInfrastructure(holder.kind)).map((holder) => holder.account));
  const exclusions = new Map<string, SourceExclusion>();
  const reports = await concurrentMap(accounts, async (account) => {
    const scan: WalletScan = { account, status: "complete", tokenRows: 0, fundingRows: 0, tokenHasMore: false, fundingHasMore: false, oldestTokenAt: null, note: null };
    if (!allWallets.has(account)) return { scan: { ...scan, status: "excluded" as const, note: "Account is not an eligible holder in the current snapshot." }, candidates: [] as TransferEvidence[] };
    const role = await accountRole(account);
    if (role) {
      exclusions.set(account, { account, reason: role });
      return { scan: { ...scan, status: role.includes("unavailable") ? "unavailable" as const : "excluded" as const, note: role }, candidates: [] as TransferEvidence[] };
    }
    const tokenPage = await transferPage({
      account_id: account, asset_id: `nep141:${map.token}`, desc: true,
      limit: CLUSTER_POLICY.tokenRowsPerWallet, ignore_system: true,
      from_timestamp_ms: window.from, to_timestamp_ms: window.to,
    });
    const fundingPage = await transferPage({
      account_id: account, asset_id: "native:near", direction: "receiver", desc: false,
      limit: CLUSTER_POLICY.fundingRowsPerWallet, ignore_system: true,
      min_amount: CLUSTER_POLICY.minFundingRaw,
    });
    scan.tokenRows = tokenPage.rows.length; scan.fundingRows = fundingPage.rows.length;
    scan.tokenHasMore = tokenPage.hasMore; scan.fundingHasMore = fundingPage.hasMore;
    if (tokenPage.error && fundingPage.error) scan.status = "unavailable";
    else if (tokenPage.error || fundingPage.error || tokenPage.hasMore || fundingPage.hasMore) scan.status = "partial";
    scan.note = [tokenPage.error, fundingPage.error].filter(Boolean).join(" ") || null;
    const peers = tokenPage.rows.map((row) => candidateFromRow(row, "token_transfer", map.token))
      .filter((item): item is TransferEvidence => Boolean(item && allWallets.has(item.sender) && allWallets.has(item.receiver)));
    if (tokenPage.rows.length) {
      const times = tokenPage.rows.map((row) => candidateFromRow(row, "token_transfer", map.token)?.timestampMs).filter((value): value is number => Boolean(value));
      scan.oldestTokenAt = times.length ? Math.min(...times) : null;
    }
    // Preserve the earliest indexed native funding observation. If it is a
    // service payout, do not silently replace it with a later unrelated payer.
    const funding = fundingPage.rows.map((row) => candidateFromRow(row, "native_funding", map.token))
      .filter((item): item is TransferEvidence => Boolean(item && item.receiver === account))
      .sort((a, b) => a.timestampMs - b.timestampMs)[0];
    return { scan, candidates: [...peers, ...(funding ? [funding] : [])] };
  });

  const fundingSources = [...new Set(reports.flatMap((report) => report.candidates).filter((item) => item.kind === "native_funding").map((item) => item.sender))];
  await concurrentMap(fundingSources, async (account) => {
    const exclusion = await screenFundingSource(account, window);
    if (exclusion) exclusions.set(account, exclusion);
  });

  const unique = [...new Map(reports.flatMap((report) => report.candidates).map((item) => [item.id, item])).values()];
  const candidates = unique.filter((item) => !exclusions.has(item.sender) && !exclusions.has(item.receiver)
    && !isInfrastructure(classifyHolder(item.sender).kind) && !isInfrastructure(classifyHolder(item.receiver).kind));
  const limited = candidates.slice(0, CLUSTER_POLICY.maxEvidencePerBatch);
  const hashes = [...new Set(limited.map((item) => item.txHash))];
  const transactions = new Map<string, ExecutedTransaction>();
  const failedHashes = new Set<string>();
  for (let start = 0; start < hashes.length; start += 20) {
    const part = hashes.slice(start, start + 20);
    try {
      const data = await post(TRANSACTIONS, { tx_hashes: part }, 15) as { transactions?: ExecutedTransaction[] };
      for (const transaction of data.transactions || []) if (transaction.transaction?.hash) transactions.set(transaction.transaction.hash, transaction);
      for (const hash of part) if (!transactions.has(hash)) failedHashes.add(hash);
    } catch { for (const hash of part) failedHashes.add(hash); }
  }
  const evidence: TransferEvidence[] = [];
  let rejected = 0; let unavailable = 0;
  for (const item of limited) {
    const transaction = transactions.get(item.txHash);
    if (!transaction || failedHashes.has(item.txHash)) { unavailable++; continue; }
    if (!verifyTransferReceipt(transaction, item, map.token) || isBulkDistribution(transaction, map.token, item.kind)) { rejected++; continue; }
    evidence.push(item);
  }
  const scans = reports.map(({ scan, candidates: walletCandidates }) => {
    const incomplete = walletCandidates.some((item) => failedHashes.has(item.txHash));
    const screeningMissing = walletCandidates.some((item) => item.kind === "native_funding" && exclusions.get(item.sender)?.reason.includes("unavailable"));
    if ((incomplete || screeningMissing || candidates.length > limited.length) && scan.status === "complete") return {
      ...scan, status: "partial" as const,
      note: screeningMissing ? "Funding-source screening was incomplete; no shared-funder links were inferred from that source." : "Some candidate receipts could not be checked within this scan.",
    };
    return scan;
  });
  return {
    token: map.token, scans, evidence, exclusions: [...exclusions.values()],
    verification: { candidates: limited.length, verified: evidence.length, rejected, unavailable, truncated: candidates.length > limited.length },
    window, source: "FastNEAR Transfers + executed receipts", analyzedAt: Date.now(),
  };
}
