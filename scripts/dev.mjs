import { spawn } from 'node:child_process';

const children = ['@mmt/api', '@mmt/web'].map((workspace) =>
  spawn('npm', ['run', 'dev', '-w', workspace], { stdio: 'inherit' }),
);
let isStopping = false;
function stop(signal = 'SIGTERM') {
  if (isStopping) return;
  isStopping = true;
  for (const child of children) child.kill(signal);
}
for (const child of children)
  child.once('exit', (code) => {
    if (isStopping) return;
    process.exitCode = code ?? 1;
    stop();
  });
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop());
