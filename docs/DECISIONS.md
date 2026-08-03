# Architecture decisions — host, language, license

## Recommendation (short)

| Question | Decision |
|---|---|
| Build from scratch as a new harness? | **No.** |
| OpenCode plugin vs another host? | **Stay OpenCode-first** for v1; design the wire protocol as harness-agnostic. |
| Primary language? | **TypeScript / Bun** for plugin + protocol SDKs. Optional Rust later for a standalone relay (fits `unified-context-protocol`). |
| License? | **Keep MIT** for protocol, shared types, and adapters. Managed cloud relay/backup (if any) stays proprietary SaaS — do not BSL/AGPL the client. |

---

## 1. Plugin vs from-scratch harness

### Do not build a coding agent from scratch

Chorus’s value is **multi-human session sharing** (presence, roles, prompt fan-in, chat, backup), not another agent loop, tool runner, or SWE-bench harness. Rebuilding that stack would dominate the roadmap and compete with OpenCode / Codex / Claude Code on their home turf.

### Stay an OpenCode plugin for v1

OpenCode is the strongest OSS host for this feature today:

- Mature `@opencode-ai/plugin` hooks (session, tools, TUI, dispose)
- Client/server session model already implies multi-client observation
- MIT license, TypeScript/Bun stack matching this repo
- Existing Chorus code already works against `@opencode-ai/plugin` v1.15.11

Nearby plugins prove the ecosystem wants session extensions, but none own **human pair-programming on one live AI session** the way Chorus does. That niche is still open.

### Evolve toward a harness-agnostic protocol (not a second rewrite)

Trap to avoid: painting the product into OpenCode-only forever.

Recommended shape:

```
┌─────────────────────────────────────────┐
│  Chorus protocol (auth, roles, events,  │
│  chat, collab.input, host controls)     │
└───────────────┬─────────────────────────┘
                │
     ┌──────────┼──────────┐
     ▼          ▼          ▼
 OpenCode    Codex CLI   (later)
 adapter     app-server  Claude hooks
 (plugin)    adapter     adapter
```

- **v1:** OpenCode adapter = this repo’s plugin + local Bun relay
- **v1.x:** extract `@chorus/protocol` (already largely `packages/shared`) as the stable contract
- **v2:** optional second adapter (Codex app-server is the best #2) only after OpenCode UX is solid

**Do not** make Claude Code / Amp the primary host — large audiences, but proprietary control planes. Treat them as distribution adapters later, not the core.

---

## 2. Language

| Layer | Language | Why |
|---|---|---|
| OpenCode plugin, shared protocol, tools | **TypeScript (Bun)** | Matches OpenCode plugin API; already implemented; fastest iteration |
| Optional future high-perf relay / PTY mux | **Rust** (later) | Aligns with your `unified-context-protocol` Rust core; good for NAT/tunnel/binary deploy |
| Viewer TUI (if revived outside OpenCode) | TS or Go | Only if non-OpenCode observers become a goal |
| Python | **Avoid as primary** | Fine for experiments; weak for realtime collab infra |

**Now:** keep Bun + TypeScript monorepo.  
**Later:** only introduce Rust if the relay outgrows in-process Bun or you want a single static binary for remote tunnels. UCP remains a separate concern (cross-model context), not a Chorus dependency for v1.

---

## 3. License

Current: **MIT** (Copyright 2026 Steven Roomberg).

| Option | Verdict |
|---|---|
| **MIT** | **Keep.** Matches OpenCode; max adoption for plugins/adapters; already shipped through `v0.1.6`. |
| Apache-2.0 | Reasonable alternative if you want an explicit patent grant before enterprise uptake. Migration cost is low while the repo is young — only worth doing before outside contributors land. |
| AGPL-3.0 | Reject for client/protocol — blocks corporate plugin adoption. |
| BSL / SSPL / Fair Source | Reject for protocol + adapters. If you later sell a hosted relay, keep that service proprietary under separate ToS; leave the OSS client MIT/Apache. |

**Open-core split (if/when cloud backup-as-a-service matters):**

- MIT (or Apache-2.0): `@chorus/shared`, `@chorus/plugin`, self-host relay
- Proprietary: managed multi-tenant relay, SSO, retention, audit

No license change is required to continue v1. Prefer stability over a relicensing churn unless Apache’s patent grant becomes a concrete sales requirement.

---

## 4. Product framing going forward

Ship Chorus as:

> “Pair-program an OpenCode AI session with another human over a shared relay.”

Not as:

> “A new AI coding harness” or “a browser IDE for watching agents.”

LAN-first is honest until `tunnel/` exists. Browser viewing is an optional observer surface later, not the core loop.
