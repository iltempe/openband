// Chat state for the panel (kept apart from the agent, which loads the SDK only when needed).
import { create } from 'zustand';

export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'note';
  text: string;
  /** The undo step this turn produced (its commands are listed under it in the panel). */
  txId?: string;
  cost?: number;
  tools?: number;
}

interface ChatState {
  items: ChatItem[];
  busy: boolean;
  /** Text streaming in for the current answer. */
  live: string;
  total: number;
}
export const useChat = create<ChatState>(() => ({ items: [], busy: false, live: '', total: 0 }));
