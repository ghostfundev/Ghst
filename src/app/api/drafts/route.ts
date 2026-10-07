import { db } from "@/db";
import { launchDrafts } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

function validVisitor(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(value);
}

export async function GET(request: Request) {
  const visitorId = new URL(request.url).searchParams.get("visitorId");
  if (!validVisitor(visitorId)) return Response.json({ error: "Invalid visitor ID." }, { status: 400 });
  try {
    const rows = await db.select({ draft: launchDrafts.draft, updatedAt: launchDrafts.updatedAt }).from(launchDrafts).where(eq(launchDrafts.visitorId, visitorId)).limit(1);
    return Response.json({ draft: rows[0]?.draft || null, updatedAt: rows[0]?.updatedAt || null });
  } catch {
    return Response.json({ error: "Draft could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!validVisitor(body.visitorId) || !body.draft || typeof body.draft !== "object" || Array.isArray(body.draft)) {
      return Response.json({ error: "Invalid draft." }, { status: 400 });
    }
    if (JSON.stringify(body.draft).length > 40000) return Response.json({ error: "Draft is too large." }, { status: 413 });
    await db.insert(launchDrafts).values({ visitorId: body.visitorId, draft: body.draft, updatedAt: new Date() })
      .onConflictDoUpdate({ target: launchDrafts.visitorId, set: { draft: body.draft, updatedAt: new Date() } });
    return Response.json({ saved: true });
  } catch {
    return Response.json({ error: "Draft could not be saved." }, { status: 503 });
  }
}
