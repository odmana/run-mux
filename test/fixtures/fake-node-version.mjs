// Preloaded with --import so a test can prove the TUI's Node floor without
// installing an old Node. `process.versions` is a plain data property, so
// redefining it is enough for anything reading `process.versions.node`.
//
//   env RUN_MUX_FAKE_NODE   the version to report, e.g. 24.14.0
const node = process.env.RUN_MUX_FAKE_NODE;
if (node) {
  Object.defineProperty(process, 'versions', {
    value: { ...process.versions, node },
    configurable: true,
    writable: true,
    enumerable: true,
  });
}
