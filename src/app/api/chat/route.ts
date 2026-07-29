import { NextRequest, NextResponse } from "next/server";
import { askQuestion } from "@/lib/ask";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json();
    if (!question || typeof question !== "string" || !question.trim()) {
      return NextResponse.json(
        { error: "Missing 'question' in request body." },
        { status: 400 }
      );
    }
    const result = await askQuestion(question.trim());
    return NextResponse.json(result);
  } catch (err) {
    console.error("chat route error:", err);
    return NextResponse.json(
      { error: "Something went wrong answering that question." },
      { status: 500 }
    );
  }
}
