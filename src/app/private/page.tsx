import type { Metadata } from "next";
import { PrivateExit } from "@/components/private-exit";

export const metadata: Metadata = {
  title: "Private Exit — NEAR to shielded ZEC | GHOSTFUN",
  description: "Route NEAR into native Zcash and settle directly into a shielded address, powered by NEAR Intents and Zcash's zk-SNARK pool.",
};

export default function PrivatePage() {
  return <PrivateExit />;
}
