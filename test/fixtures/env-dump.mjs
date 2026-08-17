// Prints every MUX_* variable plus any names passed as extra args, as one JSON
// line. Used to assert slot allocation and env precedence.
const extra = process.argv.slice(2);
const out = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('MUX_')) out[k] = v;
}
for (const name of extra) {
  if (process.env[name] !== undefined) out[name] = process.env[name];
}
process.stdout.write(`ENV ${JSON.stringify(out)}\n`);
