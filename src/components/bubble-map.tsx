"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, CircleAlert, Eye, GitBranch, Info, LoaderCircle, Network, RotateCw, Search, ShieldCheck, X } from "lucide-react";
import { compactNumber, fromUnits, shortAddress } from "@/lib/format";
import { buildClusterGraph } from "@/lib/cluster-engine";
import { CLUSTER_POLICY, isInfrastructure, type ClusterBatch, type ClusterEdge, type ClusterGraph, type Holder, type HolderKind, type HolderMap, type TransferEvidence } from "@/lib/holder-model";

type VisualNode = { account: string; x: number; y: number; r: number; holder: Holder | null; clusterId: string | null };
type Selection = { type: "wallet" | "cluster" | "edge"; id: string } | null;
const PALETTE: Record<HolderKind, string> = { pool: "#6aadd4", locker: "#6aadd4", bridge: "#a09cde", contract: "#a09cde", service: "#a09cde", evm: "#68c6bd", implicit: "#d5a37a", named: "#77d6b5" };
const CLUSTER_COLORS = ["#83d9c2", "#aea3f2", "#e5b780", "#86bfee", "#e69bc2", "#b7d981", "#9dcbd2", "#d6a994"];

/** Deterministic collision layout. Position is cosmetic; every edge is backed by receipts. */
function layout(holders: Holder[], graph: ClusterGraph, width: number, height: number, connections: boolean): VisualNode[] {
  const clusterByAccount = new Map(graph.clusters.flatMap((cluster) => cluster.members.map((account) => [account, cluster.id] as const)));
  const groups = [...graph.clusters].sort((a, b) => a.id.localeCompare(b.id));
  const anchors = new Map(groups.map((group, index) => [group.id, {
    x: width * (0.25 + (index % 3) * 0.25), y: height * (0.3 + (Math.floor(index / 3) % 2) * 0.4),
  }]));
  const total = Math.max(1, holders.reduce((sum, holder) => sum + holder.percent, 0));
  const scale = Math.sqrt(width * height * 0.27 / (Math.PI * total));
  const nodes: VisualNode[] = holders.map((holder, index) => {
    const angle = index * 2.39996323;
    const distance = Math.sqrt((index + 0.5) / Math.max(1, holders.length));
    return { account: holder.account, holder, clusterId: clusterByAccount.get(holder.account) || null,
      x: width * 0.5 + Math.cos(angle) * distance * width * 0.38,
      y: height * 0.5 + Math.sin(angle) * distance * height * 0.38,
      r: Math.max(width < 450 ? 5 : 6.5, Math.sqrt(Math.max(holder.percent, 0)) * scale),
    };
  });
  if (connections) {
    const present = new Set(nodes.map((node) => node.account));
    for (const group of graph.clusters) for (const funder of group.funders) {
      if (present.has(funder)) continue;
      const anchor = anchors.get(group.id)!;
      nodes.push({ account: funder, holder: null, clusterId: group.id, x: anchor.x - 45, y: anchor.y - 60, r: 12 });
      present.add(funder);
    }
  }
  const byAccount = new Map(nodes.map((node) => [node.account, node]));
  for (let tick = 0; tick < 135; tick++) {
    if (connections) for (const node of nodes) {
      const anchor = node.clusterId ? anchors.get(node.clusterId) : null;
      if (anchor) { node.x += (anchor.x - node.x) * 0.016; node.y += (anchor.y - node.y) * 0.016; }
    }
    if (connections) for (const edge of graph.edges) {
      const source = byAccount.get(edge.source), target = byAccount.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x, dy = target.y - source.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const push = (d - source.r - target.r - 24) * 0.024;
      source.x += dx / d * push; source.y += dy / d * push;
      target.x -= dx / d * push; target.y -= dy / d * push;
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x || 0.001, dy = b.y - a.y || 0.001;
      const d = Math.max(0.001, Math.hypot(dx, dy));
      const minimum = a.r + b.r + 3;
      if (d < minimum) {
        const push = (minimum - d) * 0.51;
        a.x -= dx / d * push; a.y -= dy / d * push;
        b.x += dx / d * push; b.y += dy / d * push;
      }
    }
    for (const node of nodes) { node.x = Math.max(node.r + 4, Math.min(width - node.r - 4, node.x)); node.y = Math.max(node.r + 4, Math.min(height - node.r - 4, node.y)); }
  }
  return nodes;
}

function EvidenceRow({ item, decimals, symbol }: { item: TransferEvidence; decimals: number; symbol: string }) {
  const native = item.kind === "native_funding";
  return <div className="cluster-evidence-row" data-evidence-kind={item.kind}>
    <span className={`evidence-type ${native ? "funding" : "direct"}`}>{native ? "Funding" : "Transfer"}</span>
    <div className="evidence-flow"><a href={`https://nearblocks.io/address/${item.sender}`} target="_blank" rel="noreferrer" title={item.sender}>{shortAddress(item.sender)}</a><ArrowRight size={11} /><a href={`https://nearblocks.io/address/${item.receiver}`} target="_blank" rel="noreferrer" title={item.receiver}>{shortAddress(item.receiver)}</a><small>{fromUnits(item.amount, native ? 24 : decimals, 8)} {native ? "NEAR" : symbol} · {new Date(item.timestampMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</small></div>
    <a className="evidence-proof" href={`https://nearblocks.io/txns/${item.txHash}`} target="_blank" rel="noreferrer" title={`Transaction ${item.txHash}\nReceipt ${item.receiptId}\nBlock ${item.blockHeight}`}><Check size={10} /> Receipt <ArrowUpRight size={12} /></a>
  </div>;
}

export function BubbleMap({ token, symbol }: { token: string; symbol: string }) {
  const [data, setData] = useState<HolderMap | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showInfra, setShowInfra] = useState(false);
  const [view, setView] = useState<"distribution" | "connections">("distribution");
  const [batches, setBatches] = useState<ClusterBatch[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanTarget, setScanTarget] = useState(0);
  const [scanError, setScanError] = useState("");
  const [scanLimit, setScanLimit] = useState<number>(CLUSTER_POLICY.quickWallets);
  const [includeFunding, setIncludeFunding] = useState(true);
  const [includeTransfers, setIncludeTransfers] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [expandedEvidence, setExpandedEvidence] = useState(false);
  const [size, setSize] = useState({ w: 760, h: 470 });
  const boxRef = useRef<HTMLDivElement>(null);
  const holderRequest = useRef<AbortController | null>(null);
  const analysisRequest = useRef<AbortController | null>(null);
  const uniqueId = useId().replace(/:/g, "");

  const load = useCallback(async () => {
    holderRequest.current?.abort(); analysisRequest.current?.abort();
    const controller = new AbortController(); holderRequest.current = controller;
    setLoading(true); setError(""); setBatches([]); setSelection(null); setScanning(false); setScanError("");
    try {
      const response = await fetch(`/api/holders?token=${encodeURIComponent(token)}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Holder data unavailable.");
      if (!controller.signal.aborted) setData(result);
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Holder data unavailable."); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [token]);

  useEffect(() => { load(); return () => { holderRequest.current?.abort(); analysisRequest.current?.abort(); }; }, [load]);
  useEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.max(250, entry.contentRect.width);
      setSize({ w, h: Math.round(Math.min(530, Math.max(380, w * 0.6))) });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);

  const graph = useMemo(() => buildClusterGraph({ token, holders: data?.holders || [], evidence: batches.flatMap((batch) => batch.evidence), exclusions: batches.flatMap((batch) => batch.exclusions), includeFunding, includeTransfers }), [token, data, batches, includeFunding, includeTransfers]);
  const scans = useMemo(() => [...new Map(batches.flatMap((batch) => batch.scans).map((scan) => [scan.account, scan])).values()], [batches]);
  const exclusions = useMemo(() => [...new Map(batches.flatMap((batch) => batch.exclusions).map((item) => [item.account, item])).values()], [batches]);
  const verifiedCount = useMemo(() => new Set(batches.flatMap((batch) => batch.evidence).map((item) => item.id)).size, [batches]);
  const eligibleCount = data?.holders.filter((holder) => !isInfrastructure(holder.kind)).length || 0;
  const visible = useMemo(() => data?.holders.filter((holder) => showInfra || !isInfrastructure(holder.kind)) || [], [data, showInfra]);
  const nodes = useMemo(() => layout(visible, graph, size.w, size.h, view === "connections"), [visible, graph, size, view]);
  const byAccount = useMemo(() => new Map(nodes.map((node) => [node.account, node])), [nodes]);
  const colors = useMemo(() => new Map(graph.clusters.map((cluster, index) => [cluster.id, CLUSTER_COLORS[index % CLUSTER_COLORS.length]])), [graph.clusters]);
  const selectedCluster = selection?.type === "cluster" ? graph.clusters.find((cluster) => cluster.id === selection.id) : null;
  const selectedNode = selection?.type === "wallet" ? byAccount.get(selection.id) : null;
  const selectedEdge = selection?.type === "edge" ? graph.edges.find((edge) => edge.id === selection.id) : null;
  const focusedAccounts = useMemo(() => {
    if (selectedCluster) return new Set([...selectedCluster.members, ...selectedCluster.funders]);
    if (selectedNode) return new Set([selectedNode.account, ...graph.edges.filter((edge) => edge.source === selectedNode.account || edge.target === selectedNode.account).flatMap((edge) => [edge.source, edge.target])]);
    if (selectedEdge) return new Set([selectedEdge.source, selectedEdge.target]);
    return null;
  }, [selectedCluster, selectedNode, selectedEdge, graph.edges]);
  const proofItems = useMemo(() => graph.evidence.filter((item) => {
    if (selectedCluster) return selectedCluster.evidenceIds.includes(item.id);
    if (selectedNode) return item.sender === selectedNode.account || item.receiver === selectedNode.account;
    if (selectedEdge) return selectedEdge.evidenceIds.includes(item.id);
    return true;
  }), [graph.evidence, selectedCluster, selectedNode, selectedEdge]);
  const hasIncomplete = scans.some((scan) => scan.status === "unavailable" || scan.status === "partial");
  const hoverNode = hover ? byAccount.get(hover) : null;

  const analyze = async () => {
    if (!data || scanning || loading) return;
    analysisRequest.current?.abort();
    const controller = new AbortController(); analysisRequest.current = controller;
    const accounts = data.holders.filter((holder) => !isInfrastructure(holder.kind)).slice(0, scanLimit).map((holder) => holder.account);
    setBatches([]); setScanError(""); setSelection(null); setExpandedEvidence(false); setScanning(true); setScanTarget(accounts.length); setView("connections");
    try {
      for (let start = 0; start < accounts.length; start += CLUSTER_POLICY.batchSize) {
        if (controller.signal.aborted) return;
        const response = await fetch("/api/holder-clusters", {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ token, accounts: accounts.slice(start, start + CLUSTER_POLICY.batchSize) }),
        });
        const batch = await response.json() as ClusterBatch & { error?: string };
        if (!response.ok) throw new Error(batch.error || "Connection analysis unavailable.");
        if (!Array.isArray(batch.scans) || !Array.isArray(batch.evidence)) throw new Error("Incomplete history response.");
        if (controller.signal.aborted) return;
        setBatches((current) => [...current, batch]);
        if (batch.scans.every((scan) => scan.status === "unavailable")) throw new Error("History access is unavailable. Completed batches remain visible. Retry later or configure FASTNEAR_API_KEY on the server.");
        // Be polite to the public indexer; production can attach a server-side API key.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } catch (err) { if (!controller.signal.aborted) setScanError(err instanceof Error ? err.message : "Scan failed."); }
    finally { if (analysisRequest.current === controller) setScanning(false); }
  };

  const stop = () => { analysisRequest.current?.abort(); setScanning(false); setScanError("Scan stopped. Evidence from completed batches is still shown."); };
  const select = (value: Selection) => { setSelection(value); setExpandedEvidence(false); };
  const edgeCoordinates = (edge: ClusterEdge) => {
    const a = byAccount.get(edge.source), b = byAccount.get(edge.target);
    if (!a || !b) return null;
    const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
    return { x1: a.x + dx / distance * (a.r + 2), y1: a.y + dy / distance * (a.r + 2), x2: b.x - dx / distance * (b.r + 6), y2: b.y - dy / distance * (b.r + 6) };
  };

  return <section className="bubble-section">
    <div className="cluster-header"><div className="cluster-heading"><Network size={17} /><strong>Holder intelligence</strong><span className="cluster-live-label"><span className="live-dot" /> ON-CHAIN</span></div><button type="button" className={`refresh-button ${loading ? "spinning" : ""}`} onClick={load} disabled={scanning} title="Refresh holder snapshot"><RotateCw size={15} /></button></div>
    <div className="cluster-view-toolbar"><div className="cluster-view-tabs"><button type="button" className={view === "distribution" ? "active" : ""} onClick={() => setView("distribution")}><Eye size={13} /> Distribution</button><button type="button" className={view === "connections" ? "active" : ""} onClick={() => setView("connections")}><GitBranch size={13} /> Connections {graph.clusters.length > 0 && <span>{graph.clusters.length}</span>}</button></div><label className="bubble-infra-toggle"><input type="checkbox" checked={showInfra} onChange={(event) => setShowInfra(event.target.checked)} /> Include infrastructure</label></div>

    {data && <div className="bubble-stats"><div><span>TOP 10 WALLETS</span><strong>{data.circulating.top10.toFixed(1)}%</strong></div><div><span>IN INFRASTRUCTURE</span><strong>{data.infrastructure.toFixed(1)}%</strong></div><div><span>OBSERVED CLUSTERS</span><strong>{scans.length ? graph.clusters.length : "—"}</strong></div><div><span>LARGEST CLUSTER</span><strong>{graph.clusters[0] ? `${graph.clusters[0].percent.toFixed(2)}%` : scans.length ? "None found" : "Not scanned"}</strong></div></div>}

    <div className="cluster-scan-toolbar"><div><strong>{scanning ? `Checking wallet ${Math.min(scans.length + 1, scanTarget)} of ${scanTarget}…` : scans.length ? `${scans.length} wallets scanned · ${verifiedCount} verified receipts` : "Follow the transfers, not just the balances."}</strong><small>{scanning ? "Matches appear as each batch is verified." : "Direct token transfers + earliest indexed NEAR funding."}</small></div><div className="cluster-scan-actions"><label><span className="sr-only">Wallet scan depth</span><select value={scanLimit} disabled={scanning} onChange={(event) => setScanLimit(Number(event.target.value))}><option value={CLUSTER_POLICY.quickWallets}>Top 24 wallets</option><option value={CLUSTER_POLICY.deepWallets}>Top 80 wallets</option></select></label>{scanning ? <button type="button" className="cluster-scan-stop" onClick={stop}><X size={13} /> Stop</button> : <button type="button" className="cluster-analyze-button" disabled={!data || loading} onClick={analyze}><Search size={13} /> {scans.length ? "Rescan" : "Analyze connections"}</button>}</div></div>
    {scanning && <div className="cluster-progress" role="progressbar" aria-valuemin={0} aria-valuemax={scanTarget} aria-valuenow={scans.length}><span style={{ width: `${scanTarget ? scans.length / scanTarget * 100 : 0}%` }} /></div>}
    {scanError && <div className="cluster-inline-warning"><CircleAlert size={13} />{scanError}</div>}
    {view === "connections" && <div className="cluster-link-filters"><label><input type="checkbox" checked={includeTransfers} onChange={(event) => setIncludeTransfers(event.target.checked)} /><i className="direct-key" /> Token transfers</label><label><input type="checkbox" checked={includeFunding} onChange={(event) => setIncludeFunding(event.target.checked)} /><i className="funding-key" /> Shared funding <span>heuristic</span></label><span className="cluster-tip-text">Select a bubble or line to inspect evidence.</span></div>}

    <div className="bubble-canvas-wrap" ref={boxRef} style={{ minHeight: size.h }}>
      {loading && !data && <div className="chart-loading"><LoaderCircle size={22} className="spin-icon" /><span>Reading the holder snapshot…</span></div>}
      {error && <div className="cluster-canvas-error"><CircleAlert size={20} /><span>{error}</span></div>}
      {data && <svg width="100%" height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} role="img" aria-label={`${symbol} ${view === "connections" ? "receipt-backed holder connections" : "holder distribution"}`}>
        <defs><radialGradient id={`shine-${uniqueId}`} cx="34%" cy="28%" r="75%"><stop offset="0%" stopColor="#ffffff" stopOpacity="0.19" /><stop offset="100%" stopColor="#ffffff" stopOpacity="0" /></radialGradient><marker id={`arrow-${uniqueId}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1L7 4L1 7" fill="none" stroke="#9acfd6" strokeWidth="1.2" /></marker></defs>
        {view === "connections" && graph.edges.map((edge) => {
          const coordinates = edgeCoordinates(edge); if (!coordinates) return null;
          const focused = !focusedAccounts || focusedAccounts.has(edge.source) && focusedAccounts.has(edge.target);
          return <g key={edge.id} className="cluster-edge" role="button" tabIndex={0} aria-label={`${edge.kind === "shared_funding" ? "Funding" : "Token transfer"}: ${edge.source} to ${edge.target}; ${edge.evidenceIds.length} verified receipt(s)`} onClick={() => select({ type: "edge", id: edge.id })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select({ type: "edge", id: edge.id }); } }}><title>{edge.source} → {edge.target} · {edge.evidenceIds.length} verified receipt(s)</title><line {...coordinates} stroke="transparent" strokeWidth="13" /><line {...coordinates} stroke={edge.kind === "shared_funding" ? "#aea3f2" : "#96d9d2"} strokeWidth={selectedEdge?.id === edge.id ? 2.6 : 1.4} strokeDasharray={edge.kind === "shared_funding" ? "5 5" : undefined} opacity={focused ? 0.8 : 0.12} markerEnd={`url(#arrow-${uniqueId})`} pointerEvents="none" /></g>;
        })}
        {nodes.map((node) => {
          const color = view === "connections" && node.clusterId ? colors.get(node.clusterId)! : node.holder ? PALETTE[node.holder.kind] : "#a6aac2";
          const active = hover === node.account || selectedNode?.account === node.account;
          const dimmed = focusedAccounts && !focusedAccounts.has(node.account);
          return <g key={node.account} className="bubble-node" role="button" tabIndex={0} aria-label={node.holder ? `${node.account}, ${node.holder.percent.toFixed(3)}% of supply. Inspect wallet.` : `Funding source ${node.account}. Inspect receipts.`} onMouseEnter={() => setHover(node.account)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(node.account)} onBlur={() => setHover(null)} onClick={() => select({ type: "wallet", id: node.account })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select({ type: "wallet", id: node.account }); } }} opacity={dimmed ? 0.22 : 1}>
            <title>{node.account}{node.holder ? ` · ${node.holder.percent.toFixed(4)}%` : " · External funding source (not a holder)"}</title>
            {node.holder ? <><circle cx={node.x} cy={node.y} r={node.r} fill={color} fillOpacity={active ? 0.36 : 0.15} stroke={active ? "#eef3ff" : color} strokeWidth={active ? 2 : 1.1} /><circle cx={node.x} cy={node.y} r={node.r} fill={`url(#shine-${uniqueId})`} pointerEvents="none" />{node.r > 20 && <text x={node.x} y={node.y + (node.r > 34 ? -1 : 3)} textAnchor="middle" fill={color} fontSize={Math.min(12, node.r / 2.9)} fontWeight="600" pointerEvents="none">{node.holder.percent.toFixed(1)}%</text>}{node.r > 34 && <text x={node.x} y={node.y + 13} textAnchor="middle" fill={color} opacity="0.75" fontSize="7.5" pointerEvents="none">{node.clusterId && view === "connections" ? "CONNECTED" : node.holder.label || `#${node.holder.rank}`}</text>}</> : <><path d={`M${node.x} ${node.y - 12}L${node.x + 12} ${node.y}L${node.x} ${node.y + 12}L${node.x - 12} ${node.y}Z`} fill="#181f30" stroke={active ? "#ffffff" : color} strokeWidth="1.5" /><text x={node.x} y={node.y + 25} textAnchor="middle" fill="#a9afca" fontSize="7.5" pointerEvents="none">FUNDER</text></>}
          </g>;
        })}
      </svg>}
      {hoverNode && <div className="bubble-tip"><strong>{hoverNode.holder?.label || shortAddress(hoverNode.account)}</strong><span className="bubble-tip-acct">{hoverNode.account}</span><div><span>{hoverNode.holder ? "Share of supply" : "Role"}</span><b>{hoverNode.holder ? `${hoverNode.holder.percent.toFixed(3)}%` : "External funder"}</b></div><div><span>History</span><b>{scans.find((scan) => scan.account === hoverNode.account)?.status || "Not scanned"}</b></div></div>}
      {view === "connections" && !scanning && !scans.length && data && <div className="cluster-start-note"><GitBranch size={15} /><span>No invented links. Run a scan to reveal verified connections.</span></div>}
    </div>

    {view === "connections" ? <div className="bubble-legend cluster-connection-legend"><span><i className="direct-key" /> Solid = token transfer</span><span><i className="funding-key" /> Dashed = shared-funder hypothesis</span><span><i className="funder-key" /> Diamond = external funder</span><span>Color = connected component, not an identity</span></div> : <div className="bubble-legend">{([["named", "Named wallet"], ["implicit", "Implicit wallet"], ["evm", "EVM-format account"], ["pool", "Pool / locker"], ["bridge", "Bridge / contract"]] as [HolderKind, string][]).map(([kind, label]) => <span key={kind}><i style={{ background: PALETTE[kind] }} />{label}</span>)}</div>}

    {view === "connections" && <>
      {graph.clusters.length > 0 && <div className="cluster-list"><div className="cluster-list-heading"><span>CONNECTED GROUPS</span><small>Combined current holdings · share of total supply</small></div>{graph.clusters.map((cluster, index) => <button type="button" key={cluster.id} className={`cluster-list-item ${selectedCluster?.id === cluster.id ? "selected" : ""}`} onClick={() => select({ type: "cluster", id: cluster.id })}><i style={{ background: colors.get(cluster.id) }} /><span><strong>Cluster {String(index + 1).padStart(2, "0")}</strong><small>{cluster.members.length} holders · {cluster.directTransfers} transfer / {cluster.fundingTransfers} funding receipts</small></span><b>{cluster.percent.toFixed(2)}%</b><ArrowRight size={14} /></button>)}</div>}
      {!!scans.length && !scanning && !graph.clusters.length && <div className="cluster-empty"><GitBranch size={19} /><div><strong>No connections found in this scanned sample.</strong><p>{hasIncomplete || scanError ? "Some history was incomplete. This is not an all-clear or proof that the wallets are unrelated." : "The selected signals did not connect these wallets. Missing links do not prove independence."}</p></div></div>}
      {selection && <div className="cluster-detail"><div className="cluster-detail-head"><span>{selectedCluster ? "CLUSTER EVIDENCE" : selectedEdge ? "CONNECTION EVIDENCE" : "WALLET DETAILS"}</span><button type="button" aria-label="Clear selection" onClick={() => select(null)}><X size={14} /></button></div>{selectedNode && <><a className="cluster-wallet-link" href={`https://nearblocks.io/address/${selectedNode.account}`} target="_blank" rel="noreferrer">{selectedNode.account} <ArrowUpRight size={14} /></a><p>{selectedNode.holder ? `${fromUnits(selectedNode.holder.balance, data?.decimals || 0, 4)} ${symbol} · ${selectedNode.holder.percent.toFixed(4)}% of supply` : "External funding source. Its balance is not included in cluster holdings."}</p></>}{selectedCluster && <><strong>{selectedCluster.members.length} holders · {selectedCluster.percent.toFixed(2)}% of total supply</strong><div className="cluster-member-chips">{selectedCluster.members.map((account) => <button key={account} type="button" title={account} onClick={() => select({ type: "wallet", id: account })}>{shortAddress(account)}</button>)}</div></>}{selectedEdge && <strong>{shortAddress(selectedEdge.source)} → {shortAddress(selectedEdge.target)}</strong>}<span className="cluster-detail-caution">A transfer is observed fact. Common funding or a shared color is not proof of common ownership.</span></div>}
      {proofItems.length > 0 && <div className="cluster-evidence"><div className="cluster-list-heading"><span><ShieldCheck size={12} /> VERIFIED TRANSACTION EVIDENCE</span><small>{proofItems.length} receipts</small></div>{proofItems.slice(0, expandedEvidence ? proofItems.length : 8).map((item) => <EvidenceRow key={item.id} item={item} decimals={data?.decimals || 0} symbol={symbol} />)}{proofItems.length > 8 && <button type="button" className="cluster-more-evidence" onClick={() => setExpandedEvidence(!expandedEvidence)}>{expandedEvidence ? "Show fewer receipts" : `Show all ${proofItems.length} receipts`}</button>}</div>}
      {!!scans.length && <details className="cluster-audit"><summary><Info size={13} /> Scan coverage & excluded sources <span>{hasIncomplete ? "Partial history" : "Bounded sample"}</span></summary><p>Scanned {scans.length} of {eligibleCount} indexed non-infrastructure holders. {scans.filter((scan) => scan.status === "complete").length} scans completed without truncation; {scans.filter((scan) => scan.status === "partial").length} were partial; {scans.filter((scan) => scan.status === "unavailable").length} were unavailable; {scans.filter((scan) => scan.status === "excluded").length} were excluded.</p><p>Token history: up to {CLUSTER_POLICY.tokenRowsPerWallet} events per wallet in {CLUSTER_POLICY.lookbackDays} days. Funding: the earliest explicit incoming NEAR transfer in the first {CLUSTER_POLICY.fundingRowsPerWallet} indexed incoming events ≥ 0.1 NEAR. Neither is a full-lifetime audit. Source screen: up to {CLUSTER_POLICY.sourceRows} outgoing funding events; {CLUSTER_POLICY.highFanoutRecipients}+ distinct recipients triggers exclusion. Unknown services can still slip through.</p><p>Candidate checks: {batches.reduce((sum, batch) => sum + batch.verification.rejected, 0)} failed/bulk candidates excluded; {batches.reduce((sum, batch) => sum + batch.verification.unavailable, 0)} could not be receipt-verified. History may be cached for 5 minutes.</p>{exclusions.length > 0 && <ul>{exclusions.map((item) => <li key={item.account}><a href={`https://nearblocks.io/address/${item.account}`} target="_blank" rel="noreferrer">{shortAddress(item.account)}</a><span>{item.reason}</span></li>)}</ul>}{scans.filter((scan) => scan.note).map((scan) => <p className="scan-wallet-note" key={scan.account}>{shortAddress(scan.account)}: {scan.note}</p>)}</details>}
    </>}

    <div className="bubble-note"><ShieldCheck size={15} /><p>Balances: {data?.source || "on-chain indexer"}. Supply: final token-contract read ({data ? compactNumber(Number(fromUnits(data.totalSupply, data.decimals, 4))) : "—"} {symbol}). Top {data?.holders.length || 100} indexed holders; infrastructure excluded from wallet figures. Small bubbles have a minimum display size. Connections require successful executed receipts; zero links is not a safety rating. Shared funding is a hypothesis, not a sybil verdict.</p></div>
    <a className="inline-link bubble-link" href={`https://nearblocks.io/token/${token}#holders`} target="_blank" rel="noreferrer">Verify on NearBlocks <ArrowUpRight size={15} /></a>
  </section>;
}
