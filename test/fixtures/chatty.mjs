// Emits a lot of output fast. Used for log-buffer trimming and TUI throughput.
//   --lines N  --size BYTES  --label TEXT
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

const lines = Number(args.get('lines') ?? 1000);
const size = Number(args.get('size') ?? 200);
const label = args.get('label') ?? 'chatty';
const filler = 'x'.repeat(Math.max(1, size));

for (let i = 1; i <= lines; i++) {
  process.stdout.write(`${label} ${i} ${filler}\n`);
}
