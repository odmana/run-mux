export {
  addChild,
  AppStateSchema,
  ChildRecordSchema,
  clearChildren,
  emptyState,
  listChildren,
  loadState,
  loadUi,
  mergeUi,
  mutateState,
  removeChild,
  saveState,
  setChildren,
  TargetRecordSchema,
  UiStateSchema,
  updateState,
} from './state.js';

export {
  allocateSlot,
  listSlots,
  MAIN_SLOT,
  releaseSlot,
  resetSlotIndex,
  slotFor,
} from './slots.js';

export {
  aliasMap,
  createTarget,
  getTarget,
  isTargetAvailable,
  listTargets,
  removeTarget,
  resolveTarget,
  slugFor,
  slugify,
} from './targets.js';

export type {
  CheckoutHint,
  CreateTargetInput,
  CreateTargetResult,
  ResolveTargetResult,
} from './targets.js';
