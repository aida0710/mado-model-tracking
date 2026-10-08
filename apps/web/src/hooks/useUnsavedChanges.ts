import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { UnsavedChangesAction } from '../types/navigationGuard';
import { NavigationGuardContext } from './useNavigationGuards';

export function useUnsavedChanges(isDirty: boolean, isBusy: boolean, { onNavigationDiscard }: {
  onNavigationDiscard: () => void;
}) {
  const registration = useContext(NavigationGuardContext);
  if (!registration) throw new Error('NavigationGuardProvider is required');
  const { registerGuard, removeGuard } = registration;
  const id = useId();
  const [pendingAction, setPendingAction] = useState<UnsavedChangesAction | null>(null);
  const navigationDiscardRef = useRef(onNavigationDiscard);
  navigationDiscardRef.current = onNavigationDiscard;
  const discardNavigation = useCallback(() => navigationDiscardRef.current(), []);
  const requestConfirmation = useCallback((action: UnsavedChangesAction) => setPendingAction(action), []);
  useLayoutEffect(() => {
    registerGuard({ id, isDirty, isBusy, requestConfirmation, discardNavigation });
  }, [id, isDirty, isBusy, registerGuard, requestConfirmation, discardNavigation]);
  useLayoutEffect(() => () => removeGuard(id), [id, removeGuard]);
  useEffect(() => {
    if (!isDirty) return;
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [isDirty]);
  function requestAction(action: () => void) {
    if (isBusy) return;
    if (isDirty) setPendingAction({ discard: action });
    else action();
  }
  function discard() {
    const action = pendingAction;
    setPendingAction(null);
    action?.discard();
  }
  function keepEditing() {
    const action = pendingAction;
    setPendingAction(null);
    action?.keepEditing?.();
  }
  return { requestAction, confirmingDiscard: !!pendingAction, discard, keepEditing };
}
