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
//# sourceMappingURL=protocol.js.map