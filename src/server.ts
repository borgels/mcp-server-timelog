import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TimelogClient, type TimelogClientOptions } from './timelog/client.js';
import { registerTools } from './tools/timelog.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: TimelogClient;
  clientOptions?: TimelogClientOptions;
}

let defaultClient: TimelogClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): TimelogClient {
  defaultClient ??= new TimelogClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'timelog',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new TimelogClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
