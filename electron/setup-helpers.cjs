/**
 * Setup helpers - all Node.js / child-process operations.
 * Called from main.cjs IPC handlers; never runs in the renderer.
 */
const { execSync, spawn } = require('child_process');
const { existsSync, createWriteStream, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');

const PYTHON_VERSION = '3.12.9';
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe`;

// ---------------------------------------------------------------------------
// Python detection
// ---------------------------------------------------------------------------

function findPython() {
  const la = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';

  // Common per-user and system-wide install paths, newest versions first
  const locations = [
    path.join(la, 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(la, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(la, 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(pf, 'Python313', 'python.exe'),
    path.join(pf, 'Python312', 'python.exe'),
    path.join(pf, 'Python311', 'python.exe'),
    'C:\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe',
  ];

  // PATH-based commands checked first (handles custom installs, pyenv, etc.)
  const pathCmds = ['python', 'python3', 'py'];

  for (const cmd of [...pathCmds, ...locations]) {
    if (!pathCmds.includes(cmd) && !existsSync(cmd)) continue;

    const version = tryGetPythonVersion(cmd);
    if (!version) continue;
    const { major, minor } = version;
    if (major === 3 && minor >= 11 && minor < 14) {
      let absPath = cmd;
      if (!cmd.includes(path.sep) && !cmd.includes('/')) {
        try {
          absPath = execSync(`where "${cmd}"`, { encoding: 'utf8', timeout: 3000, windowsHide: true })
            .split('\n')[0].trim();
        } catch { /* keep cmd */ }
      }
      return { path: absPath, version: `${major}.${minor}` };
    }
  }
  return null;
}

/**
 * Try two strategies to get the Python major.minor version for a given executable.
 * Returns { major, minor } or null.
 */
function tryGetPythonVersion(cmd) {
  // Strategy 1: python --version  (handles Store stubs gracefully via exit code)
  try {
    // Redirect stderr to stdout so we capture it even if Python writes there
    const out = execSync(`"${cmd}" --version 2>&1`, {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim();
    const m = out.match(/Python\s+(\d+)\.(\d+)/i);
    if (m) return { major: parseInt(m[1]), minor: parseInt(m[2]) };
  } catch { /* fall through to strategy 2 */ }

  // Strategy 2: python -c print (in case --version isn't in PATH but the exe exists)
  try {
    const out = execSync(
      `"${cmd}" -c "import sys; print(sys.version_info.major, sys.version_info.minor)"`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    ).trim();
    const parts = out.split(/\s+/).map(Number);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return { major: parts[0], minor: parts[1] };
    }
  } catch { /* not found */ }

  return null;
}

// ---------------------------------------------------------------------------
// File download with progress
// ---------------------------------------------------------------------------

async function downloadFile(url, dest, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} - ${url}`);

  const total = parseInt(res.headers.get('content-length') || '0', 10);
  let received = 0;

  const stream = createWriteStream(dest);
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    stream.write(Buffer.from(value));
    received += value.length;
    if (total > 0) {
      onProgress({ type: 'download-progress', received, total, pct: received / total * 100 });
    }
  }
  await new Promise((ok, fail) => stream.end((err) => (err ? fail(err) : ok())));
  return dest;
}

// ---------------------------------------------------------------------------
// Python install
// ---------------------------------------------------------------------------

async function downloadPython(onProgress) {
  onProgress({ type: 'status', msg: `Downloading Python ${PYTHON_VERSION}…` });
  const dest = path.join(os.tmpdir(), `python-${PYTHON_VERSION}-installer.exe`);
  await downloadFile(PYTHON_URL, dest, onProgress);
  return dest;
}

async function installPython(installerPath, onProgress) {
  const installDir = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    'Programs', 'Python', 'Python312'
  );
  onProgress({ type: 'status', msg: `Installing Python 3.12 to ${installDir}…` });

  await runProcess(installerPath, [
    '/quiet',
    'InstallAllUsers=0',
    'PrependPath=0',
    'Include_launcher=0',
    `TargetDir=${installDir}`,
  ], {});

  const pythonExe = path.join(installDir, 'python.exe');
  if (!existsSync(pythonExe)) {
    throw new Error(`Python installer finished but python.exe not found at ${pythonExe}`);
  }
  onProgress({ type: 'status', msg: `Python installed at ${pythonExe}` });
  return pythonExe;
}

// ---------------------------------------------------------------------------
// Venv + rembg
// ---------------------------------------------------------------------------

async function createVenv(pythonPath, venvPath, onProgress) {
  onProgress({ type: 'status', msg: `Creating virtual environment at ${venvPath}…` });
  mkdirSync(path.dirname(venvPath), { recursive: true });
  await runProcess(pythonPath, ['-m', 'venv', '--clear', venvPath], { onData: (d) => onProgress({ type: 'pip', msg: d }) });
  onProgress({ type: 'status', msg: 'Virtual environment created.' });
}

async function installRembg(venvPath, backend, onProgress) {
  // Use "python -m pip" - calling pip.exe directly fails on Windows when upgrading
  // pip itself because the running executable is locked.
  const python = path.join(venvPath, 'Scripts', 'python.exe');
  const pkg = `rembg[${backend},cli]`;

  onProgress({ type: 'status', msg: 'Upgrading pip…' });
  await runProcess(python, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
    onData: (d) => onProgress({ type: 'pip', msg: d }),
  });

  onProgress({ type: 'status', msg: `Installing ${pkg} - this may take a few minutes...` });
  await runProcess(python, ['-m', 'pip', 'install', pkg, '--no-cache-dir'], {
    onData: (d) => onProgress({ type: 'pip', msg: d }),
  });

  onProgress({ type: 'status', msg: `rembg[${backend}] installed successfully.` });
}

function isRembgInstalled(venvPath) {
  return existsSync(path.join(venvPath, 'Scripts', 'rembg.exe'));
}

function getRembgExe(venvPath) {
  return path.join(venvPath, 'Scripts', 'rembg.exe');
}

// ---------------------------------------------------------------------------
// Generic subprocess runner
// ---------------------------------------------------------------------------

function runProcess(exe, args, { onData } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true });
    let out = '';
    let err = '';

    proc.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      onData?.(s);
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      onData?.(s); // pip uses stderr for progress too
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`Process exited ${code}:\n${err.slice(-800)}`));
    });
    proc.on('error', (e) => reject(new Error(`Failed to start process: ${e.message}`)));
  });
}

module.exports = {
  findPython,
  downloadPython,
  installPython,
  createVenv,
  installRembg,
  isRembgInstalled,
  getRembgExe,
};
