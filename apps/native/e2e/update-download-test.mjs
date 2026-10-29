import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, '.codex-tmp/update-download-checks');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const serial = process.env.ANDROID_SERIAL ?? 'emulator-5580';
const java = path.join(process.env.JAVA_HOME ?? '', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const cache = path.join(process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), '.gradle'),
  'caches/modules-2/files-2.1');
assert.ok(sdk && process.env.JAVA_HOME, 'ANDROID_HOME and JAVA_HOME are required');
await mkdir(output, { recursive: true });

async function artifactFile(artifact, extension = '.jar') {
  const directory = path.join(cache, artifact);
  for (const hash of await readdir(directory)) {
    const files = await readdir(path.join(directory, hash));
    const name = files.find(file => file.endsWith(extension));
    if (name) return path.join(directory, hash, name);
  }
  throw new Error(`Missing Gradle dependency: ${artifact}. Build the Android project first.`);
}

// Match the Kotlin compiler used by the Expo 53 Android build.
const compiler = await Promise.all([
  'org.jetbrains.kotlin/kotlin-compiler-embeddable/2.0.21',
  'org.jetbrains.kotlin/kotlin-stdlib/2.0.21',
  'org.jetbrains.kotlin/kotlin-script-runtime/2.0.21',
  'org.jetbrains.kotlin/kotlin-reflect/1.6.10',
  'org.jetbrains.intellij.deps/trove4j/1.0.20200330',
  'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.6.4',
  'org.jetbrains/annotations/13.0',
].map(artifact => artifactFile(artifact)));
// Package the same AndroidX implementation as the app, without unrelated AndroidX components.
const core = await artifactFile('androidx.core/core/1.13.1', '.aar');
const coreDirectory = path.join(output, 'androidx-core');
await mkdir(coreDirectory, { recursive: true });
const jarTool = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
const atomicClass = 'androidx/core/util/AtomicFile.class';
await exec(jarTool, ['xf', core, 'classes.jar'], { cwd: coreDirectory });
await exec(jarTool, ['xf', 'classes.jar', atomicClass], { cwd: coreDirectory });
const atomicJar = path.join(coreDirectory, 'atomic-file.jar');
await exec(jarTool, ['cf', atomicJar, atomicClass], { cwd: coreDirectory });
const android = path.join(sdk, 'platforms/android-35/android.jar');
const classes = path.join(output, 'checks.jar');
const dex = path.join(output, 'checks-dex.jar');
const sources = ['UpdateOriginBlocks.kt', 'UpdateFiles.kt', 'UpdateBlockPlan.kt', 'UpdateRequestWindow.kt',
  'UpdateMirrorUrl.kt', 'UpdateCheckpoint.kt', 'UpdateBlockSession.kt', 'UpdateBlockWire.kt',
  'UpdateDownloadSnapshot.kt', 'UpdateDownloadCancellation.kt']
  .map(name => path.join(root, 'apps/native/plugins/appUpdate', name));
sources.push(path.join(root, 'apps/native/plugins/connectivity/NativeConnectivity.kt'));
const storageSources = ['DownloadStorage.kt', 'DownloadTask.kt', 'DownloadImages.kt', 'BulkDownloadStorage.kt',
  'BulkManifest.kt', 'BulkDownloadFailure.kt', 'DownloadSharing.kt', 'DownloadSpeed.kt']
  .map(name => path.join(root, 'apps/native/plugins/downloads', name));
storageSources.push(path.join(root, 'apps/native/plugins/chatPacketCipher/PacketCipher.kt'));
const checks = ['UpdateOriginChecks.kt', 'UpdateDownloadProbe.kt', 'UpdateStorageChecks.kt', 'UpdateTestStorage.kt',
  'UpdatePipelineChecks.kt', 'UpdateSnapshotChecks.kt', 'UpdateCancellationChecks.kt', 'DownloadCheckpointChecks.kt']
  .map(name => fileURLToPath(new URL(`./update-download/${name}`, import.meta.url)));
await exec(java, ['-cp', compiler.join(path.delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
  '-no-stdlib', '-no-reflect', '-jvm-target', '1.8',
  '-classpath', [android, compiler[1], path.join(coreDirectory, 'classes.jar')].join(path.delimiter),
  '-d', classes, ...sources, ...storageSources, ...checks]);
await exec(java, ['-cp', path.join(sdk, 'build-tools/35.0.0/lib/d8.jar'), 'com.android.tools.r8.D8',
  '--min-api', '24', '--lib', android, '--output', dex, classes, compiler[1], atomicJar]);

const live = [];
const localPort = 49351;
let server;
if (process.argv.includes('--local')) {
  assert.ok(!process.argv.includes('--live'), 'Choose --local or --live');
  const bytes = Buffer.alloc(32 * 1024 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range ? Number(range[2]) : bytes.length - 1;
    if (start > end || end >= bytes.length) { response.writeHead(416).end(); return; }
    response.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    response.end(bytes.subarray(start, end + 1));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await exec('adb', ['-s', serial, 'reverse', '--no-rebind', `tcp:${localPort}`, `tcp:${server.address().port}`]);
  live.push('https://github.com/piperhex/remoteai/releases/download/test/android.apk', String(bytes.length),
    createHash('sha256').update(bytes).digest('hex'), `http://127.0.0.1:${localPort}/fixture.apk`);
}
if (process.argv.includes('--live')) {
  const response = await fetch('https://api.github.com/repos/piperhex/remoteai/releases/latest', {
    signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/vnd.github+json' },
  });
  assert.ok(response.ok, `Release lookup returned ${response.status}`);
  const release = await response.json();
  const asset = release.assets.find(item => item.name.endsWith('.apk'));
  assert.match(asset?.digest ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.match(asset.browser_download_url, /^https:\/\/github\.com\/piperhex\/remoteai\/releases\/download\/[\w./-]+$/);
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  live.push(asset.browser_download_url, String(asset.size), asset.digest.slice(7));
  console.log(`Downloading ${asset.name} (${asset.size} bytes) through the production Android downloader`);
}

const remoteJar = '/data/local/tmp/codex-update-download-checks.jar';
await exec('adb', ['-s', serial, 'push', dex, remoteJar]);
try {
  await new Promise((resolve, reject) => {
    const child = spawn('adb', ['-s', serial, 'shell', `CLASSPATH=${remoteJar}`, 'app_process',
      '/system/bin', 'com.codexswitch.update.UpdateDownloadProbe', ...live], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Android checks exited ${code}`)));
  });
} finally {
  await exec('adb', ['-s', serial, 'shell', 'rm', remoteJar]);
  if (server) {
    server.closeAllConnections(); server.close();
    await exec('adb', ['-s', serial, 'reverse', '--remove', `tcp:${localPort}`]);
  }
}
