/**
 * Pack chrome-extension/ into dist/outlook-token-fetcher-v{version}.zip
 * Uses only Node built-ins + PowerShell Compress-Archive on Windows when needed.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const extDir = path.join(root, 'chrome-extension');
const distDir = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const version = manifest.version || '0.0.0';
const outZip = path.join(distDir, `outlook-token-fetcher-v${version}.zip`);

if (!fs.existsSync(extDir)) {
  console.error('chrome-extension/ not found');
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

// Prefer PowerShell on Windows (no extra deps).
const ps = `
$ErrorActionPreference = 'Stop'
$src = '${extDir.replace(/'/g, "''")}'
$dst = '${outZip.replace(/'/g, "''")}'
if (Test-Path $dst) { Remove-Item $dst -Force }
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -Force
Write-Output $dst
`;

try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  console.log(`Packed: ${outZip}`);
} catch (e) {
  console.error('Pack failed. Install zip tooling or run Compress-Archive manually.');
  process.exit(1);
}
