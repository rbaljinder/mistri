/** What AssistantMemoryDrawer says, in the shell room. */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  memory: 'Memory',
  memoryTitle: 'Assistant memory',
  memoryDescription: 'Durable notes carried across conversations. Edit or remove anything at any time.',
  memoryQuota: '{used} / {max}',
  memoryFilter: 'Filter memories',
  memoryFilterPlaceholder: 'Filter memories…',
  memoryFilterEmpty: 'No memories match “{query}”.',
  memoryPersonal: 'Personal',
  memoryShared: 'Shared workspace',
  memoryPlaceholder: 'Add a preference or workspace fact…',
  memorySave: 'Save',
  memoryCancel: 'Cancel',
  memoryAdd: 'Add memory',
  memoryEmpty: 'Nothing saved yet. The assistant can remember preferences as you work, or you can add notes here.',
  memorySourceAssistant: 'Assistant',
  memorySourcePerson: 'You',
  memoryToday: 'Today',
  memoryLoading: 'Loading memory…',
  memoryLoadError: 'Could not load memory: {message}',
  memorySaveError: 'Could not save memory: {message}',
  memoryReadOnlyShared: 'Only workspace editors can change shared notes.',
  closeMemory: 'Close memory',
  edit: 'Edit',
  delete: 'Delete',
});
