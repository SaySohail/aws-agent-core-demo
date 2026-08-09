import { closeServer, createRuntimeServer, listen, parsePort } from './server.js';
import { BedrockConverseModelClient } from './agent/bedrock-model.js';
import { CustomerSupportAgent } from './agent/customer-support-agent.js';
import { loadCustomerSupportAgentConfig } from './agent/config.js';
import { GatewayToolExecutor } from './tools/gateway-tool-executor.js';
import { HttpGatewayMcpClient, SigV4GatewayTransport } from './tools/gateway-mcp-client.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function startRuntime(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const config = loadCustomerSupportAgentConfig();
  const agent = new CustomerSupportAgent(
    config,
    new BedrockConverseModelClient(config.region),
    new GatewayToolExecutor(
      new HttpGatewayMcpClient(new SigV4GatewayTransport(config.gatewayUrl, config.region)),
      config.toolTimeoutMs
    )
  );
  const server = createRuntimeServer({ invoke: (prompt) => agent.invokeWithActivity(prompt) });

  await listen(server, port);
  console.log(JSON.stringify({ event: 'runtime_started', port }));

  let shuttingDown = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(JSON.stringify({ event: 'shutdown_initiated', signal }));

    const fallback = setTimeout(() => {
      console.error(JSON.stringify({ event: 'shutdown_timeout' }));
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    fallback.unref();

    void closeServer(server)
      .then(() => {
        clearTimeout(fallback);
        process.exit(0);
      })
      .catch(() => {
        clearTimeout(fallback);
        console.error(JSON.stringify({ event: 'shutdown_failed' }));
        process.exit(1);
      });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  void startRuntime().catch(() => {
    console.error(JSON.stringify({ event: 'startup_failed' }));
    process.exitCode = 1;
  });
}
