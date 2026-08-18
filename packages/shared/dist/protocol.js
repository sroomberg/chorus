export function encodeMessage(msg) {
    return JSON.stringify(msg);
}
export function decodeServerMessage(raw) {
    const parsed = JSON.parse(raw);
    return parsed;
}
export function decodeClientMessage(raw) {
    const parsed = JSON.parse(raw);
    return parsed;
}
/** Non-empty trimmed display name, or null if invalid. */
export function normalizeDisplayName(raw) {
    if (raw == null)
        return null;
    const name = raw.trim();
    if (!name)
        return null;
    if (name.length > 64)
        return name.slice(0, 64);
    return name;
}
/** Trimmed lowercase email, or null if invalid. */
export function normalizeEmail(raw) {
    if (raw == null)
        return null;
    const email = raw.trim().toLowerCase();
    if (!email)
        return null;
    const at = email.indexOf("@");
    if (at <= 0 || at === email.length - 1 || email.indexOf("@", at + 1) !== -1)
        return null;
    if (email.length > 254)
        return email.slice(0, 254);
    return email;
}
export function emailMatchesDomain(email, allowedDomain) {
    const domain = allowedDomain.trim().replace(/^@/, "").toLowerCase();
    if (!domain)
        return true;
    const at = email.lastIndexOf("@");
    if (at < 0)
        return false;
    return email.slice(at + 1).toLowerCase() === domain;
}
//# sourceMappingURL=protocol.js.map