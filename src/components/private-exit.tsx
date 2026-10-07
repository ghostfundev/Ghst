"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CircleAlert, Clock3, Copy, EyeOff, Info, LoaderCircle, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import { useWallet } from "@/components/providers";

type Quote = {
  amountInFormatted: string; amountInUsd: string;
  amountOutFormatted: string; amountOutUsd: string;
  minAmountOut: string; timeEstimate: number; withdrawFee: string;
  depositAddress?: string; addressKind: string; shielded: boolean;
  confidentialAvailable: boolean; error?: string;
};

export function PrivateExit() {
  const { accountId, connect, sendTransaction } = useWallet();
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [deposit, setDeposit] = useState("");
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);

  // Live dry quote as the user types.
  useEffect(() => {
    setQuote(null); setError("");
    if (!amount || !address.trim() || Number(amount) <= 0) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/private-exit", {
          method: "POST", headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ amount, recipient: address.trim(), refundTo: accountId || "ghostfun.near", slippage: 1, dry: true }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Quote failed.");
        setQuote(data);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Quote failed.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [amount, address, accountId]);

  // Poll settlement once a deposit is in flight.
  useEffect(() => {
    if (!deposit) return;
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`/api/private-exit?depositAddress=${encodeURIComponent(deposit)}`);
        const data = await response.json();
        if (data.status) setStatus(data.status);
        if (["SUCCESS", "REFUNDED", "FAILED"].includes(data.status)) clearInterval(poll);
      } catch { /* keep the previous status */ }
    }, 6000);
    return () => clearInterval(poll);
  }, [deposit]);

  const send = async () => {
    if (!accountId) { connect(); return; }
    if (!quote || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      // Re-quote live (dry: false) to obtain the real deposit address.
      const response = await fetch("/api/private-exit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, recipient: address.trim(), refundTo: accountId, slippage: 1, dry: false }),
      });
      const fresh = await response.json();
      if (!response.ok) throw new Error(fresh.error || "Quote failed.");
      if (!fresh.depositAddress) throw new Error("NEAR Intents did not return a deposit address. Please try again.");

      setNotice("Setujui transfer di wallet NEAR kamu.");
      const yocto = (BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 18n).toString();
      await sendTransaction({ receiverId: fresh.depositAddress, actions: [{ type: "Transfer", params: { deposit: yocto } }] });
      setDeposit(fresh.depositAddress);
      setStatus("PENDING_DEPOSIT");
      setNotice("Sent. The solver is processing — usually 2-3 minutes.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction was not completed.");
      setNotice("");
    } finally { setBusy(false); }
  };

  const kindLabel = quote?.addressKind === "unified" ? "Unified (shielded)"
    : quote?.addressKind === "sapling" ? "Sapling (shielded)"
    : quote?.addressKind === "transparent" ? "Transparan — TIDAK privat" : "";

  return <main className="inner-page"><div className="inner-page-aura" /><div className="content-width privacy-content">
    <div className="breadcrumbs"><Link href="/"><ArrowLeft size={14} /> Home</Link><span>/</span><strong>Private exit</strong></div>

    <div className="privacy-heading">
      <div>
        <span className="eyebrow"><span className="tiny-line" /> PRIVACY RAIL</span>
        <h1>Exit quietly.<br /><span>Settle shielded.</span></h1>
        <p>Route NEAR into native ZEC and land it directly in a Zcash shielded address. Privacy comes from Zcash&apos;s audited zk-SNARK pool and NEAR&apos;s solver network — not from anything we invented.</p>
      </div>
      <div className="privacy-badge"><span><EyeOff size={18} /></span><b>Powered by NEAR Intents</b><small>$1.5B+ ZEC settled on these rails</small></div>
    </div>

    <div className="privacy-grid">
      <section className="privacy-card">
        <div className="privacy-card-head"><span className="form-step">01</span><div><h2>Where it goes</h2><p>Your Zcash address and amount.</p></div></div>
        <div className="form-card-body">
          <label className="form-field"><span>Amount to exit <em>*</em></span>
            <div className="amount-with-suffix"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.0" /><span>NEAR</span></div>
            <small>Sent from your connected wallet to a one-time solver deposit address.</small>
          </label>
          <label className="form-field"><span>Zcash destination <em>*</em></span>
            <input value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="u1… (unified, recommended)" spellCheck={false} />
            <small>{kindLabel ? <strong className={quote?.shielded ? "addr-ok" : "addr-warn"}>{kindLabel}</strong> : "u1… unified · zs… sapling · t1…/t3… transparent"}</small>
          </label>
          {error && <div className="logo-error"><CircleAlert size={14} />{error}</div>}
        </div>
      </section>

      <aside className="privacy-side">
        <div className="privacy-quote-card">
          <div className="cost-head"><span>YOU RECEIVE</span><span className="cost-live"><span className="live-dot" /> LIVE</span></div>
          <div className="privacy-out">{loading ? <LoaderCircle size={24} className="spin-icon" /> : quote ? quote.amountOutFormatted : "0.0"} <small>ZEC</small></div>
          {quote && <span className="privacy-out-usd">≈ ${Number(quote.amountOutUsd).toFixed(2)}</span>}
          <div className="cost-lines">
            <div><span>Minimum received</span><strong>{quote ? (Number(quote.minAmountOut) / 1e8).toFixed(8) : "—"} ZEC</strong></div>
            <div><span>Network withdraw fee</span><strong>{quote ? (Number(quote.withdrawFee) / 1e8).toFixed(8) : "—"} ZEC</strong></div>
            <div><span>Est. settlement</span><strong>{quote ? `~${Math.ceil(quote.timeEstimate / 60)} min` : "—"}</strong></div>
            <div><span>Destination</span><strong className={quote?.shielded ? "addr-ok" : ""}>{quote ? (quote.shielded ? "Shielded ✓" : "Transparent") : "—"}</strong></div>
          </div>
          <button type="button" className="launch-submit" disabled={busy || (Boolean(accountId) && (!quote || loading))} onClick={send}>
            {busy ? <><LoaderCircle size={18} className="spin-icon" /> Confirming…</> : !accountId ? <><Wallet size={18} /> Connect Wallet</> : !quote ? "Enter details" : <>Exit to Zcash <ArrowRight size={17} /></>}
          </button>
          {notice && <div className="launch-message"><Info size={16} /><span>{notice}</span></div>}
          {deposit && <div className="launch-message success"><Check size={16} /><span>Status: <strong>{status || "…"}</strong>
            <button type="button" className="copy-inline" onClick={() => { navigator.clipboard?.writeText(deposit); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              <Copy size={12} /> {copied ? "Tersalin" : "Salin deposit address"}
            </button></span></div>}
        </div>
      </aside>
    </div>

    <section className="privacy-truth">
      <div className="privacy-truth-head"><ShieldCheck size={20} /><h2>What this does — and does not — hide</h2></div>
      <div className="privacy-truth-grid">
        <div className="truth-yes"><strong><Check size={14} /> What this hides</strong>
          <p>Once your funds are inside Zcash&apos;s shielded pool, sender, recipient and amount are encrypted using zk-SNARKs. There is no public trail linking any onward movement.</p>
        </div>
        <div className="truth-no"><strong><CircleAlert size={14} /> What stays visible</strong>
          <p>The transfer from your NEAR wallet to the solver&apos;s deposit address is <em>public</em>. An observer can see you sent NEAR, and that ZEC came out. This breaks the trail — it does not erase it.</p>
        </div>
        <div className="truth-no"><strong><CircleAlert size={14} /> This is not a mixer</strong>
          <p>NEAR Intents runs risk screening (SHIELD) and rejects funds flagged as illicit. This is an ordinary cross-chain swap into a privacy asset, not a tool for laundering stolen funds.</p>
        </div>
        <div className="truth-note"><strong><LockKeyhole size={14} /> Use a unified address (u1…)</strong>
          <p>A transparent address (t1…) gives you no privacy at all — funds land on Zcash&apos;s public ledger. A unified address routes automatically to the newest shielded pool.</p>
        </div>
      </div>
      <p className="privacy-footnote"><Clock3 size={13} /> Try a small amount first. We never store your Zcash address — the quote is passed straight to NEAR Intents and is not recorded.
        {quote && !quote.confidentialAvailable && <> Confidential Intents (NEAR&apos;s private shard) requires partner access; set <code>ONECLICK_JWT</code> to enable it.</>}
      </p>
      <a className="inline-link" href="https://docs.near-intents.org" target="_blank" rel="noreferrer">Dokumentasi NEAR Intents <ArrowUpRight size={15} /></a>
    </section>
  </div></main>;
}
