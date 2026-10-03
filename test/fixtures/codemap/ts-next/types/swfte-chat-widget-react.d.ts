// Local type stub for @swfte/chat-widget/react, mapped via tsconfig "paths".
export interface ChatWidgetProps {
  agentId: string;
  apiKey?: string;
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  theme?: 'light' | 'dark' | 'auto';
  greeting?: string;
  onMessage?: (message: { role: string; content: string }) => void;
}

export interface EmbeddedChatProps {
  agentId: string;
  apiKey?: string;
  height?: string;
  welcomeMessage?: string;
}

export declare function ChatWidget(props: ChatWidgetProps): JSX.Element;
export declare function EmbeddedChat(props: EmbeddedChatProps): JSX.Element;
