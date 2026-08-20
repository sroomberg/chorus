# Enterprise security — what else Chorus would need

Chorus can already gate a LAN pair session: join token, optional host approval, required display name, git-remote claim, company-email claim, kick, and a layered `chorus.json`. That is enough for **trusted teammates on a trusted network**.

It is **not** enough for a security review that treats the host laptop as production and the session transcript as source code plus secrets. Joiners with the default `edit` role inject prompts into the **host** OpenCode session, so they inherit the host’s files, shell, MCP tools, and cloud credentials for the life of the share.

This note lists the additional controls that typically decide whether an enterprise would allow that.

## What current gates actually prove

| Control | What it proves today | What an enterprise thinks it proves |
|---|---|---|
| Join token (256-bit hex) | Someone saw the `/chorus-share` paste | An authenticated employee |
| `requireApproval` | The host clicked approve | Identity + authorization |
| Display name | A non-empty string | A real person |
| Git remote match | Joiner **claimed** the same origin URL | Joiner can clone / is a repo collaborator |
| `allowedEmailDomain` | Joiner **typed** `*@acme.com` | Verified company identity |
| `/etc/chorus/config.json` “lock” | Org defaults if nobody overrides them | Policy the user cannot weaken |
| S3/R2 backup | Session JSON landed in a bucket | Encrypted, retained, access-audited copy |

Email and repo checks are **self-asserted fields on the `auth` frame**. There is no OIDC token, magic link, GitHub API check, or signed git capability. A joiner who has the bearer token can send `email: "ada@acme.com"` and `repoRemote: "git@github.com:acme/secret.git"` without proving either.

Org policy has the same class of hole: load order is defaults → system → **user → project → `CHORUS_CONFIG`**. Later layers win. A project `chorus.json` can set `allowSkipApproval: true` and turn the “enterprise lock” off.

`chorus-stop` kills the relay process but does **not** revoke issued join tokens first. Tokens have **no default TTL**. The relay binds `0.0.0.0` by default over plaintext WebSocket. `/status` is unauthenticated.

## Blockers (security review will stop here)

These are the features that turn Chorus from “pair with a coworker on Wi-Fi” into “we can put this on a laptop that holds customer code.”

### 1. Org policy as a floor

System / MDM config must be able to set a **minimum** that user and project files cannot loosen:

- `requireApproval`, `allowSkipApproval`, `requireRepoMatch`, `requireEmailDomainMatch`, `allowedEmailDomain`, `defaultRole`, `tokenTtlMs`
- Optional: forbid `admin` join tokens, forbid backup, forbid advertising a non-loopback `publicHost`

Users should still be allowed to **tighten** (force approval even if org default is off). Today they can also loosen.

Without this, `/etc/chorus/config.json` is documentation, not control.

### 2. Real identity (SSO / OIDC)

Replace typed email with a proof the IdP issued:

- Device or user OIDC (Okta, Entra, Google Workspace, GitHub Enterprise)
- Restrict by IdP group / org, not just email domain (plus-addressing and lookalike domains are cheap)
- Bind the join token to the verified subject so the paste is not a transferable bearer secret

Until then, `allowedEmailDomain` is a reminder, not an access control.

### 3. Safer default privilege

`edit` means “drive the host agent.” That is root-equivalent for the share. Enterprises will want:

- Default role **`view`** (watch transcript, no `session.prompt`)
- Org lock: cannot issue `edit` / `admin` without extra confirmation or a second factor
- Host-side **tool allowlist** for joiner-originated turns (e.g. no `bash`, no `.env` reads, no deploy MCP)
- Visible attribution in the host transcript that this prompt came from a joiner (already partly labeled) **and** a way to refuse tools on joiner turns

A view-only share with host-driven edits is the session type most companies will actually approve.

### 4. Transport and token hygiene (especially before any tunnel)

Off-LAN or even “guest on the same Wi-Fi” needs:

- TLS on `/ws` and `/host` (or a forced local stunnel / reverse proxy)
- Authenticated `/status` (or bind it to localhost only)
- **Default token TTL** (minutes, not days); **revoke on `chorus-stop`**; optional single-use tokens
- Constant-time compare for host and join tokens
- Do not print the raw token into logs; treat the share paste as a secret (Slack/GitHub issue = leak)
- When `tunnel/` ships, mTLS or a relay that never accepts cleartext from the internet

The join command in chat is a **capability URL**. Enterprises will ask how it expires and who else saw it.

### 5. Audit log (who did what, to which repo)

Minimum event stream, append-only, exportable:

- share start/stop, token issue (role + TTL, not the secret), join pending/approve/deny/kick
- verified identity (once SSO exists), claimed vs proven repo
- joiner `collab.input` and chat (or hashes + retention policy)
- backup write/read

Ship to stdout JSON today; SIEM (Splunk, Datadog, CloudWatch) tomorrow. Without this, IR cannot answer “who prompted the agent that deleted the migration.”

### 6. Session data handling

The transcript is source, secrets, and customer names. Backup today is **plaintext JSON** to S3/R2 with no Chorus-side encryption, retention, or access policy.

Need:

- Encryption at rest (KMS / SSE-KMS) and in transit; no backup of secrets if DLP flags them
- Retention / TTL, residency (which bucket/region), and a “do not backup” org lock
- Redact join tokens and `Authorization` headers from events before disk or S3
- Explicit consent that joiners can see the **full** host session history on connect (they can)

Legal/privacy will ask this even if engineering would accept LAN-only.

## Strongly expected (procurement will ask)

Not always a hard block, but they show up on every questionnaire.

| Feature | Why |
|---|---|
| **Proven repo ACL** | GitHub/GitLab “is this user a collaborator on `origin`?” or a signed capability from the host clone — STATUS.md #11 |
| **Network allowlist** | Only listed CIDRs / tailnet peers can hit the relay; refuse `0.0.0.0` unless org allows LAN bind |
| **Signed relay binaries + SBOM** | Supply-chain review of `chorus-relay`; pinned plugin version |
| **Apache-2.0 or explicit patent grant** | MIT is often acceptable; some legal teams still stall — see [DECISIONS.md](./DECISIONS.md) |
| **Admin role split** | Joiner `admin` can kick/promote/close from the `/ws` client protocol. Host-only moderation is easier to explain |
| **Rate limits** | Join attempts, collab.input, chat — stop a leaked token from flooding the host LLM |
| **Secret / PII scanning** before backup and optionally before fan-out | Stop `.env` paste from landing in S3 and every joiner buffer |

## Not the first things to build

Skip these until the blockers above exist:

- Fine-grained RBAC folders, custom role matrices, ABAC
- A browser SSO portal for a product whose UX is OpenCode
- Rebuilding a full MDM agent — ship config floors and let Jamf/Intune drop `/etc/chorus/config.json`
- Multi-tenant hosted relay with customer isolation (open-core later; do not block the self-hosted path)

## Suggested order

1. **Policy floor** + **default `view`** + **token TTL and revoke-on-stop** — makes the locks you already document real, cuts blast radius, no IdP required.
2. **Audit JSON** + **backup encryption / no-backup lock** + **localhost or TLS bind** — answers IR and data-handling questions.
3. **OIDC** + **GitHub/GitLab collaborator check** — turns email/repo from claims into proofs.
4. **Joiner tool allowlist** + **tunnel with TLS** — only then is remote pair programming an enterprise feature.

Until (1)–(2) ship, market Chorus as **LAN, trusted peers, host is fully trusted**. The current security knobs are pairing etiquette with an org-shaped config file, not an enterprise access-control system.
