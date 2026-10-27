# Security policy

## Report a vulnerability

Do not open a public issue for a vulnerability. Send a private report through GitHub: https://github.com/bnonni/didpkg/security/advisories/new.

## Supported versions

didpkg is before 1.0. Only the latest commit on `main` and the latest npm release get security fixes.

## Denylist: compromised DIDs

The old drpm code put the recovery phrases of 2 demo DIDs in public files. The phrases are in the git history of this repo and in a public fork. A history rewrite cannot remove them. Thus, treat both DIDs as compromised:

| DID | Rule |
|---|---|
| `did:dht:umrapzbqwwp67m79koe5yf7x9h7kbzuctt4g6encchptm66dfkfo` | The shim refuses every package from this DID. Never use it again. |
| `did:dht:tzarizg6dprr5x8djfy35h7k86z7hy9bdzzsa4jd9qt7rtnjqg1o` | The shim refuses every package from this DID. Never use it again. |

The shim must apply this list before it resolves the DID. A change to this list needs a security review.

## Secret scan

CI runs gitleaks 8.30.1 on the full git history for each push to `main` and for each pull request. A finding fails the build.
