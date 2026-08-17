// Prints N lines at an interval, then exits with a chosen code.
// Stands in for a build/test step (a `task`).
//   --lines N  --interval MS  --exit CODE  --label TEXT  --stderr
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, 'true');
  }
}

const lines = Number(args.get('lines') ?? 3);
const interval = Number(args.get('interval') ?? 50);
const exitCode = Number(args.get('exit') ?? 0);
const label = args.get('label') ?? 'tick';
const useStderr = args.get('stderr') === 'true';
const out = useStderr ? process.stderr : process.stdout;

let i = 1;
const id = setInterval(() => {
  out.write(`${label} ${i}/${lines}\n`);
  if (i >= lines) {
    clearInterval(id);
    // Let the write flush before the process goes away.
    setTimeout(() => process.exit(exitCode), 10);
  }
  i++;
}, interval);
