const LABELED_LINE = /^\[[^\]]+\]:\s/;
/** Format a shared session event for the Chorus panel / notifications. */
export function formatSessionLine(event) {
    const payload = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
    if (event.type === "user") {
        if (LABELED_LINE.test(payload))
            return payload;
        return `[Host]: ${payload}`;
    }
    if (event.type === "assistant")
        return `[AI]: ${payload}`;
    return `[${event.type}]: ${payload}`;
}
export function newEventId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
//# sourceMappingURL=format.js.map