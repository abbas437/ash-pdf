#!/usr/bin/env node
// winget manifests for a release: writes winget/manifests/a/ASHPMCS/<App>/<version>/ (version, installer and
// en-US locale files, schema 1.10.0) from package.json and the release's SHA256SUMS.txt.
// Run: node scripts/winget-manifest.mjs <version> <SHA256SUMS.txt> [release date YYYY-MM-DD]
// Submit the folder to microsoft/winget-pkgs as described in winget/README.md.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const APPS = {
  'ash-pdf': {
    id: 'ASHPMCS.ASHPDFStudio', folder: 'ASHPDFStudio', repo: 'abbas437/ash-pdf', moniker: 'ash-pdf-studio',
    license: 'MIT',
    short: 'Free, open-source PDF viewer and editor for Windows: view, search, annotate, sign, edit pages and fill forms.',
    description: 'ASH PDF Studio is a free, open-source (MIT) PDF viewer and editor for Windows. It renders with Mozilla pdf.js and '
      + 'adds tabs, thumbnails, bookmarks and layers; find in the document and advanced search across folders of PDFs; '
      + 'shapes, text boxes, callouts, highlights, sticky notes and stamps saved as real PDF annotations; a comments panel '
      + 'with status and CSV export; a signature library; page tools (rotate, reorder, insert, extract, crop, merge, split); '
      + 'headers, footers, page numbers, watermarks and Bates numbering; form filling and printing. Everything runs on your '
      + 'computer; files are not uploaded anywhere.',
    tags: ['pdf', 'pdf-viewer', 'pdf-editor', 'annotate', 'sign', 'merge', 'split', 'forms', 'open-source'],
    ext: ['pdf'],
  },
  'ash-draw': {
    id: 'ASHPMCS.ASHDrawStudio', folder: 'ASHDrawStudio', repo: 'abbas437/ash-draw', moniker: 'ash-draw-studio',
    license: 'MIT (the bundled LibreDWG converters are GPL-3.0-or-later)',
    short: 'Free, open-source DXF drawing viewer and editor for Windows; opens and saves DWG through bundled LibreDWG converters.',
    description: 'ASH Draw Studio is a free, open-source (MIT) drawing viewer and editor for Windows. It opens, edits and saves '
      + 'DXF drawings (R12 to R2018) and DWG files through the separately bundled LibreDWG converters. It shows layers, '
      + 'colours, linetypes, blocks, hatches, text, dimensions and leaders; draws and modifies with object snaps, ortho and '
      + 'polar tracking and an AutoCAD-style command line; and exports to PDF, SVG and PNG. Everything runs on your computer.',
    tags: ['dxf', 'dwg', 'cad', 'drawing', 'viewer', 'editor', 'autocad', 'open-source'],
    ext: ['dxf', 'dwg'],
  },
};

const [version, sumsPath, dateArg] = process.argv.slice(2);
const app = APPS[pkg.name];
if (!app || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !sumsPath) {
  console.error('usage: node scripts/winget-manifest.mjs <version e.g. 0.2.17> <SHA256SUMS.txt> [YYYY-MM-DD]');
  process.exit(2);
}
const setup = pkg.build.nsis.artifactName.replace('${version}', version).replace('${ext}', 'exe');
const sums = await readFile(sumsPath, 'utf8');
const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(' ' + setup) || l.trim().endsWith('*' + setup));
const sha = line?.trim().split(/\s+/)[0];
if (!/^[0-9a-f]{64}$/i.test(sha ?? '')) { console.error(`no SHA-256 for ${setup} in ${sumsPath}`); process.exit(1); }
if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) { console.error('release date must be YYYY-MM-DD'); process.exit(2); }

const product = pkg.build.productName ?? pkg.productName;
const publisher = pkg.author;
const gh = `https://github.com/${app.repo}`;
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const head = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.10.0.schema.json\n# Created by scripts/winget-manifest.mjs\n\n`;
const tail = (type) => `ManifestType: ${type}\nManifestVersion: 1.10.0\n`;
const ident = `PackageIdentifier: ${app.id}\nPackageVersion: ${version}\n`;

const files = {
  [`${app.id}.yaml`]: head('version') + ident + 'DefaultLocale: en-US\n' + tail('version'),
  [`${app.id}.installer.yaml`]: head('installer') + ident
    + 'InstallerLocale: en-US\nMinimumOSVersion: 10.0.0.0\nInstallerType: nullsoft\nScope: user\n'
    + 'InstallModes:\n- interactive\n- silent\n- silentWithProgress\n'
    + 'InstallerSwitches:\n  Custom: /currentuser\nUpgradeBehavior: install\n'
    + `FileExtensions:\n${app.ext.map((e) => `- ${e}\n`).join('')}`
    + (dateArg ? `ReleaseDate: ${dateArg}\n` : '')
    + `AppsAndFeaturesEntries:\n- DisplayName: ${q(`${product} ${version}`)}\n  Publisher: ${q(publisher)}\n  DisplayVersion: ${version}\n`
    + `Installers:\n- Architecture: x64\n  InstallerUrl: ${gh}/releases/download/v${version}/${setup}\n  InstallerSha256: ${sha.toUpperCase()}\n`
    + tail('installer'),
  [`${app.id}.locale.en-US.yaml`]: head('defaultLocale') + ident + 'PackageLocale: en-US\n'
    + `Publisher: ${q(publisher)}\nPublisherUrl: https://ashpmcs.com/\nPublisherSupportUrl: ${gh}/issues\n`
    + `Author: ${q(publisher)}\nPackageName: ${q(product)}\nPackageUrl: https://ashdesignsuite.com/studio/\n`
    + `License: ${q(app.license)}\nLicenseUrl: ${gh}/blob/main/LICENSE\nCopyright: ${q(pkg.build.copyright)}\n`
    + `ShortDescription: ${q(app.short)}\nDescription: ${q(app.description)}\nMoniker: ${app.moniker}\n`
    + `Tags:\n${app.tags.map((t) => `- ${t}\n`).join('')}`
    + `ReleaseNotesUrl: ${gh}/releases/tag/v${version}\n`
    + `Documentations:\n- DocumentLabel: User guide\n  DocumentUrl: https://ashdesignsuite.com/help/${pkg.name === 'ash-pdf' ? 'pdf-studio' : 'draw-studio'}/\n`
    + tail('defaultLocale'),
};

const dir = join(root, 'winget', 'manifests', 'a', 'ASHPMCS', app.folder, version);
await mkdir(dir, { recursive: true });
for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
console.log(`winget manifests: ${dir.slice(root.length + 1)} (${setup} ${sha.slice(0, 12)}…)`);
