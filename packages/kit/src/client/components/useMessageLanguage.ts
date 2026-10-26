/** Subscribe at the component that reads captions, preserving its local state. */
import { useSyncExternalStore } from 'react';
import { messageLanguage, subscribeMessages } from '../messages.js';

export function useMessageLanguage() {
  return useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
}
