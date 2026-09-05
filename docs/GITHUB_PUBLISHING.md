# Publishing URDR Source on GitHub

## License Decision Comes First

`native/urdr-wgpu/Cargo.toml` currently declares `license = "Proprietary"`.
Publishing source on GitHub does not automatically make it open source. Before
making the repository public, the owner must choose one of these policies:

1. Public source, all rights reserved.
2. An approved open-source license.
3. Private repository with invited collaborators.

Do not replace the license field or third-party notices without a deliberate
legal decision.

## What Belongs in Git

Include:

- `native/urdr-wgpu/src`, `Cargo.toml`, and `Cargo.lock`;
- active build/package scripts;
- `docs`, `README.md`, `CONTRIBUTING.md`, `AGENTS.md`;
- `.github` workflows and templates;
- development demo/resource metadata needed by tests;
- third-party notices and provenance.

Exclude:

- Rust `target` directories;
- `node_modules`, Electron output, portable builds, ZIPs, and executables;
- `outputs`, `output`, `diagnostics`, `tmp`, and logs;
- local saves and speech caches;
- embedded IMS-Toucan Python runtime and model weights;
- Unity `Library`, `Logs`, `Temp`, `Obj`, `Build`, and `UserSettings`.

## Large Optional Speech Resources

The current IMS-Toucan package contains individual files far above GitHub's
normal 100 MB object limit, including model weights and native libraries. Keep
the following out of ordinary Git history:

```text
runtime-resources/Data/Speech/IMS-Toucan/python/
runtime-resources/Data/Speech/IMS-Toucan/Models/*.pt
```

Retain the engine manifest, runner source, README, package list, license, and
provenance in Git. Distribute the runtime as one of:

- a separately versioned GitHub Release asset;
- an external package with checksums;
- Git LFS only after confirming storage/bandwidth limits.

The application already treats speech as optional at startup. Packaging tests
must explicitly install and validate the complete resource set.

## Secrets and Personal Data

Before the first push, inspect for:

- API keys, tokens, private URLs, and local usernames;
- personal project saves and speech cache audio;
- temporary screenshots and pasted attachments;
- restricted fonts, images, models, or datasets;
- absolute development paths in scripts/docs.

Use a new clean repository rather than uploading the current working directory
with all historical build artifacts.

## Recommended First Push

```powershell
pwsh scripts/export-github-source.ps1
cd outputs/URDR-Engine-v4.4-GitHub-Source
git init
git add .
git status
git commit -m "Initial URDR Engine 4.4 source import"
```

Review `git status` and the largest staged files before adding a remote. The
export script intentionally omits optional speech binaries and generated
artifacts.

## CI Expectations

The native workflow runs on Windows and verifies:

```text
cargo fmt --all -- --check
cargo check --locked
cargo test --locked
cargo build --release --locked
```

Tests that require the complete optional speech package or generate large
diagnostic reports must remain explicit packaging/manual jobs.

## Release Expectations

Release users receive the portable folder or ZIP, not a lone executable. Keep
`Data`, `Graphics`, `Localization`, `Licenses`, and other manifest resources
beside `URDR.exe`. Preserve checksums, third-party notices, and the test report.
