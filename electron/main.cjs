const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { existsSync, mkdirSync, readdirSync } = require('fs');
const { readFile, writeFile, mkdir } = require('fs').promises;
const {
  findPython,
  downloadPython,
  installPython,
  createVenv,
  installRembg,
  isRembgInstalled,
  getRembgExe,
} = require('./setup-helpers.cjs');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const isDev = !app.isPackaged;
const SERVER_PORT = 7777;

function getUserDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

const CONFIG_PATH = () => getUserDataPath('config.json');
const VENV_PATH = () => getUserDataPath('venv');
const MODELS_PATH = () => getUserDataPath('models');

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { setupComplete: false };
  }
}

async function saveConfig(patch) {
  let current = {};
  try { current = JSON.parse(await readFile(CONFIG_PATH(), 'utf8')); } catch {}
  const next = { ...current, ...patch };
  mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  await writeFile(CONFIG_PATH(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------------------------------------------------------------------
// rembg server lifecycle
// ---------------------------------------------------------------------------

let rembgProcess = null;
let mainWindow = null;

function startServer(config) {
  if (rembgProcess) stopServer();

  const rembgExe = getRembgExe(config.venvPath || VENV_PATH());
  if (!existsSync(rembgExe)) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:error', { msg: 'rembg executable not found. Please re-run setup.' });
    }
    return;
  }

  mkdirSync(MODELS_PATH(), { recursive: true });

  rembgProcess = spawn(rembgExe, ['s', '--host', '127.0.0.1', '--port', String(SERVER_PORT), '--no-ui'], {
    windowsHide: true,
    env: { ...process.env, U2NET_HOME: MODELS_PATH(), BROWSER: 'nul' },
  });

  rembgProcess.stdout.on('data', (d) => console.log('[rembg]', d.toString().trim()));
  rembgProcess.stderr.on('data', (d) => console.error('[rembg]', d.toString().trim()));
  rembgProcess.on('exit', (code) => {
    rembgProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:error', { msg: `rembg server exited (code ${code})` });
    }
  });

  // Notify renderer once port accepts connections
  pollPortOpen(SERVER_PORT, 60000).then((ok) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (ok) {
      mainWindow.webContents.send('server:ready', { port: SERVER_PORT });
    } else {
      mainWindow.webContents.send('server:error', { msg: 'rembg server did not start in time.' });
    }
  });
}

function stopServer() {
  if (rembgProcess) {
    rembgProcess.kill();
    rembgProcess = null;
  }
}

function pollPortOpen(port, maxMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const tick = () => {
      isPortOpen(port).then((open) => {
        if (open) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(800);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 820,
    minHeight: 580,
    title: 'DeBG',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false, // allows fetch() to localhost rembg server from file://
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (!isDev) Menu.setApplicationMenu(null);

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// IPC: Setup
// ---------------------------------------------------------------------------

ipcMain.handle('setup:check', async () => {
  const config = await loadConfig();
  const venvPath = config.venvPath || VENV_PATH();
  // Run Python detection now so the wizard can show accurate status immediately
  const pythonInfo = findPython();
  return {
    complete: config.setupComplete === true && isRembgInstalled(venvPath),
    config,
    pythonInfo, // { path, version } or null
  };
});

ipcMain.handle('setup:run', async (event, backend) => {
  const send = (data) => {
    if (!event.sender.isDestroyed()) event.sender.send('setup:progress', data);
  };

  try {
    // Step 1 - Python
    send({ step: 1, type: 'status', msg: 'Checking for Python 3.11-3.13...' });
    let pythonInfo = findPython();

    if (!pythonInfo) {
      const installerPath = await downloadPython((p) => send({ step: 1, ...p }));
      const pyExe = await installPython(installerPath, (p) => send({ step: 1, ...p }));
      pythonInfo = { path: pyExe, version: '3.12' };
    } else {
      send({ step: 1, type: 'status', msg: `Found Python ${pythonInfo.version} at ${pythonInfo.path}` });
    }

    await saveConfig({ pythonPath: pythonInfo.path });

    // Step 2 - Venv
    const venvPath = VENV_PATH();
    send({ step: 2, type: 'status', msg: 'Setting up virtual environment…' });
    await createVenv(pythonInfo.path, venvPath, (p) => send({ step: 2, ...p }));
    await saveConfig({ venvPath });

    // Step 3 - rembg
    send({ step: 3, type: 'status', msg: `Installing rembg[${backend},cli]…` });
    await installRembg(venvPath, backend, (p) => send({ step: 3, ...p }));
    await saveConfig({ setupComplete: true, backend });

    return { success: true };
  } catch (err) {
    console.error('Setup error:', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// IPC: Config
// ---------------------------------------------------------------------------

ipcMain.handle('config:get', async () => loadConfig());
ipcMain.handle('config:save', async (_, patch) => saveConfig(patch));

// ---------------------------------------------------------------------------
// IPC: Model cache check
// ---------------------------------------------------------------------------

// Patterns to detect each model's file in U2NET_HOME (case-insensitive).
// u2net needs an exact match so it doesn't false-positive on u2netp / u2net_human_seg.
const MODEL_PATTERNS = {
  'birefnet-general':  /birefnet.general/i,
  'birefnet-portrait': /birefnet.portrait/i,
  'bria-rmbg':         /rmbg/i,
  'isnet-general-use': /isnet.general.use/i,
  'isnet-anime':       /isnet.anime/i,
  'u2net_human_seg':   /u2net_human_seg/i,
  'silueta':           /silueta/i,
  'u2netp':            /u2netp/i,
  'u2net':             /^u2net\.onnx$/i,
};

ipcMain.handle('model:check', (_, modelId) => {
  const dir = MODELS_PATH();
  if (!existsSync(dir)) return false;
  try {
    const pat = MODEL_PATTERNS[modelId];
    if (!pat) return false;
    return readdirSync(dir).some(f => pat.test(f));
  } catch { return false; }
});

// ---------------------------------------------------------------------------
// IPC: Server
// ---------------------------------------------------------------------------

ipcMain.handle('server:status', () => ({
  running: rembgProcess !== null,
  port: SERVER_PORT,
}));

ipcMain.handle('server:restart', async () => {
  const config = await loadConfig();
  startServer(config);
  return { ok: true };
});

ipcMain.handle('server:switch-backend', async (event, backend) => {
  const send = (data) => {
    if (!event.sender.isDestroyed()) event.sender.send('switch:progress', data);
  };

  try {
    stopServer();
    const config = await loadConfig();
    const venvPath = config.venvPath || VENV_PATH();

    send({ type: 'status', msg: `Reinstalling rembg[${backend},cli]…` });
    await installRembg(venvPath, backend, (p) => send(p));
    await saveConfig({ backend });

    startServer({ ...config, venvPath });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// IPC: Output folder / auto-save
// ---------------------------------------------------------------------------

ipcMain.handle('output:get-default', () =>
  path.join(app.getPath('pictures'), 'bg-removed')
);

ipcMain.handle('output:pick-folder', async () => {
  const result = await require('electron').dialog.showOpenDialog(mainWindow, {
    title: 'Choose output folder for saved images',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('output:save-file', async (_, { folder, filename, buffer }) => {
  await mkdir(folder, { recursive: true });
  // Avoid overwriting - append numeric suffix if the file already exists
  let dest = path.join(folder, filename);
  if (existsSync(dest)) {
    const ext  = path.extname(filename);
    const base = filename.slice(0, filename.length - ext.length);
    let n = 2;
    do { dest = path.join(folder, `${base}-${n}${ext}`); n++; } while (existsSync(dest));
  }
  await writeFile(dest, Buffer.from(buffer));
  return dest;
});

ipcMain.handle('output:open-folder', (_, folder) => {
  shell.openPath(folder);
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  createWindow();
  const config = await loadConfig();
  if (config.setupComplete && isRembgInstalled(config.venvPath || VENV_PATH())) {
    startServer(config);
  }
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => stopServer());
