#!/usr/bin/env node
'use strict';
// Builds the GitHub release notes for a version: the CHANGELOG.md section of that version,
// then the download/installation notes (installer/RELEASE_NOTES.md). GitHub appends the list
// of merged pull requests itself (gh release create --generate-notes).
// Usage: node tools/release-notes.js <version> [outFile]   – exits 1 if CHANGELOG has no entry
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// "## 1.2.3 – date" … up to the next "## " heading
function changelogSection(md, version) {
  const v = String(version).replace(/^v/, '');
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(l => new RegExp(`^##\\s+\\[?v?${v.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim() || null;
}

function build(version) {
  const section = changelogSection(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version} – add "## ${String(version).replace(/^v/, '')} – <date>" first.`);
  const install = fs.readFileSync(path.join(ROOT, 'installer', 'RELEASE_NOTES.md'), 'utf8').trim();
  return `## What's new\n\n${section}\n\n${install}\n`;
}

module.exports = { changelogSection, build };

if (require.main === module) {
  try {
    const notes = build(process.argv[2]);
    if (process.argv[3]) fs.writeFileSync(process.argv[3], notes); else process.stdout.write(notes);
  } catch (e) { console.error(e.message); process.exit(1); }
}
