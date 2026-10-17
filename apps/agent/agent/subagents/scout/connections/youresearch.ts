import { defineMcpClientConnection } from "eve/connections";

// You.com MCP research: one-shot, multi-source cited synthesis.
export default defineMcpClientConnection({
  url: "https://api.you.com/mcp/research",
  description: "You.com one-shot cited research across many sources. Use for a supplier-landscape summary of a material.",
  auth: { credentialOwner: "app", getToken: async () => ({ token: process.env.YOU_DOT_COM_API_KEY ?? "" }) },
});
