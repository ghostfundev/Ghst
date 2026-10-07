/**
 * GHOSTFUN protocol economics.
 *
 * This is YOUR margin layer. It sits on top of whatever factory/DEX the app
 * routes through, so it works today without deploying a single contract.
 *
 * Every value is overridable at build time, so you can change pricing without
 * touching code:
 *
 *   NEXT_PUBLIC_TREASURY_ACCOUNT=ghostfun.near
 *   NEXT_PUBLIC_LAUNCH_FEE_NEAR=0.05
 *   NEXT_PUBLIC_SWAP_FEE_BPS=50
 *
 * Set TREASURY_ACCOUNT to an empty string to turn the whole fee layer off.
 */

const DEFAULT_TREASURY = "";
const DEFAULT_LAUNCH_FEE_NEAR = "0.05";
const DEFAULT_SWAP_FEE_BPS = 50; // 0.50%

/** NEAR account that receives interface fees. Empty = fees disabled. */
export const TREASURY_ACCOUNT = (process.env.NEXT_PUBLIC_TREASURY_ACCOUNT ?? DEFAULT_TREASURY).trim();

/** Flat fee charged per launch, in whole NEAR (string to avoid float drift). */
export const LAUNCH_FEE_NEAR = (process.env.NEXT_PUBLIC_LAUNCH_FEE_NEAR ?? DEFAULT_LAUNCH_FEE_NEAR).trim();

/** Interface fee on the NEAR side of a buy, in basis points (100 = 1%). */
export const SWAP_FEE_BPS = (() => {
  const parsed = Number(process.env.NEXT_PUBLIC_SWAP_FEE_BPS ?? DEFAULT_SWAP_FEE_BPS);
  // Hard ceiling of 2% so a bad env value can never quietly overcharge users.
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 200 ? Math.round(parsed) : DEFAULT_SWAP_FEE_BPS;
})();

export const feesEnabled = (): boolean => TREASURY_ACCOUNT.length > 0;

/** Launch fee in yoctoNEAR, or "0" when the fee layer is off. */
export function launchFeeYocto(): string {
  if (!feesEnabled()) return "0";
  const [whole, fraction = ""] = LAUNCH_FEE_NEAR.split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return "0";
  const padded = (fraction + "0".repeat(24)).slice(0, 24);
  return (BigInt(whole || "0") * 10n ** 24n + BigInt(padded || "0")).toString();
}

/**
 * Splits a buy amount into the slice that reaches the pool and the slice kept
 * as interface revenue. Always returns the full amount to the pool when the
 * fee layer is disabled.
 */
export function splitBuyAmount(grossYocto: string): { swapAmount: string; feeAmount: string } {
  const gross = BigInt(grossYocto);
  if (!feesEnabled() || SWAP_FEE_BPS === 0 || gross <= 0n) return { swapAmount: gross.toString(), feeAmount: "0" };
  const fee = (gross * BigInt(SWAP_FEE_BPS)) / 10000n;
  return { swapAmount: (gross - fee).toString(), feeAmount: fee.toString() };
}

export const swapFeePercentLabel = (): string => `${(SWAP_FEE_BPS / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
