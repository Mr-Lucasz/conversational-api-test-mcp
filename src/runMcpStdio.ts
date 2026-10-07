import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConversationalApiMcpServer } from "./server/createServer.js";

export async function runMcpStdio(): Promise<void> {
  const server = createConversationalApiMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
