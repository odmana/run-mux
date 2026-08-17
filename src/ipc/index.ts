/** NDJSON over a named pipe / unix socket, plus daemon autospawn. */

export {
  DecodeError,
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  FrameDecoder,
  isHelloFrame,
  isRequestFrame,
  isResponseFrame,
  isRpcFailure,
  isStreamFrame,
  RpcFailure,
  rpcError,
  toRpcError,
  UNSUBSCRIBE_METHOD,
} from './framing.js';
export type { DecodeErrorReason, FrameDecoderOptions } from './framing.js';

export { createIpcServer, isSubscription, methodRouter, subscription } from './server.js';
export type {
  IpcServer,
  IpcServerOptions,
  MethodHandler,
  RequestContext,
  RequestHandler,
  StreamEmitter,
  SubscriptionHandle,
} from './server.js';

export { connect } from './client.js';
export type { ConnectOptions, IpcClient, SubscribeHandlers, Unsubscribe } from './client.js';

export { ensureDaemon, tryConnect } from './spawn.js';
export type { EnsureDaemonOptions } from './spawn.js';
