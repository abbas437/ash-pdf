# winget package: ASHPMCS.ASHPDFStudio

These folders are the manifests for the Windows Package Manager community repository
([microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)). Once a pull request with them is merged,
anyone can install the app with:

```powershell
winget install ASHPMCS.ASHPDFStudio
```

`manifests/a/ASHPMCS/ASHPDFStudio/<version>/` holds three files (schema 1.10.0): the version file, the installer
file (per-user NSIS installer, silent switch `/S` plus `/currentuser`, SHA-256 from the release's `SHA256SUMS.txt`)
and the en-US description.

## Make the manifests for a new release

```sh
gh release download v0.2.18 -R abbas437/ash-pdf -p SHA256SUMS.txt -D /tmp/sums
node scripts/winget-manifest.mjs 0.2.18 /tmp/sums/SHA256SUMS.txt 2026-11-05
```

## Test on Windows (optional)

In an administrator PowerShell, once: `winget settings --enable LocalManifestFiles`. Then, in the repository folder:

```powershell
winget validate --manifest winget\manifests\a\ASHPMCS\ASHPDFStudio\0.2.17
winget install --manifest winget\manifests\a\ASHPMCS\ASHPDFStudio\0.2.17
```

## Submit (first time and each release)

The pull request is opened from the publisher's GitHub account. Either:

1. **wingetcreate** (simplest): `winget install Microsoft.WingetCreate`, then
   `wingetcreate submit --token <GitHub token with public_repo scope> winget\manifests\a\ASHPMCS\ASHPDFStudio\0.2.17`.
   For later releases `wingetcreate update ASHPMCS.ASHPDFStudio --version 0.2.18 --urls <Setup .exe URL> --submit`
   also works without this script.
2. **By hand**: fork microsoft/winget-pkgs, copy the version folder to the same path in the fork
   (`manifests/a/ASHPMCS/ASHPDFStudio/0.2.17/`), commit and open a pull request.

The winget bots install the package in a clean Windows sandbox and scan it; a moderator then merges it. The installer
is not code-signed, which winget accepts, but a SmartScreen or Defender warning in the bot run can delay the review.
