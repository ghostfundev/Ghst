import { fromUnits, toUnits } from "@/lib/format";
import { bestQuote, discoverPools, getMarket, getTax, getTokenDecimals, isValidToken, WNEAR } from "@/lib/near";
import { SWAP_FEE_BPS, splitBuyAmount } from "@/lib/protocol";
import type { TradeQuote } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const token = params.get("token") || "";
    const side = params.get("side");
    const amount = params.get("amount") || "";
    const slippage = Number(params.get("slippage") || "1");
    if (!isValidToken(token) || (side !== "buy" && side !== "sell")) {
      return Response.json({ error: "Invalid token or trade direction." }, { status: 400 });
    }
    if (!Number.isFinite(slippage) || slippage < 0.1 || slippage > 10) {
      return Response.json({ error: "Slippage must be between 0.1% and 10%." }, { status: 400 });
    }
    const market = await getMarket(token);
    if (!market || market.quote !== WNEAR || !market.poolId) {
      return Response.json({ error: "This NEAR pool is not available." }, { status: 404 });
    }
    const [tokenDecimals, tax] = await Promise.all([getTokenDecimals(token), getTax(market.id)]);
    const amountInRaw = toUnits(amount, side === "buy" ? 24 : tokenDecimals);
    const raw = BigInt(amountInRaw);
    if (raw > 10n ** 36n) return Response.json({ error: "Amount is too large." }, { status: 400 });
    const buyTaxBps = Number(tax?.buy_bps) || 0;
    const sellTaxBps = Number(tax?.sell_bps) || 0;
    // The interface fee is taken off the NEAR side of a buy before it reaches the pool.
    const { swapAmount, feeAmount } = side === "buy" ? splitBuyAmount(amountInRaw) : { swapAmount: amountInRaw, feeAmount: "0" };
    const quoteInput = side === "sell" ? raw * BigInt(10000 - sellTaxBps) / 10000n : BigInt(swapAmount);
    if (quoteInput <= 0n) throw new Error("Amount after tax is too small.");
    const outputToken = side === "buy" ? token : WNEAR;
    const inputToken = side === "buy" ? WNEAR : token;
    const outputDecimals = side === "buy" ? tokenDecimals : 24;
    // Route across every Rhea fee tier and take the best fill, instead of
    // assuming the 1% pool the token launched in.
    const pools = await discoverPools(token, WNEAR);
    const candidates = pools.length ? pools : [{ poolId: market.poolId, fee: 10000 }];
    const routed = await bestQuote(candidates, inputToken, outputToken, quoteInput.toString());
    if (!routed) throw new Error("No pool could quote this amount.");
    const gross = routed.amount;
    const slippageBps = Math.round(slippage * 100);
    const minimumGross = gross * BigInt(10000 - slippageBps) / 10000n;
    const net = side === "buy" ? gross * BigInt(10000 - buyTaxBps) / 10000n : gross;
    const minimumNet = side === "buy" ? minimumGross * BigInt(10000 - buyTaxBps) / 10000n : minimumGross;
    const notional = side === "buy" ? Number(amount) / market.priceNear : Number(amount) * market.priceNear;
    const fairAfterFees = notional * (1 - routed.fee / 1_000_000) * (side === "buy" ? (1 - buyTaxBps / 10000) : (1 - sellTaxBps / 10000));
    const actual = Number(fromUnits(net, outputDecimals, Math.min(outputDecimals, 12)));
    const priceImpact = fairAfterFees > 0 && Number.isFinite(fairAfterFees) ? Math.max(0, Math.min(99, (1 - actual / fairAfterFees) * 100)) : null;
    const quote: TradeQuote = {
      token, side, poolId: routed.poolId, feeTier: routed.fee, poolsChecked: candidates.length,
      amountInRaw, quoteInputRaw: quoteInput.toString(),
      swapAmountRaw: swapAmount, interfaceFeeRaw: feeAmount,
      interfaceFee: fromUnits(feeAmount, 24, 5), interfaceFeeBps: side === "buy" ? SWAP_FEE_BPS : 0,
      outputRaw: gross.toString(), minOutputRaw: minimumGross.toString(),
      output: fromUnits(net, outputDecimals, side === "buy" ? 4 : 6),
      minimum: fromUnits(minimumNet, outputDecimals, side === "buy" ? 4 : 6),
      inputSymbol: side === "buy" ? "NEAR" : market.symbol,
      outputSymbol: side === "buy" ? market.symbol : "wNEAR",
      tokenDecimals, buyTaxBps, sellTaxBps, slippageBps, priceImpact,
    };
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Rhea quote unavailable." }, { status: 422 });
  }
}
