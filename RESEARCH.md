# Angular + Bazel Build Research: Caching, Remote Build Execution, and islo/Incredibuild Feasibility

> **This fork is a research artifact.** It is a fork of `angular/angular` created under an Incredibuild org solely to document a build-and-investigation session. It contains no product changes to Angular. **Only `//packages/core` was built**, and **no Incredibuild or islo endpoint was exercised** during this session — the RBE feasibility assessment below is analytical, not benchmarked against a live islo/Incredibuild backend.

## Abstract

This document records a research session whose goal was to (1) understand the structure of the `angular/angular` monorepo, (2) build a slice of it locally on an Apple Silicon Mac, (3) deep-dive how Bazel caching and Remote Build Execution (RBE) work, and (4) honestly assess whether the Angular build could run on Incredibuild or islo as an RBE backend.

The build half is fully empirical: every measurement below was independently confirmed on disk during the session. The feasibility half is analytical and modeled — it is explicitly labeled as such wherever a number is an estimate rather than a measurement. The short version of the verdict: a single laptop already wins from Bazel's local warm cache (~0.3s no-change rebuild), and neither Incredibuild nor islo appears to be a Bazel REAPI backend today, so the recommended first move is a cheap falsification test rather than an integration effort.

## What we did

| Step | Action | Outcome |
|------|--------|---------|
| 1 | Inspected the host machine and toolchain | Apple Silicon Mac, 10 cores, 32 GB RAM, macOS (darwin); git, Node v25.2.1, npm; host pnpm shims to the repo-pinned 11.7.0 (Homebrew binary is 10.25.0) |
| 2 | Shallow-cloned `github.com/angular/angular` | ~196M working tree; repo uses `MODULE.bazel` (bzlmod) |
| 3 | Installed `@bazel/bazelisk` globally | Bazelisk read `.bazelversion` (8.7.0) and fetched Bazel 8.7.0 |
| 4 | Ran a cold build of `//packages/core:core` | Success ("Build completed successfully"); 304.142s elapsed, 2467 total actions |
| 5 | Verified emitted artifacts on disk | Real compiler emit under `dist/bin/packages/core` (453 `.js`, 456 `.d.ts`, 453 `.js.map`) |
| 6 | Ran a warm no-change rebuild | ~0.3s, "2 action cache hit, 1 internal" (1 total action) |
| 7 | Confirmed the build ran 100% locally | Plain `bazel build` with no `--config=remote`; local `darwin-sandbox` + `worker` strategies only |
| 8 | Studied Bazel caching + REAPI; assessed islo/Incredibuild as an RBE target | Findings and verdict below |

## Build measurements

### Environment

- **Host:** Apple Silicon Mac, 10 cores, 32 GB RAM, macOS (darwin).
- **Host tooling:** git, Node v25.2.1, npm. The host's Homebrew pnpm binary is 10.25.0, but pnpm self-manages to the repo's `packageManager: "pnpm@11.7.0"` pin, so the effective host pnpm is 11.7.0 — it matches the repo.
- **Bazel:** 8.7.0, fetched by `@bazel/bazelisk` reading `.bazelversion`.

**Hermeticity note (important):** the Angular build is hermetic. `rules_nodejs` 6.7.4 supplies Node 22.22.3 and a pinned pnpm 11.7.0 *inside the sandbox*, so the host toolchain was **not** used to compile. `aspect_rules_js` 3.2.1 and `aspect_rules_ts` 3.8.10 consume `pnpm-lock.yaml` directly. The only genuine host/sandbox version gap is Node (host v25.2.1 vs sandbox 22.22.3); the effective host pnpm (11.7.0, via self-management) already matches the sandbox. This is why the host toolchain version did not matter.

### Cold build

Command:

```
bazel build //packages/core:core
```

Result (from the build log):

```
Elapsed time: 304.142s, Critical Path: 29.21s
2467 processes: 695 internal, 1694 darwin-sandbox, 78 worker
Build completed successfully, 2467 total actions
```

The captured log reported "Build completed successfully" (its EXIT marker did not print a numeric exit code).

What the action breakdown actually means:

| Action class | Count | Meaning |
|--------------|-------|---------|
| `internal` | 695 | In-process Bazel actions — no subprocess spawned |
| `darwin-sandbox` | 1694 | Subprocess actions under macOS `sandbox-exec`. **Not all "compiles"** — also includes bundling, `.d.ts` / source-map generation, and codegen |
| `worker` | 78 | Persistent, reused worker processes (long-lived `tsc` / `ngtsc`) |
| **Total** | **2467** | 695 + 1694 + 78 = 2467 |

The 304s wall-clock vs. the 29.21s critical path is the key signal: the build is highly parallel, and on this 10-core machine wall-clock is dominated by throughput across many actions, while 29.21s is the longest dependency chain (the theoretical floor for this target on infinite cores).

### Artifacts (proof of real emit)

Angular's `.bazelrc` sets `--symlink_prefix=dist/`, so outputs land under `dist/bin/packages/core`:

- 453 `.js`
- 456 `.d.ts`
- 453 `.js.map`

Spot-checks confirming this is genuine compiler emit, not a copy of sources:

- `src/version.js` has TypeScript types stripped and a `sourceMappingURL` footer.
- `index.js` carries the license header and `export * from './public_api'`.

**Scope:** only `//packages/core` was built. `dist/bin/packages` contains exactly one package directory (`core/`) — **not** `common/`, `compiler/`, `router/`, etc. (only loose toolchain files like `tsconfig-build.json` sit beside it).

### Warm re-run

An immediate no-change rebuild of the same target:

- Measured ~0.3s (0.375s, then 0.335s).
- Reported `2 action cache hit, 1 internal` (1 total action).

Why it's that fast:

- The **in-memory Skyframe incremental graph** lives on the persistent Bazel server.
- The **on-disk local action cache** covers what the server doesn't hold in memory.
- **External dependencies are already fetched.**

Storage footprint observed: Bazel output base `/var/tmp/_bazel_yossi.eliaz` was ~2.0G, of which `external/` was ~1.3G. **Note:** no separate `--disk_cache` or `--repository_cache` was configured — dependencies live in the output base's `external/` directory.

### Local vs. RBE — what actually ran

The build ran **100% locally.** Evidence:

- The command was plain `bazel build //packages/core:core` with **no** `--config=remote`.
- The strategy names in the log — `darwin-sandbox` and `worker` — are **local** strategies.
- Platform was `darwin_arm64-fastbuild`.
- No `/tmp/rbe-grpc.log` was produced.

For completeness: Angular's `.bazelrc` *does* define a Google RBE config — `build:remote` points `remote_executor` / `remote_cache` at `remotebuildexecution.googleapis.com` with `remote_instance_name=projects/internal-200822/instances/primary_instance`, and `build:remote-cache` references an `angular-team-cache` GCS bucket. But that config is gated behind `--google_default_credentials` and is inert unless `--config=remote` is passed. **We never passed it.**

## How Bazel caching and RBE work

### From targets to actions

Bazel parses `BUILD` files into a **target graph**, then lowers it to an **action graph**. The **analysis phase** builds the full action graph and is pure — no commands run. The **execution phase** then runs (or cache-serves) each action.

### Hermeticity and sandboxing make caching sound

Each action sees only its **declared inputs** (enforced by the sandbox). This isolation is precisely what makes caching *sound*: if the declared inputs are identical, the output is guaranteed identical, so a cached result can be trusted.

### The action key

An action's cache key is a hash over:

- the `argv`,
- the **content digests** of every declared input,
- the toolchain binary,
- the declared environment, and
- the platform.

It hashes **content, not mtimes** — touching a file without changing its bytes does not bust the cache.

### Caching layers

1. **Skyframe in-memory** — per-server, volatile; cleared when the Bazel server dies.
2. **Local action cache / `--disk_cache`** — content-addressable on local disk.
3. **Repository cache** — network downloads keyed by sha256.
4. **Remote cache** — a **CAS** (blobs addressed by `Digest`) plus an **ActionCache** (`Action` digest → `ActionResult`), spoken over the gRPC **Remote Execution API (REAPI v2)**.

### Remote Build Execution

RBE is remote *execution* over the same REAPI surface (`ContentAddressableStorage`, `ActionCache`, `Execution`, `Capabilities`):

- Inputs are uploaded as a **Merkle tree** into CAS.
- The action is **scheduled on a remote worker** and run hermetically.
- Outputs are written **back to CAS**.

Because the remote cache and remote executor **share the same CAS**, one engineer's (or CI's) previous execution becomes everyone's cache hit.

## Can Angular run on islo / Incredibuild RBE?

**Honest verdict up front: almost certainly not as a Bazel REAPI backend today.** The two products are not REAPI servers, so the interesting question is whether a cheap test can confirm or kill the idea quickly. The detail:

### Why neither is a REAPI backend today

- **Incredibuild** is *process virtualization*: an Initiator farms spawned child processes out to Helpers. It is **not REAPI**. The only known Bazel bridge — Bazel PR #18113 — **never shipped**.
- **islo.dev** is a newer **microVM agent-sandbox** product with a **REST/JSON + SSE** API. It has **no gRPC and no REAPI**. Running `bazel` *inside* an islo sandbox makes islo a Bazel **client**, not an RBE **server**.
- Neither product appears on Bazel's official **Remote Execution Services** vendor list (Buildbarn, Buildfarm, BuildGrid, NativeLink, BuildBuddy, EngFlow, ...).

### Speedup model (MODELED — not benchmarked)

These figures are analytical estimates from the observed build shape. They were **not** measured against any remote backend.

| Scenario | Modeled speedup | Why |
|----------|-----------------|-----|
| Remote **execution**, fully cold build, **one laptop** | ~5–8x | The Mac is already CPU-saturated across 10 cores; the 29s critical path is the floor; you also **lose** the warm persistent workers |
| Shared **cache**, fresh/clean checkout | ~20–100x | A teammate or CI populated the CAS; you download results instead of recomputing |
| Local warm rebuild vs. remote cache hit | **Local wins** | Local warm rebuild ~0.3s already beats a remote cache hit (~3–15s, network-bound) |

The real beneficiary of RBE/shared caching is a **CI fleet and a many-developer team**, not a single laptop that already has a hot local cache.

### The hard part: darwin → linux

Angular's `--config=remote` forces **linux/x86_64** (`--cpu=k8` plus linux platforms). To run remotely you would need:

- a custom `platform()` definition,
- a linux container image with a glibc userland, and
- linux toolchains.

And **the tests are the trap**: the Karma/Chrome test setup is the part most likely to break under a remote linux executor.

### Verdict

Treat islo/Incredibuild-as-Bazel-RBE as **unproven and probably unsupported** until a handshake test says otherwise. For a single laptop, local caching already wins; the value of RBE is a team/CI story and would require a real REAPI backend and a darwin→linux toolchain port.

## Recommendations / next steps

1. **Run a cheap falsification test first.** Add a `--config=islo` block that is **remote-cache-only** (no remote execution). The decisive check is whether the REAPI **`GetCapabilities` gRPC handshake** succeeds.
2. **If the handshake fails** (likely, since islo is REST) the premise is dead. The right paths are then:
   - **(a) One laptop →** do nothing; local caching already wins.
   - **(b) Linux build/test →** run Bazel on a **Linux CI runner or VM** (solves the darwin→linux problem directly, no RBE needed).
   - **(c) Team / CI scale →** adopt a **real REAPI vendor** — BuildBuddy, EngFlow, NativeLink, or Buildbarn.
3. **Do not invest in a darwin→linux remote toolchain port** until step 1 proves a working REAPI endpoint exists.

## How to reproduce

On an Apple Silicon Mac with git and Node available:

```bash
# 1. Install the Bazel launcher (reads .bazelversion -> Bazel 8.7.0)
npm install -g @bazel/bazelisk

# 2. Shallow-clone the repo
git clone --depth=1 https://github.com/angular/angular.git
cd angular

# 3. Cold build of the core package only
bazel build //packages/core:core
#   expect: ~304s elapsed, 2467 total actions, "Build completed successfully"

# 4. Warm re-run (no changes) — same command
bazel build //packages/core:core
#   expect: ~0.3s, "2 action cache hit, 1 internal" (1 total action)

# 5. Inspect emitted artifacts
ls dist/bin/packages/core
#   expect: real .js / .d.ts / .js.map emit (453 / 456 / 453)
```

Notes:

- Do **not** pass `--config=remote` unless you intend to use Google's RBE and have `--google_default_credentials` configured. This session never did.
- The host's Node/pnpm versions do not affect the compile because the build is hermetic (toolchains are pinned inside the sandbox).
- Numbers will vary with core count, disk, and cache state; the ~304s cold / ~0.3s warm split is the qualitative result to expect.

## Appendix: caveats, unknowns, and a security note

### Caveats and scope limits

- **Only `//packages/core` was built.** No other Angular package (`common`, `compiler`, `router`, ...) was compiled, so whole-repo build cost is not measured.
- **No Incredibuild or islo endpoint was exercised.** The feasibility section is analysis, not a benchmark.
- All speedup figures are **modeled**, not measured.
- Measurements are from a single machine and a single run pair (cold + warm); they are illustrative, not a statistical sample.
- The Google RBE config in `.bazelrc` exists but was never invoked; its current validity for external users is unknown.

### Open questions to resolve

- Does any islo/Incredibuild endpoint answer a REAPI `GetCapabilities` call at all? (The proposed falsification test answers this.)
- What is the real cost of a full-repo cold build, and the full-repo warm rebuild?
- How does the Karma/Chrome test path behave under a remote linux executor?

### Security note

During the session, AWS access keys were observed sitting in **plaintext** in the user's global `~/.claude/CLAUDE.md`. These should be **rotated** and moved into a proper credential store (e.g., a secrets manager or the AWS CLI credential provider chain). No secret values are reproduced in this document.