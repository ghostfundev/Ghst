import assert from "node:assert/strict";
import test from "node:test";
import { buildClusterGraph, candidateFromRow, isBulkDistribution, verifyTransferReceipt, type ExecutedTransaction, type TransferRow } from "../src/lib/cluster-engine";
import { CLUSTER_POLICY, classifyHolder, type Holder, type TransferEvidence } from "../src/lib/holder-model";

// Synthetic fixtures are confined to tests. Production only accepts indexed rows
// that match an executed successful receipt from FastNEAR.
const TOKEN = "sample.nearlytrade.near";
const HASH = "A".repeat(44);
const RECEIPT = "B".repeat(44);
const amount = "1000000000000000000000000";
function holder(account: string, percent: number): Holder { return { account, percent, balance: amount, kind: "named", label: null, rank: 1 }; }
const holders = [holder("alice.near", 10), holder("bob.near", 8), holder("carol.near", 3)];
function evidence(sender: string, receiver: string, kind: TransferEvidence["kind"] = "token_transfer", id = `${sender}:${receiver}`): TransferEvidence {
  return { id, kind, sender, receiver, asset: kind === "token_transfer" ? `nep141:${TOKEN}` : "native:near", amount, txHash: HASH, receiptId: RECEIPT, blockHeight: 200000000, timestampMs: 1790000000000, verification: "successful_receipt" };
}
function executed(item: TransferEvidence): ExecutedTransaction {
  return { transaction: { hash: HASH }, receipts: [{
    execution_outcome: { id: RECEIPT, block_height: 200000000, outcome: {
      executor_id: item.kind === "token_transfer" ? TOKEN : item.receiver, status: { SuccessValue: "" },
      logs: item.kind === "token_transfer" ? ["EVENT_JSON:" + JSON.stringify({ standard: "nep141", event: "ft_transfer", data: [{ old_owner_id: item.sender, new_owner_id: item.receiver, amount: item.amount }] })] : [],
    } },
    receipt: { receipt_id: RECEIPT, predecessor_id: item.sender, receiver_id: item.kind === "token_transfer" ? TOKEN : item.receiver,
      receipt: { Action: { actions: item.kind === "native_funding" ? [{ Transfer: { deposit: item.amount } }] : [] } } },
  }] };
}

test("verifies an executed successful NEP-141 event", () => {
  const item = evidence("alice.near", "bob.near");
  assert.equal(verifyTransferReceipt(executed(item), item, TOKEN), true);
});
test("failed receipt cannot create a connection", () => {
  const item = evidence("alice.near", "bob.near"); const tx = executed(item);
  tx.receipts[0].execution_outcome.outcome!.status = { Failure: { ActionError: {} } };
  assert.equal(verifyTransferReceipt(tx, item, TOKEN), false);
});
test("a requested transfer without a matching event is not evidence", () => {
  const item = evidence("alice.near", "bob.near"); const tx = executed(item);
  tx.receipts[0].execution_outcome.outcome!.logs = [];
  assert.equal(verifyTransferReceipt(tx, item, TOKEN), false);
});
test("checks token contract, amount, sender and receiver exactly", () => {
  const item = evidence("alice.near", "bob.near"); const tx = executed(item);
  assert.equal(verifyTransferReceipt(tx, { ...item, amount: "1" }, TOKEN), false);
  assert.equal(verifyTransferReceipt(tx, { ...item, receiver: "carol.near" }, TOKEN), false);
  tx.receipts[0].execution_outcome.outcome!.executor_id = "other.near";
  assert.equal(verifyTransferReceipt(tx, item, TOKEN), false);
});
test("native funding uses the real receipt predecessor and rejects system refunds", () => {
  const item = evidence("alice.near", "bob.near", "native_funding"); const tx = executed(item);
  assert.equal(verifyTransferReceipt(tx, item, TOKEN), true);
  tx.receipts[0].receipt.predecessor_id = "system";
  assert.equal(verifyTransferReceipt(tx, item, TOKEN), false);
});
test("normalizes signed indexed rows and rejects dust, self-transfers and mints", () => {
  const row: TransferRow = { account_id: "bob.near", other_account_id: "alice.near", amount, asset_id: "native:near", transfer_type: "NativeTransfer", method_name: null, receipt_account_id: "bob.near", receipt_id: RECEIPT, transaction_id: HASH, block_height: "200000000", block_timestamp: "1790000000000000000" };
  assert.equal(candidateFromRow(row, "native_funding", TOKEN)?.timestampMs, 1790000000000);
  assert.equal(candidateFromRow({ ...row, amount: "100" }, "native_funding", TOKEN), null);
  assert.equal(candidateFromRow({ ...row, other_account_id: "bob.near" }, "native_funding", TOKEN), null);
  assert.equal(candidateFromRow({ ...row, other_account_id: null }, "native_funding", TOKEN), null);
});
test("same funder produces two evidence-backed legs, not an invented wallet-to-wallet edge", () => {
  const result = buildClusterGraph({ token: TOKEN, holders, evidence: [evidence("source.near", "alice.near", "native_funding", "f1"), evidence("source.near", "bob.near", "native_funding", "f2")] });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].percent, 18);
  assert.deepEqual(result.clusters[0].funders, ["source.near"]);
  assert.equal(result.edges.length, 2);
  assert.ok(result.edges.every((edge) => edge.source === "source.near"));
});
test("one recipient or an unverified candidate is never a shared-funder cluster", () => {
  assert.equal(buildClusterGraph({ token: TOKEN, holders, evidence: [evidence("source.near", "alice.near", "native_funding")] }).clusters.length, 0);
  const invalid = { ...evidence("alice.near", "bob.near"), verification: "unverified" } as unknown as TransferEvidence;
  assert.equal(buildClusterGraph({ token: TOKEN, holders, evidence: [invalid] }).edges.length, 0);
});
test("DEX pools and exchanges do not merge their recipients", () => {
  for (const source of ["dclv2.ref-labs.near", "intents.near", "binance.near", "omni.bridge.near"]) {
    const result = buildClusterGraph({ token: TOKEN, holders, evidence: [evidence(source, "alice.near", "native_funding", "f1"), evidence(source, "bob.near", "native_funding", "f2")] });
    assert.equal(result.clusters.length, 0, source);
  }
});
test("a screened high-fan-out source cannot create a shared-funding cluster", () => {
  const result = buildClusterGraph({ token: TOKEN, holders, evidence: [evidence("source.near", "alice.near", "native_funding", "f1"), evidence("source.near", "bob.near", "native_funding", "f2")], exclusions: [{ account: "source.near", reason: "High fan-out" }] });
  assert.equal(result.edges.length, 0);
});
test("direct transfer components are transitive, deterministic and count each holder only once", () => {
  const items = [evidence("alice.near", "bob.near", "token_transfer", "t1"), evidence("bob.near", "carol.near", "token_transfer", "t2")];
  const a = buildClusterGraph({ token: TOKEN, holders, evidence: [...items, items[0]] });
  const b = buildClusterGraph({ token: TOKEN, holders: [...holders].reverse(), evidence: [...items].reverse() });
  assert.deepEqual(a.clusters, b.clusters);
  assert.equal(a.clusters[0].percent, 21);
  assert.equal(a.clusters[0].directTransfers, 2);
  assert.equal(a.evidence.length, 2);
});
test("airdrops of another token cannot link this token's holders", () => {
  const item = { ...evidence("alice.near", "bob.near"), asset: "nep141:unrelated.near" };
  assert.equal(buildClusterGraph({ token: TOKEN, holders, evidence: [item] }).edges.length, 0);
});
test("bulk distribution transactions are excluded", () => {
  const item = evidence("alice.near", "bob.near"); const tx = executed(item);
  tx.receipts[0].execution_outcome.outcome!.logs = ["EVENT_JSON:" + JSON.stringify({ standard: "nep141", event: "ft_transfer", data: Array.from({ length: CLUSTER_POLICY.bulkTransferRecipients }, (_, index) => ({ old_owner_id: "source.near", new_owner_id: `user${index}.near`, amount })) })];
  assert.equal(isBulkDistribution(tx, TOKEN, "token_transfer"), true);
});
test("turning shared funding off leaves only direct token-transfer links", () => {
  const result = buildClusterGraph({ token: TOKEN, holders, evidence: [evidence("alice.near", "bob.near"), evidence("source.near", "alice.near", "native_funding", "f1"), evidence("source.near", "carol.near", "native_funding", "f2")], includeFunding: false });
  assert.equal(result.edges.length, 1);
  assert.equal(result.clusters[0].percent, 18);
});
test("0x account format is not proof of bridging or common ownership", () => {
  assert.equal(classifyHolder("0x" + "a".repeat(40)).kind, "evm");
});
