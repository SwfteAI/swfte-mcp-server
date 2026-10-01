// Local type stub for @swfte/chat-widget (vanilla entry point), mapped via tsconfig "paths".
export interface WidgetConfig {
  agentId: string;
  apiKey?: string;
  type?: 'bubble' | 'embedded' | 'search' | 'fullpage';
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  theme?: 'light' | 'dark' | 'auto';
  placeholder?: string;
  hotkey?: string;
  container?: string;
  greeting?: string;
}

export declare class SwfteChatWidget {
  constructor(config: WidgetConfig);
  mount(): void;
  destroy(): void;
}
