import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, type Blocker } from 'react-router-dom';
import type { NavigationGuard, NavigationGuardRegistration } from '../types/navigationGuard';

export const NavigationGuardContext = createContext<NavigationGuardRegistration | null>(null);

export function useNavigationGuards(): NavigationGuardRegistration {
  const [guards, setGuards] = useState<NavigationGuard[]>([]);
  const registerGuard = useCallback((guard: NavigationGuard) => {
    setGuards((previous) => previous.some((item) => item.id === guard.id)
      ? previous.map((item) => item.id === guard.id ? guard : item)
      : [...previous, guard]);
  }, []);
  const removeGuard = useCallback((id: string) => {
    setGuards((previous) => previous.filter((guard) => guard.id !== id));
  }, []);
  // React Router supports one blocker; nested editors register their guards here.
  const blocker = useBlocker(guards.some((guard) => guard.isDirty || guard.isBusy));
  const settledBlocker = useRef<Blocker | null>(null);
  useEffect(() => {
    if (blocker.state !== 'blocked' || settledBlocker.current === blocker || guards.some((guard) => guard.isBusy)) return;
    function continueNavigation() {
      if (settledBlocker.current === blocker || blocker.state !== 'blocked') return;
      // Closing guards can render before the router publishes its proceeding state.
      settledBlocker.current = blocker;
      guards.forEach((item) => item.discardNavigation());
      blocker.proceed();
    }
    const guard = [...guards].reverse().find((item) => item.isDirty);
    if (!guard) {
      continueNavigation();
      return;
    }
    guard.requestConfirmation({
      discard: continueNavigation,
      keepEditing: () => {
        if (settledBlocker.current === blocker) return;
        settledBlocker.current = blocker;
        blocker.reset();
      },
    });
  }, [blocker, guards]);
  return useMemo(() => ({ registerGuard, removeGuard }), [registerGuard, removeGuard]);
}
