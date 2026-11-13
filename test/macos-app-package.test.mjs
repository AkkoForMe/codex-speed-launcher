import assert from 'node:assert/strict';
import test from 'node:test';
import { appBuildTarget, appInfoPlist } from '../scripts/build-macos-app.mjs';

test('macOS app builds require a matching native host and support both architectures', () => {
  assert.deepEqual(appBuildTarget('arm64', 'arm64', 'darwin'), { packageTarget: 'darwin-arm64', swiftTarget: 'arm64-apple-macos13.5' });
  assert.deepEqual(appBuildTarget('x64', 'x64', 'darwin'), { packageTarget: 'darwin-x64', swiftTarget: 'x86_64-apple-macos13.5' });
  assert.throws(() => appBuildTarget('x64', 'arm64', 'darwin'), /matching macOS/);
  assert.throws(() => appBuildTarget('arm64', 'arm64', 'win32'), /Build the app on macOS/);
  assert.throws(() => appBuildTarget('ia32', 'ia32', 'darwin'), /matching macOS/);
});

test('app metadata opens an AppKit app and validates release versions', () => {
  const plist = appInfoPlist('0.2.1');
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>CodexSpeedLauncher<\/string>/);
  assert.match(plist, /<key>CFBundlePackageType<\/key><string>APPL<\/string>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>0\.2\.1<\/string>/);
  assert.match(plist, /<key>NSSupportsAutomaticTermination<\/key><false\/>/);
  for (const version of ['bad', '<script>', '0.2.1-beta', '0.2']) assert.throws(() => appInfoPlist(version), /numeric app version/);
});
