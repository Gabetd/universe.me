/**
 * The app, or (with --mcp) its MCP server over stdio for an AI client such as
 * Claude Code: `Universe --mcp --project <file.universe>` (PLAN.md §6.2).
 */
if (process.argv.includes('--mcp')) void import('./mcp-stdio')
else void import('./app')
