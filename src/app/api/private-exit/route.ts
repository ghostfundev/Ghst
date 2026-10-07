import { toUnits } from "@/lib/format";
import { classifyZcashAddress, confidentialAvailable, exitStatus, quoteExit } from "@/lib/intents";

export const dynamic = "force-dynamic";

const NEAR_ACCOUNT = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export async function GET(request: Request) {
  const depositAddress = new URL(request.url).searchParams.get("depositAddress");
  if (!depositAddress || depositAddress.length > 120) {
    return Response.json({ error: "Invalid deposit address." }, { status: 400 });
  }
  try {
    return Response.json(await exitStatus(depositAddress), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not read the status." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const recipient = String(body.recipient || "").trim();
    const refundTo = String(body.refundTo || "").trim();
    const kind = classifyZcashAddress(recipient);

    if (kind === "invalid") {
      return Response.json({ error: "Unrecognised Zcash address. Use u1… (unified), zs… (sapling) or t1…/t3… (transparent)." }, { status: 400 });
    }
    if (!NEAR_ACCOUNT.test(refundTo)) {
      return Response.json({ error: "Invalid NEAR refund account." }, { status: 400 });
    }

    const amountYocto = toUnits(String(body.amount ?? ""), 24);
    if (BigInt(amountYocto) > 100_000n * 10n ** 24n) {
      return Response.json({ error: "Amount is too large." }, { status: 400 });
    }

    const slippage = Number(body.slippage ?? 1);
    if (!Number.isFinite(slippage) || slippage < 0.1 || slippage > 10) {
      return Response.json({ error: "Slippage must be between 0.1% and 10%." }, { status: 400 });
    }

    const quote = await quoteExit({
      amountYocto, recipient, refundTo,
      slippageBps: Math.round(slippage * 100),
      dry: body.dry !== false,
      confidential: Boolean(body.confidential),
    });

    return Response.json({
      ...quote,
      addressKind: kind,
      shielded: kind === "unified" || kind === "sapling",
      confidentialAvailable: confidentialAvailable(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Quote failed." }, { status: 422 });
  }
}
