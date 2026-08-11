import { NextResponse } from "next/server";
import { getLatencyDistribution } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);
const VALID_GROUPBY = new Set(["model", "provider"]);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const groupBy = searchParams.get("groupBy") || "model";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    if (!VALID_GROUPBY.has(groupBy)) {
      return NextResponse.json({ error: "Invalid groupBy" }, { status: 400 });
    }

    const data = await getLatencyDistribution(period, groupBy);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get latency distribution:", error);
    return NextResponse.json({ error: "Failed to fetch latency distribution" }, { status: 500 });
  }
}
