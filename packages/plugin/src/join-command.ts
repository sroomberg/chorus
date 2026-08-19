/** Placeholder in `/chorus-share` output; joiners must replace it with a real name. */
export const JOIN_NAME_PLACEHOLDER = "YOUR_NAME";

/** Optional email slot shown when the host is not enforcing a company domain. */
export const JOIN_EMAIL_PLACEHOLDER = "<work-email>";

/** Ready-to-send join command, including args the collaborator should fill in. */
export function formatJoinCommand(
  token: string,
  host: string,
  opts: { allowedEmailDomain?: string } = {}
): string {
  const required = `/chorus-join token="${token}" host="${host}" name="${JOIN_NAME_PLACEHOLDER}"`;
  if (opts.allowedEmailDomain) {
    return `${required} email="you@${opts.allowedEmailDomain}"`;
  }
  return `${required} [email="${JOIN_EMAIL_PLACEHOLDER}"]`;
}
