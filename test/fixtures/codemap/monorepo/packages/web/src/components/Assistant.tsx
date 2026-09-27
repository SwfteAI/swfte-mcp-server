'use client';

import { ChatWidget } from '@swfte/chat-widget/react';

export function Assistant() {
  return (
    <ChatWidget
      agentId="ag_Docs2W"
      position="bottom-right"
      greeting="Need help with the docs?"
    />
  );
}
