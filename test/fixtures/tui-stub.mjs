// Stands in for dist/tui/index.js. Points RUN_MUX_TUI_ENTRY here and the CLI's
// TUI launch can be driven without building or running OpenTUI.
//
//   env TUI_STUB_EXIT   the exit code to end with (default 0)
//
// Writes to both streams so the caller can prove stdio was inherited, not piped.
process.stdout.write('tui-stub: on stdout\n');
process.stderr.write('tui-stub: on stderr\n');
process.exit(Number.parseInt(process.env.TUI_STUB_EXIT ?? '0', 10));
