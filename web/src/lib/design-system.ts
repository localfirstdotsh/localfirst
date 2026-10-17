/** Internal component reference: opt in per deployment, automatically available in next dev. */
export function designSystemEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LOCALFIRST_DESIGN_SYSTEM === 'true' || env.LOCALFIRST_DESIGN_SYSTEM_PREVIEW === 'true') || env.NODE_ENV === 'development';
}
