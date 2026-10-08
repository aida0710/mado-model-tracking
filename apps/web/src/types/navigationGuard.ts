export interface UnsavedChangesAction {
  discard: () => void;
  keepEditing?: () => void;
}

export interface NavigationGuard {
  id: string;
  isDirty: boolean;
  isBusy: boolean;
  requestConfirmation: (action: UnsavedChangesAction) => void;
  discardNavigation: () => void;
}

export interface NavigationGuardRegistration {
  registerGuard: (guard: NavigationGuard) => void;
  removeGuard: (id: string) => void;
}
