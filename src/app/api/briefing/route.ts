import { NextRequest, NextResponse } from "next/server";
import { runBriefing } from "@/lib/briefing";

export const runtime = "nodejs";
export const maxDuration = 60; // briefing mode makes several sequential model calls

export async function POST(req: NextRequest) {
  try {
    const { topic } = await req.json();
    if (!topic || typeof topic !== "string" || !topic.trim()) {
      return NextResponse.json(
        { error: "Missing 'topic' in request body." },
        { status: 400 }
      );
    }
    const result = await runBriefing(topic.trim());
    return NextResponse.json(result);
  } catch (err) {
    console.error("briefing route error:", err);
    return NextResponse.json(
      { error: "Something went wrong building that briefing." },
      { status: 500 }
    );
  }
}
