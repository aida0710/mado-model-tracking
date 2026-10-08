import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** ffprobe or ffmpeg is not installed; previews are skipped instead of failing. */
export class MediaToolUnavailableError extends Error {
  override readonly name = 'MediaToolUnavailableError';
}

/** The tool exited non-zero, was killed by the timeout, or produced unusable output. */
export class MediaToolFailedError extends Error {
  override readonly name = 'MediaToolFailedError';
  constructor(readonly reason: 'exit' | 'timeout' | 'output') {
    super(reason);
  }
}

export interface MediaToolRun {
  /** Executable name or absolute path; arguments are passed as argv, never through a shell. */
  command: string;
  args: readonly string[];
  timeoutMs: number;
  /** Receives stdout chunks; without it stdout is collected and returned (up to maxOutputBytes). */
  onStdout?: (chunk: Buffer) => void;
  maxOutputBytes?: number;
}

// ffprobe JSON for a file with many streams and chapters stays well below this.
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Runs ffprobe/ffmpeg and resolves with collected stdout on exit code 0. stderr is discarded:
 * it repeats file paths and container metadata, which must not reach logs or the DB.
 */
export function runMediaTool(run: MediaToolRun): Promise<Buffer> {
  const maxOutputBytes = run.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(run.command, run.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new MediaToolUnavailableError(run.command));
      return;
    }
    const chunks: Buffer[] = [];
    let collected = 0;
    let failure: Error | null = null;
    const fail = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail(new MediaToolFailedError('timeout')), run.timeoutMs);
    child.stdin.end();
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (run.onStdout) {
        try {
          run.onStdout(chunk);
        } catch (error) {
          fail(error as Error);
        }
        return;
      }
      collected += chunk.length;
      if (collected > maxOutputBytes) fail(new MediaToolFailedError('output'));
      else chunks.push(chunk);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT' || error.code === 'EACCES'
          ? new MediaToolUnavailableError(run.command)
          : error,
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new MediaToolFailedError('exit'));
      else resolve(Buffer.concat(chunks));
    });
  });
}
