# Releasing COre

Releases are deliberate. Nothing reaches users because a file changed on a branch.

## Gates (all automatic, all blocking)

| Gate | Where |
|---|---|
| `npm run check` (syntax) | CI on every branch/PR (Linux + Windows), release workflow |
| `npm test` | CI on every branch/PR (Linux + Windows), release workflow |
| App self-test (`--smoke-test`) | CI Linux (source), CI + release Windows (packaged app) |
| Installer: silent install → self-test → silent uninstall, user data kept | CI + release (Windows) |
| `latest.yml` present (installed-copy updates need it), SHA256SUMS written | release |
| Tag equals `package.json` version; no existing release with that tag | release |

## Process

1. Work happens on branches; CI runs on every push and PR. Merging to `main` publishes nothing.
2. Prepare the release on a branch: bump `version` in `package.json`, move the CHANGELOG "Unreleased"
   section under the new version, and write `RELEASE_NOTES.md` for it (the release body uses that file).
3. After the user approves the release: create and push the tag `vX.Y.Z` on the reviewed commit.
4. The **Release** workflow re-runs every gate on Windows and creates a **draft** GitHub release with the
   installer, blockmap, `latest.yml` and `SHA256SUMS.txt`.
5. A human downloads the draft installer, checks it, and clicks **Publish**. Installed copies only see
   published releases. Source installs on the default `release` update channel follow published releases too.

## Signing

Unsigned by default. To sign, add `WINDOWS_CSC_LINK` (base64 .pfx) and `WINDOWS_CSC_KEY_PASSWORD` repository
secrets. Only after builds are signed, add `"signtoolOptions": { "publisherName": "<certificate subject>" }`
to `build.win`. electron-updater then refuses updates not signed by that publisher. Setting it on unsigned
builds makes every update fail verification, which is why it's off.

## Releases published before this process (v2.0.0 – v10.2.0)

They were created by a racing double publisher. Each holds only the installer *or* its blockmap, and none
has `latest.yml`. They need a maintainer decision (delete, or mark as pre-release) before the first release
from this process is published.
