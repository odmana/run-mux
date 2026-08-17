// Stands in for dist/tui/index.js. Points RUN_MUX_TUI_ENTRY here and the CLI's
// TUI launch can be driven without building or running OpenTUI.
//
//   env TUI_STUB_EXIT   the exit code to end with (default 0)
//
// The stdout line reports whether --experimental-ffi actually reached the child,
// which is the whole reason the TUI is spawned rather than imported.
process.stdout.write(`tui-stub: ffi=${process.execArgv.includes('--experimental-ffi')}\n`);
process.stderr.write('tui-stub: on stderr\n');
process.exit(Number.parseInt(process.env.TUI_STUB_EXIT ?? '0', 10));
