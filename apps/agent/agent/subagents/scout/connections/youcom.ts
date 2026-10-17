import { defineMcpClientConnection } from "eve/connections";

// You.com MCP: `you-search` (live web search) and `you-contents` (read full pages as markdown).
export default defineMcpClientConnection({
  url: "https://api.you.com/mcp",
  description: "You.com live web search and page reading. Use to find and read supplier, DMF, CEP and GMP evidence pages.",
  auth: { credentialOwner: "app", getToken: async () => ({ token: process.env.YOU_DOT_COM_API_KEY ?? "" }) },
});
