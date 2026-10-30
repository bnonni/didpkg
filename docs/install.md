# Install didpkg

There are 3 ways to install the didpkg CLI:

| Way | Platforms | Needs |
|---|---|---|
| [npm](#npm) | Linux, macOS, Windows | Node 22 or later |
| [The install script](#the-install-script) | Linux (glibc), macOS | curl, tar and a SHA-256 tool (`sha256sum`, `shasum` or `openssl`) |
| [A manual download](#manual-download) | Linux (glibc), macOS | curl, tar and a SHA-256 tool |

The script and the manual download give a standalone binary. The binary has the Bun runtime in it, thus it does not need Node. To install packages by DID, you still need npm, pnpm or bun.

Note: the npm package `didpkg@0.1.0`, the first GitHub Release `v0.1.0` and the site `didpkg.dev` are not live yet. Until then, the commands on this page fail. Build the CLI from a clone ([quickstart, step 1](quickstart.md#1-install-the-cli)).

## npm

```sh
npm install --global didpkg
didpkg --version
```

This way also works on Windows. npm compares the package with the integrity value of the npm registry.

## The install script

On Linux or macOS:

```sh
curl -fsSL https://didpkg.dev/install | sh
```

The script does these steps:

1. It finds the OS and the CPU, and selects the archive of the latest release.
2. It downloads the archive and `SHA256SUMS` from the GitHub Release. It uses only HTTPS.
3. It compares the SHA-256 of the archive with the value in `SHA256SUMS`. If the values are different, it stops and changes no file.
4. It runs the new binary with `--version`, then puts it in `~/.didpkg/bin/didpkg`. It replaces an old binary in 1 step.
5. It prints the line that adds `~/.didpkg/bin` to your PATH.

The script does not use sudo. It does not change your shell profile. All the work is in 1 function, and the last line calls that function. Thus, if the download stops before the end, the shell runs nothing.

To install a specific version, put the variable before `sh`, not before `curl`:

```sh
curl -fsSL https://didpkg.dev/install | DIDPKG_VERSION=0.1.0 sh
```

### Read the script before you run it

A server can send a different script to a pipe than to a file. To remove this risk, download the script, read it, then run it:

```sh
curl -fsSLO https://didpkg.dev/install
less install
sh install
```

The source of the script is [`site/public/install`](../site/public/install) in this repository.

### Environment variables

| Variable | Use |
|---|---|
| `DIDPKG_VERSION` | The release to install, for example `0.1.0` or `v0.1.0`. Default: the latest release. |
| `DIDPKG_INSTALL` | The install folder. The binary goes in `$DIDPKG_INSTALL/bin`. Default: `~/.didpkg`. |
| `DIDPKG_DOWNLOAD_URL` | The URL of a folder with the archives and `SHA256SUMS`, for example a mirror. It replaces the GitHub Release URL. Only this URL can use `http`. If `DIDPKG_VERSION` is also set, the binary must show that version. |

## Manual download

Each release has 4 archives and 1 `SHA256SUMS` file:

| OS | CPU | Archive |
|---|---|---|
| Linux | x64 | `didpkg-linux-x64.tar.gz` |
| Linux | arm64 | `didpkg-linux-arm64.tar.gz` |
| macOS | Intel (x64) | `didpkg-darwin-x64.tar.gz` |
| macOS | Apple silicon (arm64) | `didpkg-darwin-arm64.tar.gz` |

Each archive has 1 folder, for example `didpkg-linux-x64/`. The folder has `didpkg`, `LICENSE` and `THIRD_PARTY_LICENSES.txt`. These steps use Linux x64. For another platform, use its archive name.

1. Download the archive and `SHA256SUMS`:

   ```sh
   base=https://github.com/bnonni/didpkg/releases/latest/download
   curl -fsSLO "$base/didpkg-linux-x64.tar.gz"
   curl -fsSLO "$base/SHA256SUMS"
   ```

   For a specific version, use `base=https://github.com/bnonni/didpkg/releases/download/v0.1.0`.

2. Check the SHA-256. The output must be `didpkg-linux-x64.tar.gz: OK`. On macOS, use `shasum -a 256 -c -` in place of `sha256sum -c -`.

   ```sh
   grep '  didpkg-linux-x64.tar.gz$' SHA256SUMS | sha256sum -c -
   ```

3. Optional: check the build provenance with the [GitHub CLI](https://cli.github.com/):

   ```sh
   gh attestation verify didpkg-linux-x64.tar.gz -R bnonni/didpkg
   ```

4. Extract the binary and put it in a folder on your PATH:

   ```sh
   tar -xzf didpkg-linux-x64.tar.gz
   mkdir -p ~/.didpkg/bin
   mv didpkg-linux-x64/didpkg ~/.didpkg/bin/
   ~/.didpkg/bin/didpkg --version
   ```

### macOS and a browser download

curl does not set the macOS quarantine flag. A browser sets it. If you download the archive in a browser, macOS can block the binary. To remove the flag, run `xattr -d com.apple.quarantine ~/.didpkg/bin/didpkg`. The macOS binaries have only an ad-hoc signature. Apple did not notarize them.

## Upgrade

- Script: run the script again. It replaces the binary.
- npm: `npm install --global didpkg@latest`.
- Manual download: do the 4 steps again.

An upgrade does not change your identities.

## Uninstall

1. Delete the CLI:
   - Script or manual download: `rm -rf ~/.didpkg`. If you set `DIDPKG_INSTALL`, delete that folder.
   - npm: `npm uninstall --global didpkg`.
2. If you added `~/.didpkg/bin` to your PATH, remove that line from your shell profile.

The uninstall does not delete your identities. They are in the config folder: `$DIDPKG_HOME`, else `$XDG_CONFIG_HOME/didpkg`, else `~/.config/didpkg`. Before you delete that folder, make a backup of the identity files. Without the files, you cannot sign a new release with that DID.

## What you trust

- The script comes from `didpkg.dev` (GitHub Pages of `bnonni/didpkg`) over HTTPS. The archives and `SHA256SUMS` come from the GitHub Releases of `bnonni/didpkg`. Thus, you trust GitHub and the maintainer account of `bnonni/didpkg`.
- The npm package has the same type of trust: you trust the npm registry and the npm account of the maintainer.
- `SHA256SUMS` comes from the same release as the archive. The check finds a damaged or incomplete download. It does not find a bad release: a person who can change an archive can also change `SHA256SUMS`.
- The attestation shows that the release workflow of `bnonni/didpkg` made the file, and from which commit. The script does not check it, because the check needs the GitHub CLI. Check it yourself ([manual download](#manual-download), step 3).
- didpkg verifies each package by the DID of its publisher. didpkg does not verify its own binary by a DID.

## Platforms

- Linux: the binaries need glibc. On Alpine and other musl systems, the script stops. Use npm.
- x64: the binaries use the Bun baseline build. Thus, they also run on x64 CPUs with no AVX2.
- macOS: in a Rosetta 2 shell on an Apple silicon Mac, the script installs the arm64 binary.
- Windows: use npm. There is no Windows binary and no PowerShell script.
- Other OS or CPU: the script stops and shows the npm command.
