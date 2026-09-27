'use client';

import { useEffect } from 'react';
import { SwfteChatWidget } from '@swfte/chat-widget';

/** Cmd+K search palette backed by the docs agent. Mounted once in the root layout. */
export function SearchPalette() {
  useEffect(() => {
    const widget = new SwfteChatWidget({ agentId: 'ag_Docs2W', type: 'search', hotkey: 'cmd+k', placeholder: 'Search the docs…' });
    widget.mount();
    return () => widget.destroy();
  }, []);
  return null;
}
