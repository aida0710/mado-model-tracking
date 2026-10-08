import type { LogEntry } from '@mmt/contracts';

// Jobs list and Run logs.
export const jobsText = {
  jobColumn: 'Job',
  jobRunColumn: 'Run',
  jobActions: '操作',
  logLevelAll: 'すべてのレベル',
} as const;

export const logLevelLabels: Record<LogEntry['level'], string> = {
  info: '情報',
  warning: '警告',
  error: 'エラー',
};
