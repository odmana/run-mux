// The smallest daemon that speaks the run-mux IPC protocol. Runs unbuilt, so it
// cannot import the TypeScript sources — the socket path and the NDJSON framing
// are reimplemented here and must stay in step with src/paths.ts.
//   methods: echo, pid, boom (throws), count (subscription), $unsubscribe
//   env: STUB_PROTOCOL overrides the advertised protocol version
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

function hashString(input) {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function socketPath() {
  const root = process.env.RUN_MUX_HOME || undefined;
  if (platform() === 'win32') {
    return `\\\\.\\pipe\\run-mux${root ? `-${hashString(root)}` : ''}`;
  }
  if (root) return join(root, 'daemon.sock').replaceAll('\\', '/');
  const runtime = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  return join(runtime, 'run-mux.sock').replaceAll('\\', '/');
}

function stateDir() {
  const root = process.env.RUN_MUX_HOME;
  return root ? join(root, 'state') : tmpdir();
}

// One line per process start, so a test can prove autospawn produced exactly one.
const startsLog = join(stateDir(), 'stub-daemon-starts.log');
mkdirSync(stateDir(), { recursive: true });
appendFileSync(startsLog, `${process.pid}\n`);

const path = socketPath();
const protocol = Number(process.env.STUB_PROTOCOL ?? 1);

const server = createServer((socket) => {
  const subscriptions = new Map();
  let buffer = '';

  const write = (frame) => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(frame)}\n`);
  };

  write({ hello: true, version: 'stub', protocol, pid: process.pid });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      handle(frame);
    }
  });

  socket.on('close', () => {
    for (const stop of subscriptions.values()) stop();
    subscriptions.clear();
  });
  socket.on('error', () => {});

  function handle(frame) {
    const { id, method, params } = frame ?? {};
    if (typeof id !== 'number' || typeof method !== 'string') return;

    if (method === '$unsubscribe') {
      const stop = subscriptions.get(params?.stream);
      if (stop) {
        subscriptions.delete(params.stream);
        stop();
      }
      write({ id, ok: true, result: { stopped: Boolean(stop) } });
      return;
    }
    if (method === 'echo') {
      write({ id, ok: true, result: params });
      return;
    }
    if (method === 'pid') {
      write({ id, ok: true, result: process.pid });
      return;
    }
    if (method === 'boom') {
      write({ id, ok: false, error: { code: 'internal', message: 'stub exploded' } });
      return;
    }
    if (method === 'count') {
      const total = Number(params?.n ?? 3);
      const interval = Number(params?.intervalMs ?? 10);
      write({ id, ok: true, result: { subscribed: true, stream: id } });
      let sent = 0;
      const timer = setInterval(() => {
        sent++;
        write({ stream: id, event: 'data', data: sent });
        if (sent >= total) {
          clearInterval(timer);
          subscriptions.delete(id);
          write({ stream: id, event: 'end' });
        }
      }, interval);
      subscriptions.set(id, () => clearInterval(timer));
      return;
    }
    write({
      id,
      ok: false,
      error: { code: 'unknown_method', message: `unknown method: ${method}` },
    });
  }
});

server.on('error', (error) => {
  process.stderr.write(`stub-daemon: ${error.message}\n`);
  process.exit(1);
});

if (platform() !== 'win32' && existsSync(path)) {
  try {
    unlinkSync(path);
  } catch {
    // A live daemon still owning it will surface as EADDRINUSE below.
  }
}
server.listen(path, () => {
  process.stdout.write(`stub-daemon: listening on ${path}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
