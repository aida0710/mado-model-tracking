import {
  Archive,
  Box,
  Code,
  Database,
  FileText,
  FlaskConical,
  ListChecks,
  Network,
  Play,
  Puzzle,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { NavigationScreen } from './navigationLinks';

/** The icon each screen shows in the sidebar, the rail and the drawer. */
export const NAVIGATION_ICONS: Record<NavigationScreen, LucideIcon> = {
  experiments: FlaskConical,
  sweeps: SlidersHorizontal,
  reports: FileText,
  models: Box,
  tasks: ListChecks,
  codes: Code,
  datasets: Database,
  artifacts: Archive,
  lineage: Network,
  jobs: Play,
  hooks: Webhook,
  compute: Server,
  plugins: Puzzle,
  settings: Settings,
  administration: ShieldCheck,
};
