// Runs until killed, printing at an interval. Stands in for a dev server.
//   --interval MS  --label TEXT  --ignore-sigterm  --port N  --crash-after MS --exit CODE
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

const interval = Number(args.get('interval') ?? 100);
const label = args.get('label') ?? 'service';
const ignoreSigterm = args.get('ignore-sigterm') === 'true';
const crashAfter = args.get('crash-after') ? Number(args.get('crash-after')) : null;
const exitCode = Number(args.get('exit') ?? 1);

if (args.get('port')) {
  process.stdout.write(`${label}: now listening on http://localhost:${args.get('port')}\n`);
}

let n = 1;
setInterval(() => {
  process.stdout.write(`${label}: tick ${n++}\n`);
}, interval);

if (crashAfter !== null) {
  setTimeout(() => {
    process.stdout.write(`${label}: crashing\n`);
    process.exit(exitCode);
  }, crashAfter);
}

if (ignoreSigterm) {
  // Used to prove the supervisor escalates to a force kill.
  process.on('SIGTERM', () => process.stdout.write(`${label}: ignoring SIGTERM\n`));
  process.on('SIGINT', () => process.stdout.write(`${label}: ignoring SIGINT\n`));
} else {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      process.stdout.write(`${label}: shutting down\n`);
      process.exit(0);
    });
  }
}
