import { getHolderMap } from "@/lib/holders";
import { isValidToken } from "@/lib/near";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!isValidToken(token)) {
    return Response.json({ error: "Invalid token." }, { status: 400 });
  }
  try {
    const map = await getHolderMap(token);
    if (!map) return Response.json({ error: "Holder data is not available for this token yet." }, { status: 404 });
    return Response.json(map, { headers: { "Cache-Control": "public, max-age=45" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load holder data." }, { status: 503 });
  }
}
