/** Legacy browser catalogs are opt-in previews; public discovery stays in the CLI/API/MCP. */
export function catalogPreviewEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LOCALFIRST_CATALOG_PREVIEW === 'true';
}
