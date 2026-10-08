import type { ReactNode } from 'react';
import { NavigationGuardContext, useNavigationGuards } from '../hooks/useNavigationGuards';

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const registration = useNavigationGuards();
  return <NavigationGuardContext.Provider value={registration}>{children}</NavigationGuardContext.Provider>;
}
