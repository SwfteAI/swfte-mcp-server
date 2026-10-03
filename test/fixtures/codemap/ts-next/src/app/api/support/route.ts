import { NextRequest, NextResponse } from 'next/server';
import { chatSupportAgent } from '@/swfte/support-agent';

/** POST /api/support — the help-centre chat box posts here. */
export async function POST(req: NextRequest) {
  const { message, conversationId, visitor } = (await req.json()) as {
    message: string;
    conversationId?: string;
    visitor: string;
  };

  const res = await chatSupportAgent(
    { message, conversationId },
    { userId: visitor },
  );

  return NextResponse.json({ reply: res.reply ?? '', ok: res.ok });
}
