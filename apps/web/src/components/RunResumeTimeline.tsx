import type { RunSegment } from '@mmt/contracts';
import { StatusBadge } from './StatusBadge';
import { formatDate, formatDuration } from '../lib/format';
import { text, textTemplates } from '../i18n/catalog';

/**
 * The running segments of a resumed Run as bands on one time line, with the start, end, end
 * status and first step of each. A Run that was never resumed has one segment and shows nothing.
 */
export function RunResumeTimeline({ segments, now }: { segments: RunSegment[]; now: number }) {
  if (segments.length < 2) return null;
  const startedAt = Date.parse(segments[0]!.startedAt);
  const endOf = (segment: RunSegment) => (segment.endedAt ? Date.parse(segment.endedAt) : now);
  const span = Math.max(1, endOf(segments.at(-1)!) - startedAt);
  const percentOf = (time: number) => ((time - startedAt) / span) * 100;

  return (
    <section className="run-resume-timeline" aria-label={text.resumeTimeline}>
      <h2>{text.resumeTimeline}</h2>
      <div className="resume-track" aria-hidden="true">
        {segments.map((segment, index) => {
          const left = percentOf(Date.parse(segment.startedAt));
          return (
            <span
              key={segment.startedAt}
              className={`resume-band status-${segment.endStatus ?? 'running'}`}
              style={{ left: `${left}%`, width: `${Math.max(0.5, percentOf(endOf(segment)) - left)}%` }}
              title={textTemplates.resumeSegmentLabel(index)}
            />
          );
        })}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{text.resumeTimeline}</th>
              <th>{text.resumeSegmentStart}</th>
              <th>{text.resumeSegmentEnd}</th>
              <th>{text.duration}</th>
              <th>{text.resumeSegmentEndStatus}</th>
              <th>{text.resumeSegmentFirstStep}</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((segment, index) => (
              <tr key={segment.startedAt}>
                <td>{textTemplates.resumeSegmentLabel(index)}</td>
                <td>{formatDate(segment.startedAt)}</td>
                <td>{segment.endedAt ? formatDate(segment.endedAt) : text.resumeSegmentRunning}</td>
                <td>{formatDuration(segment.startedAt, segment.endedAt)}</td>
                <td>{segment.endStatus ? <StatusBadge status={segment.endStatus} /> : <StatusBadge status="running" />}</td>
                <td className="mono">{segment.firstStep ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
