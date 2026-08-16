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
//# sourceMappingURL=protocol.js.map