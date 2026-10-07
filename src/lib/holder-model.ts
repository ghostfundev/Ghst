export type HolderKind = "pool" | "bridge" | "locker" | "contract" | "service" | "evm" | "implicit" | "named";

export type Holder = {
  account: string;
  balance: string;
  percent: number;
  kind: HolderKind;
  label: string | null;
  rank: number;
};

export type HolderMap = {
  token: string;
  totalSupply: string;
  decimals: number;
  holders: Holder[];
  circulating: { top10: number; top25: number; realHolders: number };
  infrastructure: number;
  source: string;
  fetchedAt: number;
};

const KNOWN: { match: RegExp; kind: HolderKind; label: string }[] = [
  { match: /^dclv2\.ref-labs\.near$/, kind: "pool", label: "Rhea DCL" },
  { match: /^(v2\.ref-finance|aggregatedex)\.near$/, kind: "pool", label: "DEX contract" },
  { match: /^(lock|lock_?\d+)\.nearlytrade\.near$/, kind: "locker", label: "Liquidity locker" },
  { match: /^nearlytrade\.near$/, kind: "contract", label: "Launch factory" },
  { match: /^(omni\.bridge|aurora|rainbow-bridge)\.near$/, kind: "bridge", label: "Bridge contract" },
  { match: /^(intents|wrap|feeswap|referralpot|burnpot)\.near$/, kind: "contract", label: "Protocol contract" },
  { match: /\.poolv1\.near$/, kind: "contract", label: "Staking contract" },
  // Labels are a conservative exclusion list, not a complete service registry.
  { match: /^(binance|mexc|mxc|okx|okex|bybit|kucoin|kraken|coinbase|gateio)(?:\d+)?\.near$/, kind: "service", label: "Known exchange account" },
  { match: /^(faucet|testnet|near|registrar|wallet|near-wallet)$/, kind: "service", label: "Account service" },
];

export function classifyHolder(account: string): { kind: HolderKind; label: string | null } {
  for (const entry of KNOWN) if (entry.match.test(account)) return { kind: entry.kind, label: entry.label };
  // A 0x address on NEAR does not, by itself, prove it is a bridge or a related wallet.
  if (/^0x[0-9a-f]{40}$/i.test(account)) return { kind: "evm", label: "EVM-format account" };
  if (/^[0-9a-f]{64}$/i.test(account)) return { kind: "implicit", label: null };
  return { kind: "named", label: null };
}

export const isInfrastructure = (kind: HolderKind): boolean => ["pool", "bridge", "locker", "contract", "service"].includes(kind);
export const isAccountId = (value: string): boolean => value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);

export const CLUSTER_POLICY = {
  version: "receipt-verified-v1",
  batchSize: 4,
  quickWallets: 24,
  deepWallets: 80,
  lookbackDays: 30,
  tokenRowsPerWallet: 80,
  fundingRowsPerWallet: 20,
  sourceRows: 24,
  highFanoutRecipients: 16,
  bulkTransferRecipients: 8,
  minFundingRaw: "100000000000000000000000", // 0.1 NEAR; gas refunds and dust are not funding evidence.
  maxEvidencePerBatch: 60,
} as const;

export type TransferEvidence = {
  id: string;
  kind: "token_transfer" | "native_funding";
  sender: string;
  receiver: string;
  asset: string;
  amount: string;
  txHash: string;
  receiptId: string;
  timestampMs: number;
  blockHeight: number;
  verification: "successful_receipt";
};

export type SourceExclusion = { account: string; reason: string };
export type WalletScan = {
  account: string;
  status: "complete" | "partial" | "unavailable" | "excluded";
  tokenRows: number;
  fundingRows: number;
  tokenHasMore: boolean;
  fundingHasMore: boolean;
  oldestTokenAt: number | null;
  note: string | null;
};

export type ClusterBatch = {
  token: string;
  scans: WalletScan[];
  evidence: TransferEvidence[];
  exclusions: SourceExclusion[];
  verification: { candidates: number; verified: number; rejected: number; unavailable: number; truncated: boolean };
  window: { from: number; to: number };
  source: "FastNEAR Transfers + executed receipts";
  analyzedAt: number;
};

export type ClusterEdge = {
  id: string;
  source: string;
  target: string;
  kind: "token_transfer" | "shared_funding";
  evidenceIds: string[];
};

export type HolderCluster = {
  id: string;
  members: string[];
  funders: string[];
  percent: number;
  directTransfers: number;
  fundingTransfers: number;
  evidenceIds: string[];
};

export type ClusterGraph = {
  edges: ClusterEdge[];
  clusters: HolderCluster[];
  evidence: TransferEvidence[];
  ignoredEvidence: number;
};
