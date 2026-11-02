# MCP agent

Requires Pi 1.4.0 or newer, nono, and `npx` (provided by Node.js). The first run downloads the filesystem MCP server. Launch from the project you want the server to access:

```sh
cradle run /path/to/cradle/examples/mcp
```

The server's `.` argument refers to the launch directory. Inspect the connection with `/mcp`. Pi activates codemode when the server connects; ask the agent to find the filesystem server's tools and list the project files.

The agent uses nono's normal project grants and network policy. Personal or trusted project MCP configuration with the same server name overrides this example's registration. To disable built-in MCP for one run:

```sh
cradle run /path/to/cradle/examples/mcp -- --no-mcp
```
