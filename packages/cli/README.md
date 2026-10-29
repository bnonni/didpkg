# didpkg

Install npm packages by DID. A publisher signs each release with a key in its DID document. The didpkg shim on your computer verifies the signature before npm gets the package.

Status: Phase 1 proof of concept. The install-name grammar is draft 1 and can change before 1.0.

## Install

```sh
npm install --global didpkg
```

didpkg needs Node 22 or later.

## Install a package by DID

1. Start the shim: `didpkg shim start`. It runs until you push Ctrl+C, so use a second terminal for the next steps.
2. Add this line to the `.npmrc` file of your project: `@didpkg:registry=http://127.0.0.1:2092/`
3. Install the package with its install name: `npm install @didpkg/hello_web_bnonni.github.io_didpkg-demo`

The shim refuses a package if the signature, the DID document or the release history does not verify.

## More

- All commands: `didpkg --help`
- Quickstart and HTTP errors: https://github.com/bnonni/didpkg/blob/main/docs/quickstart.md
- How didpkg works (trust model and limits): https://github.com/bnonni/didpkg/blob/main/docs/how-it-works.md
- Source and documentation: https://github.com/bnonni/didpkg
- `dist/cli.js` includes third-party packages. Their licenses are in `dist/THIRD_PARTY_LICENSES.txt`.
