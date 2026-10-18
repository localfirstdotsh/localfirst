/** Only local browser pages are accepted as sign-in continuations. */
export function safeReturnPath(value: string | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\u0000-\u0020]/.test(value)
    ? value : '/account/connections';
}
