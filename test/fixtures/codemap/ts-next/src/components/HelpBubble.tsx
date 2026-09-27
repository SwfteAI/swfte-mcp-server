'use client';

import { ChatWidget } from '@swfte/chat-widget/react';

/** Floating help bubble on every docs page. */
export function HelpBubble({ theme }: { theme: 'light' | 'dark' }) {
  return <ChatWidget agentId="ag_Docs2W" position="bottom-right" theme={theme} greeting="Questions about the docs?" />;
}
