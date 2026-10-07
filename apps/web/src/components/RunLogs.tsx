import { useState } from 'react';
import type { LogEntry } from '@mmt/contracts';
import { Empty } from './Feedback';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

export function RunLogs({ entries }: { entries: LogEntry[] }) {
  const [level, setLevel] = useState('');
  return (
    <>
      <label className="chart-selector">
        <span>{text.logsLevel}</span>
        <select
          aria-label={text.logsLevel}
          value={level}
          onChange={(event) => setLevel(event.target.value)}
        >
          <option value="">{text.allStatus}</option>
          {['info', 'warning', 'error'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      {entries.length ? (
        <div className="log-view" role="log" aria-label={text.logs}>
          {entries
            .filter((entry) => !level || entry.level === level)
            .map((entry, index) => (
              <div className={`log-entry log-${entry.level}`} key={`${entry.timestamp}-${index}`}>
                <time>{formatDate(entry.timestamp)}</time>
                <span className="log-level">{entry.level}</span>
                <span>{entry.message}</span>
              </div>
            ))}
        </div>
      ) : (
        <Empty>{text.noLogs}</Empty>
      )}
    </>
  );
}
