import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { openAsar, sha256 } from '../src/asar.mjs';
import { inspectArchive } from '../src/preflight.mjs';

function encodeAsar(files, bytes) {
  const json = Buffer.from(JSON.stringify({ files }));
  const length = 8 + json.length + ((4 - json.length % 4) % 4);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(length, 4);
  const header = Buffer.alloc(length);
  header.writeUInt32LE(length - 4, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  return Buffer.concat([prefix, header, bytes]);
}

function fixture(t, files, bytes = Buffer.from('hello')) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-speed-asar-tests-'));
  const path = join(directory, 'app.asar');
  writeFileSync(path, encodeAsar(files, bytes));
  t.after(() => {
    // Remove only this test's own freshly created direct child of the temp dir.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('codex-speed-asar-tests-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return path;
}

test('ASAR reads packed bytes, verifies integrity and fingerprints the whole file', t => {
  const path = fixture(t, {
    'main.js': { size: 5, offset: '0', integrity: { algorithm: 'SHA256', hash: sha256('hello') } },
    'unpacked.js': { size: 999, unpacked: true },
    'linked.js': { link: 'main.js' },
  });
  const archive = openAsar(path);
  try {
    assert.equal(archive.files.length, 1);
    assert.equal(archive.read(archive.files[0]).toString(), 'hello');
    assert.equal(archive.fingerprint().size, statSync(path).size);
  } finally { archive.close(); }
});

test('ASAR rejects checksum mismatch, path traversal and file ranges outside the archive', t => {
  let archive = openAsar(fixture(t, {
    'main.js': { size: 5, offset: '0', integrity: { algorithm: 'SHA256', hash: sha256('other') } },
  }));
  try { assert.throws(() => archive.read(archive.files[0]), /integrity mismatch/); }
  finally { archive.close(); }
  for (const files of [
    { '..': { size: 5, offset: '0' } },
    { 'main.js': { size: 6, offset: '0' } },
    { 'main.js': { size: 1, offset: '9007199254740993' } },
    { 'main.js': { size: -1, offset: '0' } },
  ]) assert.throws(() => openAsar(fixture(t, files)), /Invalid ASAR/);
});

test('ASAR stops if the app changes during inspection', t => {
  const path = fixture(t, { 'main.js': { size: 5, offset: '0' } });
  const archive = openAsar(path);
  try {
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    assert.throws(() => archive.fingerprint(), /updated while being inspected/);
  } finally { archive.close(); }
});

// Handwritten semantic fixtures; these are not extracted Codex files.
const PAIR = 'function hook(host){let cache=readCache(),auth=readAuth(host),managed=auth?.authMethod===`chatgpt`||auth?.authMethod===`personalAccessToken`||auth?.authMethod===`amazonBedrock`,mode=auth?.authMethod??null;let{data:requirements,isPending:pending}=readRequirements(mode),loading=!!auth?.isLoading||managed&&pending,result;cache[3]!==requirements||cache[4]!==loading||cache[5]!==managed?(result=managed&&!loading&&requirements!=null?normalize(requirements):null,cache[3]=requirements,cache[4]=loading,cache[5]=managed,cache[6]=result):result=cache[6];return{serviceTierAccess:result,isLoading:loading}}const diagnostic=`Failed to read service tier for request`;async function requestAccess(store,host){let auth=await readMode(store,host);if(auth!==`chatgpt`&&auth!==`personalAccessToken`&&auth!==`amazonBedrock`)return null;let requirements=await requestRequirements(store,host,{priority:`critical`});return store.query.setData(requirementsQuery,{authMethod:auth,hostId:host},requirements),normalize(requirements)}';

function archiveWithSources(t, sources) {
  const assets = {};
  const bytes = [];
  let offset = 0;
  for (const [name, source] of Object.entries(sources)) {
    const body = Buffer.from(source);
    assets[name] = { size: body.length, offset: String(offset) };
    bytes.push(body);
    offset += body.length;
  }
  return fixture(t, { webview: { files: { assets: { files: assets } } } }, Buffer.concat(bytes));
}

test('preflight requires each target exactly once across all renderer chunks', t => {
  const supported = inspectArchive(archiveWithSources(t, { 'current.js': PAIR }));
  assert.equal(supported.requiredIds.length, 2);
  assert.equal(supported.resources.length, 1);
  assert.equal(supported.resources[0].runtimePath, 'assets/current.js');
  assert.notEqual(supported.resources[0].sourceHash, supported.resources[0].patchedHash);
  assert.equal(sha256(supported.resources[0].content), supported.resources[0].patchedHash);
  assert.throws(() => inspectArchive(archiveWithSources(t, { 'one.js': PAIR, 'two.js': PAIR })), /matched 2 times/);
  assert.throws(() => inspectArchive(archiveWithSources(t, { 'missing.js': 'console.log(1)' })), /matched 0 times/);
});

test('preflight validates generated module syntax before making a launch plan', t => {
  assert.throws(() => inspectArchive(archiveWithSources(t, { 'bad.js': `${PAIR};const broken = ;` })), /syntax validation/);
});
