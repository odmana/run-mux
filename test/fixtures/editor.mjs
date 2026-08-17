/**
 * A stand-in for $EDITOR. Writes RUN_MUX_TEST_EDITOR_CONTENT over the file it is
 * handed, records the argv it was given, and exits with a chosen code — enough
 * to drive `rmux config edit` without a terminal.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const path = args.at(-1);

if (process.env.RUN_MUX_TEST_EDITOR_ARGV) {
  writeFileSync(process.env.RUN_MUX_TEST_EDITOR_ARGV, JSON.stringify(args), 'utf-8');
}

const content = process.env.RUN_MUX_TEST_EDITOR_CONTENT;
if (content !== undefined && path !== undefined) {
  writeFileSync(path, content, 'utf-8');
}

process.exit(Number.parseInt(process.env.RUN_MUX_TEST_EDITOR_EXIT ?? '0', 10));
