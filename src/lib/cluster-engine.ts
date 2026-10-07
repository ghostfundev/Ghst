import { CLUSTER_POLICY, classifyHolder, isAccountId, isInfrastructure, type ClusterEdge, type ClusterGraph, type Holder, type HolderCluster, type SourceExclusion, type TransferEvidence } from "./holder-model";

export type TransferRow = {
  account_id: string;
  other_account_id: string | null;
  asset_id: string;
  amount: string;
  transfer_type: string;
  method_name: string | null;
  receipt_account_id: string;
  receipt_id: string;
  transaction_id: string | null;
  block_timestamp: string;
  block_height: string;
};

type Outcome = { executor_id?: string; status?: Record<string, unknown>; logs?: string[] };
export type ExecutedTransaction = {
  transaction: { hash: string };
  receipts: {
    execution_outcome: { id?: string; outcome?: Outcome; block_timestamp?: string | number; block_height?: number };
    receipt: {
      receipt_id?: string;
      predecessor_id?: string;
      receiver_id?: string;
      receipt?: { Action?: { actions?: Record<string, unknown>[] } };
    };
  }[];
};

export function timestampMs(raw: string | number): number {
  if (!/^\d+$/.test(String(raw))) return 0;
  const value = BigInt(String(raw));
  return Number(value > 10n ** 16n ? value / 1_000_000n : value);
}

/** Normalize only explicit asset transfers. Deposits, mints, burns and refunds are not links. */
export function candidateFromRow(row: TransferRow, kind: TransferEvidence["kind"], token: string): TransferEvidence | null {
  if (!row.transaction_id || !/^[1-9A-HJ-NP-Za-km-z]{40,48}$/.test(row.transaction_id)
    || !/^[1-9A-HJ-NP-Za-km-z]{40,48}$/.test(row.receipt_id || "")
    || !isAccountId(row.account_id) || !row.other_account_id || !isAccountId(row.other_account_id)
    || !/^-?\d+$/.test(row.amount)) return null;
  const amount = BigInt(row.amount);
  if (amount === 0n) return null;
  const sender = amount > 0n ? row.other_account_id : row.account_id;
  const receiver = amount > 0n ? row.account_id : row.other_account_id;
  if (sender === receiver || sender === "system") return null;
  if (kind === "native_funding") {
    if (row.asset_id !== "native:near" || row.transfer_type !== "NativeTransfer"
      || amount < BigInt(CLUSTER_POLICY.minFundingRaw)) return null;
  } else if (row.asset_id !== `nep141:${token}` || row.transfer_type !== "FtTransfer"
    || row.method_name !== "ft_transfer" || row.receipt_account_id !== token) return null;
  const time = timestampMs(row.block_timestamp);
  const block = Number(row.block_height);
  if (!time || !Number.isSafeInteger(block) || block <= 0) return null;
  return {
    id: `${row.receipt_id}:${kind}:${sender}:${receiver}:${amount < 0n ? -amount : amount}`,
    kind, sender, receiver, asset: kind === "native_funding" ? "native:near" : `nep141:${token}`,
    amount: (amount < 0n ? -amount : amount).toString(), txHash: row.transaction_id,
    receiptId: row.receipt_id, timestampMs: time, blockHeight: block,
    verification: "successful_receipt", // A candidate is never returned until verifyTransferReceipt passes.
  };
}

function tokenEvents(logs: string[]): { sender: string; receiver: string; amount: string }[] {
  const events: { sender: string; receiver: string; amount: string }[] = [];
  for (const log of logs) {
    if (log.startsWith("EVENT_JSON:")) {
      try {
        const event = JSON.parse(log.slice("EVENT_JSON:".length));
        if (event.standard !== "nep141" || event.event !== "ft_transfer" || !Array.isArray(event.data)) continue;
        for (const item of event.data) {
          if (typeof item.old_owner_id === "string" && typeof item.new_owner_id === "string" && /^\d+$/.test(item.amount)) {
            events.push({ sender: item.old_owner_id, receiver: item.new_owner_id, amount: item.amount });
          }
        }
      } catch { /* Malformed or unrelated logs are not evidence. */ }
    } else {
      // Legacy NEP-141 contracts emit this documented plain-text transfer log.
      const match = /^Transfer (\d+) from ([a-z0-9._-]+) to ([a-z0-9._-]+)(?:$|[ ,])/.exec(log);
      if (match) events.push({ amount: match[1], sender: match[2], receiver: match[3] });
    }
  }
  return events;
}

function successful(outcome: Outcome | undefined): boolean {
  return Boolean(outcome?.status && Object.hasOwn(outcome.status, "SuccessValue") && !Object.hasOwn(outcome.status, "Failure"));
}

/** Check the executed receipt, not the transaction's intentions or a wallet's signer ID. */
export function verifyTransferReceipt(transaction: ExecutedTransaction, evidence: TransferEvidence, token: string): boolean {
  if (transaction.transaction?.hash !== evidence.txHash || !Array.isArray(transaction.receipts)) return false;
  const executed = transaction.receipts.find((entry) => entry.execution_outcome?.id === evidence.receiptId && entry.receipt?.receipt_id === evidence.receiptId);
  if (!executed || !successful(executed.execution_outcome.outcome)) return false;
  const receipt = executed.receipt;
  const outcome = executed.execution_outcome.outcome!;
  if (evidence.kind === "native_funding") {
    if (receipt.predecessor_id === "system" || receipt.predecessor_id !== evidence.sender
      || receipt.receiver_id !== evidence.receiver || outcome.executor_id !== evidence.receiver) return false;
    return (receipt.receipt?.Action?.actions || []).some((item) => {
      const transfer = item.Transfer as { deposit?: string } | undefined;
      return transfer?.deposit === evidence.amount;
    });
  }
  if (receipt.receiver_id !== token || outcome.executor_id !== token) return false;
  return tokenEvents(outcome.logs || []).some((event) => event.sender === evidence.sender && event.receiver === evidence.receiver && event.amount === evidence.amount);
}

/** Broad distributions are observable transfers, but weak evidence of a shared controller. */
export function isBulkDistribution(transaction: ExecutedTransaction, token: string, kind: TransferEvidence["kind"]): boolean {
  const recipients = new Set<string>();
  for (const entry of transaction.receipts || []) {
    if (!successful(entry.execution_outcome?.outcome)) continue;
    if (kind === "native_funding") {
      const actions = entry.receipt?.receipt?.Action?.actions || [];
      if (entry.receipt.predecessor_id !== "system" && actions.some((item) => Boolean(item.Transfer))) {
        if (entry.receipt.receiver_id) recipients.add(entry.receipt.receiver_id);
      }
    } else if (entry.execution_outcome.outcome?.executor_id === token) {
      for (const event of tokenEvents(entry.execution_outcome.outcome.logs || [])) recipients.add(event.receiver);
    }
  }
  return recipients.size >= CLUSTER_POLICY.bulkTransferRecipients;
}

/** Connected components mean transaction relationships, never common ownership. */
export function buildClusterGraph(args: {
  token: string;
  holders: Holder[];
  evidence: TransferEvidence[];
  exclusions?: SourceExclusion[];
  includeTransfers?: boolean;
  includeFunding?: boolean;
}): ClusterGraph {
  const blocked = new Set((args.exclusions || []).map((item) => item.account));
  const eligible = new Map(args.holders.filter((holder) => !isInfrastructure(holder.kind) && !blocked.has(holder.account)).map((holder) => [holder.account, holder]));
  const excluded = (account: string) => blocked.has(account) || isInfrastructure(classifyHolder(account).kind);
  const evidence = [...new Map(args.evidence.filter((item) => item.verification === "successful_receipt" && /^\d+$/.test(item.amount) && BigInt(item.amount) > 0n).map((item) => [item.id, item])).values()]
    .sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));
  const edges = new Map<string, ClusterEdge>();
  const used = new Set<string>();
  const parent = new Map([...eligible.keys()].map((key) => [key, key]));
  const root = (key: string): string => {
    const value = parent.get(key)!;
    if (value === key) return key;
    const result = root(value); parent.set(key, result); return result;
  };
  const join = (a: string, b: string) => { if (parent.has(a) && parent.has(b)) parent.set(root(b), root(a)); };
  const addEdge = (source: string, target: string, kind: ClusterEdge["kind"], id: string) => {
    const key = `${kind}:${source}:${target}`;
    const edge = edges.get(key) || { id: key, source, target, kind, evidenceIds: [] };
    edge.evidenceIds.push(id); edges.set(key, edge); used.add(id);
  };

  if (args.includeTransfers !== false) for (const item of evidence) {
    if (item.kind !== "token_transfer" || item.asset !== `nep141:${args.token}` || item.sender === item.receiver
      || !eligible.has(item.sender) || !eligible.has(item.receiver) || excluded(item.sender) || excluded(item.receiver)) continue;
    addEdge(item.sender, item.receiver, "token_transfer", item.id);
    join(item.sender, item.receiver);
  }

  if (args.includeFunding !== false) {
    const funders = new Map<string, Map<string, TransferEvidence>>();
    for (const item of evidence) {
      if (item.kind !== "native_funding" || item.asset !== "native:near" || BigInt(item.amount) < BigInt(CLUSTER_POLICY.minFundingRaw)
        || !eligible.has(item.receiver) || excluded(item.sender) || item.sender === item.receiver) continue;
      const targets = funders.get(item.sender) || new Map<string, TransferEvidence>();
      // Earliest verified funding observation per wallet, no repeated-count inflation.
      if (!targets.has(item.receiver)) targets.set(item.receiver, item);
      funders.set(item.sender, targets);
    }
    for (const [funder, targets] of funders) {
      if (targets.size < 2) continue;
      const wallets = [...targets.keys()];
      for (const receiver of wallets) {
        join(wallets[0], receiver);
        if (eligible.has(funder)) join(funder, receiver);
        addEdge(funder, receiver, "shared_funding", targets.get(receiver)!.id);
      }
    }
  }

  const components = new Map<string, string[]>();
  for (const wallet of eligible.keys()) {
    const id = root(wallet);
    components.set(id, [...(components.get(id) || []), wallet]);
  }
  const allEdges = [...edges.values()];
  const activeEvidence = evidence.filter((item) => used.has(item.id));
  const clusters: HolderCluster[] = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    members.sort();
    const memberSet = new Set(members);
    const linkedEdges = allEdges.filter((edge) => memberSet.has(edge.target) && (memberSet.has(edge.source) || edge.kind === "shared_funding"));
    const ids = new Set(linkedEdges.flatMap((edge) => edge.evidenceIds));
    const items = activeEvidence.filter((item) => ids.has(item.id));
    if (!items.length) continue;
    clusters.push({
      id: `cluster:${members[0]}`, members,
      funders: [...new Set(linkedEdges.filter((edge) => edge.kind === "shared_funding" && !memberSet.has(edge.source)).map((edge) => edge.source))].sort(),
      percent: members.reduce((sum, account) => sum + eligible.get(account)!.percent, 0),
      directTransfers: items.filter((item) => item.kind === "token_transfer").length,
      fundingTransfers: items.filter((item) => item.kind === "native_funding").length,
      evidenceIds: [...ids].sort(),
    });
  }
  clusters.sort((a, b) => b.percent - a.percent || a.id.localeCompare(b.id));
  return { edges: allEdges, clusters, evidence: activeEvidence, ignoredEvidence: evidence.length - activeEvidence.length };
}
