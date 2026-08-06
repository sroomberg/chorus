# Third-party license evaluation (commercial / paid app)

Audit date: 2026-08-03  
Scope: runtime dependencies of `@chorus/plugin`, `@chorus/shared`, and `chorus-relay` (excluding test-only / build-only tooling unless noted).  
**Not legal advice** — use for planning; get counsel before shipping a paid product.

## Verdict

**Current third-party stack is compatible with a paid / proprietary product or SaaS.**  
There is **no AGPL, GPL-only, SSPL, BUSL, or Commons Clause** in the runtime dependency tree.

You can ship closed-source Chorus code (or a hosted relay) that links these libraries, as long as you meet **attribution / NOTICE** obligations. Copyleft is not a blocker today.

---

## Your own code

| Item | License | Commercial note |
|---|---|---|
| Chorus repo (`LICENSE`) | MIT | You may dual-license *your* copyrighted code commercially. MIT grants already given to recipients of public MIT releases cannot be revoked. Common pattern: keep OSS MIT client/plugin; sell proprietary cloud/relay features under separate terms. |

Package manifests currently mark `@chorus/*` as `"private": true` and omit a `license` field (tools report `UNLICENSED`). The repo root `LICENSE` is still MIT — align `package.json` / crate metadata when you publish.

---

## Runtime dependency summary

### Rust (`crates/chorus-relay`) — 123 crates (prod, no dev-deps)

| License family | Approx. count | Commercial fit |
|---|---|---|
| MIT and/or Apache-2.0 (incl. dual) | ~120 | Fine — attribute |
| MIT OR Unlicense | 2 (`aho-corasick`, `memchr`) | Fine — choose MIT |
| Apache-2.0 OR BSL-1.0 | 1 (`ryu`) | Fine — Boost is permissive |
| Apache-2.0 OR LGPL-2.1-or-later OR MIT | 1 (`r-efi`, EFI/Windows target) | Fine — choose MIT or Apache-2.0 (do **not** choose LGPL alone) |
| (Apache-2.0 OR MIT) AND Unicode-3.0 | 1 (`unicode-ident`) | Fine — keep Unicode notice |
| BSD-3-Clause AND MIT | 1 (`matchit`) | Fine |

**Direct crates:** axum, tokio, serde, clap, tracing, tower-http, rand, hex, futures-util — all MIT and/or Apache-2.0.

No pure GPL/AGPL/SSPL crates found.

### TypeScript (`@chorus/plugin` production tree)

Reachable runtime packages (~60), all permissive:

| License | Examples |
|---|---|
| Apache-2.0 | `@aws-sdk/*`, `@aws-crypto/*`, `@smithy/*` |
| MIT | `zod`, `fast-xml-parser`, stream helpers |
| 0BSD | `tslib` |
| BSD-3-Clause | `ieee754` |
| ISC | `inherits` |

**Direct runtime deps:** `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` (Apache-2.0), `zod` (MIT).

### Peer / host (not bundled by Chorus)

| Component | License | Note |
|---|---|---|
| `@opencode-ai/plugin` / `sdk` | MIT | Optional peers — user supplies OpenCode |
| OpenCode host app | MIT | Not redistributed by Chorus |
| Bun (if you ship or require it) | MIT, but **statically links JavaScriptCore (LGPL-2)** | See “Bun” below |

Dev-only (vitest, typescript, types): permissive; do not ship in customer artifacts.

---

## Paid-product scenarios

| Model | Feasible with current deps? | Main obligations |
|---|---|---|
| **Paid SaaS** (hosted relay / backup) | Yes | Attribution in product docs or about page; preserve Apache NOTICE files for AWS SDK if you redistribute those packages in a server image |
| **Paid closed-source binary** (`chorus-relay` + plugin) | Yes | Ship a `THIRD_PARTY_NOTICES` (or similar) with MIT/Apache/Unicode texts; preserve NOTICE files |
| **Paid plugin that users run on their OpenCode** | Yes | Same notices; OpenCode remains user’s MIT dependency |
| **Relicense Chorus itself as proprietary-only** | Partial | You can stop publishing new code under MIT, or dual-license going forward; you cannot claw back prior MIT releases |

Nothing in the current tree forces you to open-source *your* application code (no network-copyleft).

---

## Watch-outs (not blockers)

### 1. Attribution is mandatory

For MIT/Apache/Unicode you must retain copyright + license notices when distributing. Practical checklist:

- Add `THIRD_PARTY_NOTICES` (or `NOTICE`) to release artifacts and Docker images.
- Include Apache-2.0 license text + any upstream `NOTICE` from AWS SDK / Smithy packages you redistribute.
- Include Unicode License V3 notice because of `unicode-ident`.
- For dual-licensed crates, document that you elect the MIT and/or Apache-2.0 option (never LGPL-only for `r-efi`).

### 2. Bun + LGPL JavaScriptCore

If the paid product **redistributes the Bun binary** (installer that vendors `bun`), LGPL-2 obligations for statically linked JavaScriptCore apply (offer object files / relink path).

**Safer for a paid app:**

- Ship `chorus-relay` (Rust) as your binary.
- Document “requires Bun / OpenCode installed by the user” for the plugin, **or**
- Compile/run the plugin under Node if you want to avoid shipping Bun.

Using Bun only as a local/dev runtime, without redistributing it, is much lower risk.

### 3. Apache-2.0 patent retaliation

Apache-2.0 includes an express patent grant that **terminates if you sue** alleging the licensed work infringes patents. Normal for AWS SDK / many Rust crates. Rarely an issue; be aware if you pursue patent litigation strategy.

### 4. Trademarks

Apache-2.0 (and general practice) does **not** grant trademark rights. Don’t brand a paid product as “AWS”, “OpenCode”, etc. without permission. “Works with OpenCode” factual statements are usually fine; logos/names as product identity are not.

### 5. Unused `@aws-sdk/lib-storage`

Still a dependency (Apache-2.0). Either use it or remove it to shrink the notice surface — not a license problem.

---

## What would *become* a problem later

Avoid adding (or carefully isolate) dependencies under:

| License | Why it hurts a paid app |
|---|---|
| **AGPL-3.0** | Network use can require offering corresponding source |
| **GPL-2/3** (without a permissive dual option) | Strong copyleft if you distribute a linked binary |
| **SSPL / Commons Clause / BUSL** | Often blocks SaaS or timed commercial use |
| **CC-BY-NC** | Non-commercial — incompatible with paid use |
| Some fonts / content packs | Check “no commercial” clauses separately |

Tunnel clients (`cloudflared`, etc.) if vendored later: review each binary’s license before bundling.

---

## Recommendations if you go paid

1. **Keep third-party stack permissive** (status quo is good). Prefer MIT/Apache for new deps; reject AGPL for anything in the relay/plugin path.
2. **Generate notices in CI** (`cargo license`, npm license report) and ship them with releases.
3. **Prefer open-core:** MIT plugin + self-host relay; proprietary managed cloud (auth, multi-tenant relay, retention). Matches [DECISIONS.md](./DECISIONS.md).
4. **Don’t redistribute Bun** in a paid installer unless you accept LGPL compliance for JSC; ship Rust relay + optional Node build instead.
5. **Align metadata:** set `"license": "MIT"` on publishable packages; keep crate `license = "MIT"`.
6. Re-run this audit when adding tunnel providers, UI frameworks, or telemetry SDKs.

---

## How this audit was produced

- Rust: `cargo license --avoid-dev-deps --manifest-path crates/chorus-relay/Cargo.toml`
- npm: BFS over production dependencies of `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, and `zod` as resolved in the workspace install
- Peers: `npm view @opencode-ai/plugin@1.15.11 license` → MIT
- Bun: upstream `LICENSE.md` (MIT + LGPL-2 JSC note)
