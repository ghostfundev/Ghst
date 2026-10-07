# GHOSTFUN holder connections

The Holders tab has two views: **Distribution** and **Connections**. No connection is generated from a wallet's name, balance, proximity, color or transaction signer alone.

## Provenance

- Top-holder balances: FastNEAR `/v1/ft/{token}/top`, with the existing Nearly holder endpoint as a balance-only fallback.
- Current supply and decimals: final NEAR RPC `ft_total_supply` and `ft_metadata` reads.
- Asset movement: FastNEAR Transfers API `POST /v0/transfers`, filtered to the exact token or native NEAR.
- Evidence check: FastNEAR Transactions API `POST /v0/transactions`. The indexed transfer must match the **successful executed receipt**, receipt ID, executor, sender, receiver and exact raw amount. Failed requests, missing receipts, unrelated logs, mints, burns, wrap/unwrap deposits and system refunds are not links.

The indexer and RPC can be at different points in time. This is a near-live indexed analysis, not an atomic chain snapshot or independent cryptographic verification of the indexer.

## Signals

**Direct token transfer**: a successful `ft_transfer` of this token between two indexed, non-infrastructure holders. Both standard NEP-141 events and documented legacy transfer logs are accepted. `ft_transfer_call` swap interactions are excluded. Solid lines show the real transfer direction.

**Shared funding**: at least two holders share a screened earliest indexed explicit native-NEAR funding source. Each funding leg must be independently receipt-verified and at least 0.1 NEAR. Dashed lines connect the actual funder to each recipient; no fictitious recipient-to-recipient transfer is drawn. External funders are diamonds and do not contribute to the holder balance of a cluster.

Funding history is an indexed sample, not proof of the original or ultimate source of funds. A shared source is a hypothesis, not proof of a common owner, coordinated trading or sybil activity.

## Conservative exclusions

- Known pools, lockers, bridges, protocol contracts, exchange accounts and account services.
- Smart-contract accounts detected through final `view_account` code state. This can exclude legitimate smart wallets.
- Sources with 16 or more different recipients in the last 24 sampled native funding transfers within the 30-day source-screening window. This is a fan-out heuristic, not an exchange identification.
- Bulk distribution transactions with 8 or more recipients.
- Sources whose screening is unavailable; unverifiable receipts never create lines.

The service registry and fan-out sample are incomplete. Unknown exchanges can still slip through, while legitimate shared sources can also create false positives. The UI explains this next to the evidence.

## Coverage and cost

- Default: the top 24 indexed non-infrastructure wallets. Optional deeper scan: top 80.
- Four wallets per application request; two upstream tasks in flight.
- Token transfer window: 30 days, at most 80 indexed events per wallet.
- Funding: the first 20 indexed incoming NEAR events of at least 0.1 NEAR, oldest first. Only the earliest explicit native transfer is considered; a disqualified service payer is not silently replaced by a later payer.
- At most 60 candidate receipts checked per batch, with transaction hashes deduplicated and fetched 20 at a time.
- Provider reads may be cached for 5 minutes. Scans are progressive and can be stopped.

Coverage is reported per wallet as complete-within-the-bounded-sample, partial, unavailable or excluded. A truncated page, rate limit or missing receipt is not treated as an empty history. No connection found is **not** an all-clear or a safety rating.

## API and deployment

`POST /api/holder-clusters` accepts a token and 1–4 current holder account IDs. It independently fetches the holder snapshot and rejects arbitrary account lists. It does not trust supplied balances or ownership percentages. Each batch returns scans, verified evidence, exclusions and the time window; graph grouping is deterministic.

Public FastNEAR endpoints may work without credentials but can be rate-limited. In production set `FASTNEAR_API_KEY` as a **server-side secret**. On Cloudflare use `npx wrangler secret put FASTNEAR_API_KEY`. Never use a `NEXT_PUBLIC_` prefix for this key. An upstream outage is shown as partial/unavailable coverage rather than synthetic data.

## Tests

`tests/holder-clusters.test.ts` contains isolated synthetic unit-test fixtures only. No fixtures are imported by production code. Tests cover successful receipts, failed receipts, sender/receiver/amount mismatch, system refunds, dust, single-recipient non-clusters, infrastructure and exchange exclusions, high-fan-out exclusions, deterministic connected components, duplicate-proof deduplication, unrelated tokens, bulk distributions, signal toggles and EVM-format address classification.
