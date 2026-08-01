/**
 * Default transport factory. PTY support stays behind a lazy capability probe so
 * pipe sessions and every legacy shell/job path remain reachable on targets
 * without a verified native artifact.
 */

import { startPipeTransport } from "./transport-pipe.js";
import { probePtyCapability, startPtyTransport } from "./transport-node-pty.js";
import type { SessionTransportFactory } from "./transport.js";

export function createSessionTransportFactory(): SessionTransportFactory {
  return {
    capability: (platform) => probePtyCapability(platform),
    startPipe: (request) => startPipeTransport(request),
    startPty: (request) => startPtyTransport(request),
  };
}

export const defaultTransportFactory = createSessionTransportFactory();
