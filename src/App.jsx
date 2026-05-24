import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import './App.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_PORT = 7777;
const SERVER_URL  = `http://127.0.0.1:${SERVER_PORT}`;
const PAGE_SIZE   = 24;

const MODELS = [
  { id: 'birefnet-general',   label: 'BiRefNet General',  hint: 'Best quality, any subject',         dl: '~375 MB' },
  { id: 'birefnet-portrait',  label: 'BiRefNet Portrait', hint: 'Best for people & hair',            dl: '~375 MB' },
  { id: 'bria-rmbg',          label: 'BRIA RMBG',         hint: 'E-commerce / advertising quality',  dl: '~176 MB' },
  { id: 'isnet-general-use',  label: 'ISNet General',     hint: 'Fast + high accuracy',              dl: '~176 MB' },
  { id: 'u2net',              label: 'U²Net',             hint: 'Classic general-purpose',           dl: '~176 MB' },
  { id: 'u2net_human_seg',    label: 'U²Net Human',       hint: 'Specialized for people',            dl: '~176 MB' },
  { id: 'silueta',            label: 'Silueta',           hint: 'Compact & fast (43 MB)',            dl: '~43 MB'  },
  { id: 'isnet-anime',        label: 'ISNet Anime',       hint: 'Anime & illustrations',             dl: '~176 MB' },
  { id: 'u2netp',             label: 'U²Net Lite',        hint: 'Smallest, fastest inference',       dl: '~4.7 MB' },
];

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];

const DEFAULT_SETTINGS = {
  threshold:  0,
  feather:    0,
  morphSize:  0,
  outputMode: 'transparent',
  bgColor:    '#ffffff',
  alphaMatte: false,
};

function uid()       { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function baseName(n) { const d = n.lastIndexOf('.'); return d > 0 ? n.slice(0, d) : n; }

// ---------------------------------------------------------------------------
// Before/after compare slider (used in the lightbox)
// ---------------------------------------------------------------------------

function CompareSlider({ original, result }) {
  const [split, setSplit] = useState(50);
  const containerRef = useRef(null);
  const dragging     = useRef(false);

  const applyX = useCallback((clientX) => {
    if (!containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    setSplit(Math.max(0, Math.min(100, (clientX - r.left) / r.width * 100)));
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      applyX(e.touches ? e.touches[0].clientX : e.clientX);
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener('mousemove',  onMove);
    window.addEventListener('mouseup',    onUp);
    window.addEventListener('touchmove',  onMove, { passive: true });
    window.addEventListener('touchend',   onUp);
    return () => {
      window.removeEventListener('mousemove',  onMove);
      window.removeEventListener('mouseup',    onUp);
      window.removeEventListener('touchmove',  onMove);
      window.removeEventListener('touchend',   onUp);
    };
  }, [applyX]);

  return (
    <div
      className="compare-slider"
      ref={containerRef}
      onMouseDown={(e)  => { dragging.current = true; applyX(e.clientX); }}
      onTouchStart={(e) => { dragging.current = true; applyX(e.touches[0].clientX); }}
    >
      {/* Original image fills the whole area (visible on left of handle) */}
      <img src={original} className="compare-img" alt="original" draggable={false} />

      {/* Result clipped to the left portion of the slider */}
      {result && (
        <div className="compare-result-clip" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          <div className="compare-checker-bg" />
          <img src={result} className="compare-img" alt="result" draggable={false} />
        </div>
      )}

      {/* Divider + knob - only shown when both images are present */}
      {result && (
        <div className="compare-handle" style={{ left: `${split}%` }}>
          <div className="compare-line" />
          <div className="compare-knob">⇔</div>
        </div>
      )}

      {/* Labels */}
      <span className="compare-lbl lbl-l">Before</span>
      {result && <span className="compare-lbl lbl-r">After</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function App() {
  const [model,    setModel]    = useState('birefnet-general');
  const [items,    setItems]    = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [status,   setStatus]   = useState({ phase: 'idle', msg: 'Ready.' });
  const [serverOk,       setServerOk]       = useState(false);
  const [serverStarting, setServerStarting] = useState(true);   // true until first connect or error
  const [startupSlow,    setStartupSlow]    = useState(false);  // true after 45 s without connect
  const [downloading,     setDownloading]     = useState(false);
  const [modelDownloading, setModelDownloading] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  const [switchLog,  setSwitchLog]  = useState([]);
  const [config,     setConfig]     = useState({});

  // Output folder
  const [outputFolder, setOutputFolder] = useState(null); // null = not set, string = absolute path
  const [savedCount,   setSavedCount]   = useState(0);
  const outputFolderRef = useRef(null);
  outputFolderRef.current = outputFolder;

  // Gallery state
  const [viewMode,   setViewMode]   = useState('grid-large'); // 'grid-large' | 'grid-small' | 'list'
  const [page,       setPage]       = useState(0);
  const [lightboxId, setLightboxId] = useState(null);

  const workerRef      = useRef(null);
  const itemsRef       = useRef(items);    itemsRef.current    = items;
  const settingsRef    = useRef(settings); settingsRef.current = settings;
  const reprocessTimer = useRef(null);
  const dropRef        = useRef(null);
  const cancelRef      = useRef(false);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const pending    = useMemo(() => items.filter(it => it.status === 'queued' || it.status === 'processing'), [items]);
  const done       = useMemo(() => items.filter(it => it.status === 'done'), [items]);
  const isBusy     = status.phase === 'processing';
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages - 1);

  const pagedItems = useMemo(
    () => items.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [items, safePage],
  );

  const lightboxIdx  = useMemo(() => items.findIndex(it => it.id === lightboxId), [items, lightboxId]);
  const lightboxItem = lightboxIdx >= 0 ? items[lightboxIdx] : null;

  // Clamp page when items are removed
  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page]);

  // Lock body scroll while lightbox is open
  useEffect(() => {
    document.body.style.overflow = lightboxId ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [lightboxId]);

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (!lightboxId) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        setLightboxId(null);
      } else if (e.key === 'ArrowRight' && lightboxIdx < items.length - 1) {
        setLightboxId(items[lightboxIdx + 1].id);
      } else if (e.key === 'ArrowLeft' && lightboxIdx > 0) {
        setLightboxId(items[lightboxIdx - 1].id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxId, lightboxIdx, items]);

  // -------------------------------------------------------------------------
  // Worker lifecycle
  // -------------------------------------------------------------------------

  useEffect(() => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    workerRef.current = w;

    w.onmessage = ({ data: msg }) => {
      switch (msg.stage) {
        case 'process-done': {
          const url  = URL.createObjectURL(msg.resultBlob);
          const item = itemsRef.current.find(it => it.id === msg.id);
          setItems(prev => prev.map(it => it.id === msg.id
            ? { ...it, status: 'done', maskFloat: msg.maskFloat, resultBlob: msg.resultBlob, resultUrl: url }
            : it));
          // Auto-save to output folder if one is configured
          if (outputFolderRef.current && window.electronAPI && item) {
            const filename = `${baseName(item.name)}.png`;
            msg.resultBlob.arrayBuffer().then(buf =>
              window.electronAPI.saveFile(outputFolderRef.current, filename, buf)
                .then(() => setSavedCount(n => n + 1))
                .catch(err => console.error('Auto-save failed:', err))
            );
          }
          break;
        }
        case 'reprocess-done': {
          const url = URL.createObjectURL(msg.resultBlob);
          setItems(prev => prev.map(it => it.id === msg.id
            ? { ...it, status: 'done', resultBlob: msg.resultBlob, resultUrl: url }
            : it));
          break;
        }
        case 'reprocess-batch-done':
          setStatus({ phase: 'done', msg: 'Settings applied.' });
          break;
        case 'error':
          setItems(prev => prev.map(it => it.id === msg.id
            ? { ...it, status: 'error', error: msg.error }
            : it));
          break;
      }
    };

    return () => { w.terminate(); workerRef.current = null; };
  }, []);

  useEffect(() => () => {
    itemsRef.current.forEach(it => {
      if (it.sourceUrl) URL.revokeObjectURL(it.sourceUrl);
      if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
    });
  }, []);

  // -------------------------------------------------------------------------
  // Server health polling
  // -------------------------------------------------------------------------

  useEffect(() => {
    // In browser dev mode there is no startup phase
    if (!window.electronAPI) setServerStarting(false);

    const markReady = () => { setServerOk(true); setServerStarting(false); };
    const markError = () => { setServerOk(false); setServerStarting(false); };

    const check = async () => {
      try {
        await fetch(`${SERVER_URL}/`, { signal: AbortSignal.timeout(2000) });
        markReady();
      } catch {
        setServerOk(false);
      }
    };

    if (window.electronAPI) {
      window.electronAPI.onServerReady(markReady);
      window.electronAPI.onServerError(markError);
      window.electronAPI.getConfig().then(c => {
        setConfig(c || {});
        if (c?.outputFolder) setOutputFolder(c.outputFolder);
      });
    }

    // After 45 s without connecting, show a "still loading" sub-message
    const slowTimer = setTimeout(() => setStartupSlow(true), 45_000);

    check();
    const id = setInterval(check, 6000);
    return () => {
      clearInterval(id);
      clearTimeout(slowTimer);
      window.electronAPI?.removeServerListeners();
    };
  }, []);

  // -------------------------------------------------------------------------
  // File handling
  // -------------------------------------------------------------------------

  const addFiles = useCallback((fileList) => {
    const files = Array.from(fileList).filter(f => ACCEPTED.includes(f.type));
    if (!files.length) return;
    setItems(prev => [...prev, ...files.map(file => ({
      id: uid(), name: file.name, file,
      sourceUrl: URL.createObjectURL(file),
      status: 'queued', maskFloat: null,
      origWidth: 0, origHeight: 0,
      resultBlob: null, resultUrl: null, error: null,
    }))]);
  }, []);

  useEffect(() => {
    const node = dropRef.current;
    if (!node) return;
    const prev  = e => { e.preventDefault(); e.stopPropagation(); };
    const over  = e => { prev(e); node.classList.add('drop-active'); };
    const leave = e => { prev(e); node.classList.remove('drop-active'); };
    const drop  = e => { prev(e); node.classList.remove('drop-active'); addFiles(e.dataTransfer.files); };
    node.addEventListener('dragover',  over);
    node.addEventListener('dragleave', leave);
    node.addEventListener('drop',      drop);
    return () => {
      node.removeEventListener('dragover',  over);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop',      drop);
    };
  }, [addFiles]);

  // -------------------------------------------------------------------------
  // Settings + debounced reprocess
  // -------------------------------------------------------------------------

  const triggerReprocess = useCallback((next) => {
    clearTimeout(reprocessTimer.current);
    reprocessTimer.current = setTimeout(() => {
      if (!workerRef.current) return;
      const doneItems = itemsRef.current.filter(it => it.maskFloat && it.status === 'done');
      if (!doneItems.length) return;
      setItems(prev => prev.map(it => it.maskFloat && it.status === 'done' ? { ...it, status: 'applying' } : it));
      setStatus({ phase: 'processing', msg: 'Applying settings…' });
      workerRef.current.postMessage({
        type: 'reprocess',
        payload: {
          items: doneItems.map(it => ({ id: it.id, maskFloat: it.maskFloat, imageBlob: it.file, width: it.origWidth, height: it.origHeight })),
          settings: next,
        },
      });
    }, 320);
  }, []);

  const updateSetting = useCallback((key, value) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      triggerReprocess(next);
      return next;
    });
  }, [triggerReprocess]);

  // -------------------------------------------------------------------------
  // Batch processing
  // -------------------------------------------------------------------------

  const processAll = async () => {
    if (!serverOk) { setStatus({ phase: 'error', msg: 'Server not connected. Wait for it to start or click Reconnect.' }); return; }
    const queued = items.filter(it => it.status === 'queued');
    if (!queued.length) return;

    cancelRef.current = false;
    setStatus({ phase: 'processing', msg: `Processing 0 / ${queued.length}…` });

    const modelInfo = MODELS.find(m => m.id === model);

    for (let i = 0; i < queued.length; i++) {
      if (cancelRef.current) {
        setItems(prev => prev.map(it => it.status === 'processing' ? { ...it, status: 'queued' } : it));
        setStatus({ phase: 'idle', msg: 'Cancelled.' });
        break;
      }
      const item = queued[i];
      setItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'processing' } : it));
      setStatus({ phase: 'processing', msg: `${i + 1} / ${queued.length}: ${item.name}` });

      try {
        const isCached = window.electronAPI
          ? await window.electronAPI.checkModelCached(model)
          : true;

        if (!isCached) {
          setModelDownloading(true);
          setStatus({ phase: 'processing', msg: `Downloading ${modelInfo?.label} model (${modelInfo?.dl}) - first use, please wait...` });
        }

        const { maskBlob, width, height } = await fetchMask(item, model, settings.alphaMatte);
        setModelDownloading(false);

        await new Promise((resolve, reject) => {
          const handler = ({ data: msg }) => {
            if (msg.id !== item.id) return;
            if (msg.stage === 'process-done' || msg.stage === 'error') {
              workerRef.current.removeEventListener?.('message', handler);
              workerRef.current.onmessage = workerRef.current._origHandler;
              msg.stage === 'error' ? reject(new Error(msg.error)) : resolve();
            }
          };
          const origHandler = workerRef.current.onmessage;
          workerRef.current._origHandler = origHandler;
          workerRef.current.addEventListener('message', handler);

          workerRef.current.postMessage({
            type: 'process',
            payload: { id: item.id, maskBlob, imageBlob: item.file, width, height, settings: settingsRef.current },
          });
        });

        setItems(prev => prev.map(it => it.id === item.id ? { ...it, origWidth: width, origHeight: height } : it));
      } catch (err) {
        setModelDownloading(false);
        setItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'error', error: err.message } : it));
      }
    }

    setModelDownloading(false);
    if (!cancelRef.current) setStatus({ phase: 'done', msg: 'Batch complete.' });
    cancelRef.current = false;
  };

  // -------------------------------------------------------------------------
  // Fetch mask from rembg server
  // -------------------------------------------------------------------------

  async function fetchMask(item, modelId, alphaMatte) {
    const bmp    = await createImageBitmap(item.file);
    const width  = bmp.width;
    const height = bmp.height;
    bmp.close();

    const form = new FormData();
    form.append('file',  item.file, item.name);
    form.append('model', modelId);
    form.append('om', 'true');
    if (alphaMatte) form.append('a', 'true');

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 300_000);
    try {
      const res = await fetch(`${SERVER_URL}/api/remove`, {
        method: 'POST', body: form, signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`rembg error ${res.status}: ${txt.slice(0, 200)}`);
      }
      const maskBlob = await res.blob();
      return { maskBlob, width, height };
    } finally {
      clearTimeout(timeout);
    }
  }

  // -------------------------------------------------------------------------
  // Item management
  // -------------------------------------------------------------------------

  const removeItem = id => {
    setItems(prev => {
      const v = prev.find(it => it.id === id);
      if (v?.sourceUrl) URL.revokeObjectURL(v.sourceUrl);
      if (v?.resultUrl) URL.revokeObjectURL(v.resultUrl);
      return prev.filter(it => it.id !== id);
    });
  };

  const clearAll = () => {
    items.forEach(it => {
      URL.revokeObjectURL(it.sourceUrl);
      if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
    });
    setItems([]);
    setPage(0);
    setLightboxId(null);
    setSavedCount(0);
    setStatus({ phase: 'idle', msg: 'Ready.' });
  };

  const handlePickFolder = async () => {
    if (!window.electronAPI) return;
    const folder = await window.electronAPI.pickOutputFolder();
    if (folder) {
      setOutputFolder(folder);
      window.electronAPI.saveConfig({ outputFolder: folder });
    }
  };

  const handleOpenFolder = () => {
    if (outputFolder && window.electronAPI) window.electronAPI.openFolder(outputFolder);
  };

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  const downloadZip = async () => {
    if (!done.length) return;
    setDownloading(true);
    try {
      const zip  = new JSZip();
      const used = new Map();
      for (const it of done) {
        let name = `${baseName(it.name)}.png`;
        const n  = (used.get(name) ?? 0) + 1; used.set(name, n);
        if (n > 1) name = `${baseName(it.name)}-${n}.png`;
        zip.file(name, it.resultBlob);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      saveAs(blob, `bg-removed-${new Date().toISOString().slice(0, 10)}.zip`);
    } finally { setDownloading(false); }
  };

  const downloadSingle = it => {
    if (it.resultBlob) saveAs(it.resultBlob, `${baseName(it.name)}.png`);
  };

  // -------------------------------------------------------------------------
  // Backend switch
  // -------------------------------------------------------------------------

  const doSwitchBackend = async (newBackend) => {
    setSwitchLog([]);
    const result = await window.electronAPI.switchBackend(newBackend, p => {
      if (p.msg) setSwitchLog(l => [...l, p.msg]);
    });
    window.electronAPI.cleanupSwitchListener();
    if (result.success) {
      setConfig(c => ({ ...c, backend: newBackend }));
      setShowSwitch(false);
      setServerOk(false);
    } else {
      setSwitchLog(l => [...l, `Error: ${result.error}`]);
    }
  };

  // -------------------------------------------------------------------------
  // Lightbox helpers
  // -------------------------------------------------------------------------

  const openLightbox = useCallback((id, e) => {
    e?.stopPropagation();
    setLightboxId(id);
  }, []);

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  const morphLabel = settings.morphSize === 0 ? '0'
    : settings.morphSize > 0 ? `+${settings.morphSize} expand` : `${settings.morphSize} shrink`;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="app">

      {/* ---- Header ---- */}
      <header>
        <div className="title-row">
          <h1>DeBG</h1>
          <div className={`server-pill ${serverOk ? 'ok' : serverStarting ? 'starting' : 'off'}`}>
            <span className="server-dot" />
            {serverOk ? 'Server ready' : serverStarting ? 'Starting up...' : 'Server offline'}
          </div>
          {!serverOk && !serverStarting && window.electronAPI && (
            <button className="btn btn-ghost small" onClick={() => window.electronAPI.restartServer()}>
              Reconnect
            </button>
          )}
        </div>
        <p className="sub">
          Powered by <strong>rembg</strong> running locally. No internet needed after first model download.
        </p>
      </header>

      {/* ---- Server startup banner ---- */}
      {serverStarting && (
        <div className="startup-banner">
          <div className="startup-top">
            <div className="startup-spinner" />
            <div className="startup-text">
              <span className="startup-title">Starting rembg server...</span>
              <span className="startup-sub">
                {startupSlow
                  ? 'Still loading - can take up to a minute on slower machines.'
                  : 'Usually ready in 10-20 seconds. The app will unlock automatically.'}
              </span>
            </div>
          </div>
          <div className="startup-track">
            <div className="startup-fill" />
          </div>
        </div>
      )}

      {/* ---- Model picker ---- */}
      <section className="controls">
        <div className="model-picker">
          <label className="section-label">Model</label>
          <div className="model-grid">
            {MODELS.map(m => (
              <button key={m.id} type="button"
                className={`model-chip ${model === m.id ? 'chip-active' : ''}`}
                onClick={() => setModel(m.id)}
                disabled={isBusy}
              >
                <span className="model-name">{m.label}</span>
                <span className="model-hint">{m.hint}</span>
                <span className="model-dl">{m.dl} on first use</span>
              </button>
            ))}
          </div>
        </div>

        <div className="actions">
          <button className="btn btn-primary" onClick={processAll} disabled={isBusy || !pending.length || !serverOk}>
            {isBusy ? 'Processing…' : `Remove backgrounds (${pending.length})`}
          </button>
          {isBusy && (
            <button className="btn btn-danger" onClick={() => { cancelRef.current = true; }}>
              Cancel
            </button>
          )}
          <button className="btn btn-secondary" onClick={downloadZip} disabled={!done.length || downloading || isBusy}>
            {downloading ? 'Zipping…' : `Download ZIP (${done.length})`}
          </button>
          <button className="btn btn-ghost" onClick={clearAll} disabled={!items.length || isBusy}>
            Clear
          </button>
          {window.electronAPI && (
            <button className="btn btn-ghost small" onClick={() => { setShowSwitch(s => !s); setSwitchLog([]); }}>
              Backend: {config.backend?.toUpperCase() || '…'}
            </button>
          )}
        </div>

        {/* Output folder bar - Electron only */}
        {window.electronAPI && (
          <div className="output-bar">
            <span className="output-bar-label">Output</span>
            {outputFolder ? (
              <span className="output-path" title={outputFolder}>{outputFolder}</span>
            ) : (
              <span className="output-none">No folder set. Results not auto-saved to disk</span>
            )}
            <div className="output-bar-btns">
              {outputFolder && (
                <button className="btn btn-ghost small" onClick={handleOpenFolder}>Open ↗</button>
              )}
              <button className="btn btn-ghost small" onClick={handlePickFolder}>
                {outputFolder ? 'Change' : 'Set folder'}
              </button>
            </div>
            {savedCount > 0 && (
              <span className="output-saved">{savedCount} auto-saved</span>
            )}
          </div>
        )}
      </section>

      {/* ---- Backend switch panel ---- */}
      {showSwitch && (
        <section className="switch-panel">
          <p className="switch-title">Switch compute backend (reinstalls rembg - takes a few minutes)</p>
          <div className="switch-row">
            {['cpu', 'gpu'].map(b => (
              <button key={b} className={`chip-sm ${config.backend === b ? 'chip-active' : ''}`}
                onClick={() => doSwitchBackend(b)} type="button">
                {b.toUpperCase()}
              </button>
            ))}
          </div>
          {switchLog.length > 0 && (
            <div className="log-box short">
              {switchLog.map((l, i) => <div key={i} className="log-line">{l}</div>)}
            </div>
          )}
        </section>
      )}

      {/* ---- Settings ---- */}
      <section className="settings-panel">
        <div className="settings-grid">
          <div className="setting">
            <div className="setting-header">
              <span className="setting-label">Threshold</span>
              <span className="setting-value">{settings.threshold.toFixed(2)}</span>
            </div>
            <input type="range" min={0} max={0.99} step={0.01} value={settings.threshold}
              onChange={e => updateSetting('threshold', parseFloat(e.target.value))} />
            <div className="setting-hint">Higher → removes more · Lower → keeps more</div>
          </div>

          <div className="setting">
            <div className="setting-header">
              <span className="setting-label">Edge Feather</span>
              <span className="setting-value">{settings.feather}px</span>
            </div>
            <input type="range" min={0} max={20} step={1} value={settings.feather}
              onChange={e => updateSetting('feather', parseInt(e.target.value))} />
            <div className="setting-hint">Softens edges - good for hair and fur</div>
          </div>

          <div className="setting">
            <div className="setting-header">
              <span className="setting-label">Shrink / Expand</span>
              <span className="setting-value">{morphLabel}</span>
            </div>
            <input type="range" min={-5} max={5} step={1} value={settings.morphSize}
              onChange={e => updateSetting('morphSize', parseInt(e.target.value))} />
            <div className="setting-hint">Negative = tighten mask (remove halo) · Positive = loosen</div>
          </div>

          <div className="setting">
            <div className="setting-header">
              <span className="setting-label">Background</span>
            </div>
            <div className="output-mode-row">
              {['transparent', 'color', 'blur'].map(m => (
                <button key={m} type="button"
                  className={`chip-sm ${settings.outputMode === m ? 'chip-active' : ''}`}
                  onClick={() => updateSetting('outputMode', m)}>
                  {m === 'transparent' ? 'Transparent' : m === 'color' ? 'Solid color' : 'Blur original'}
                </button>
              ))}
              {settings.outputMode === 'color' && (
                <label className="color-pick">
                  <input type="color" value={settings.bgColor} onChange={e => updateSetting('bgColor', e.target.value)} />
                  <span className="color-swatch" style={{ background: settings.bgColor }} />
                </label>
              )}
            </div>
            <div className="setting-hint">Burned into the exported PNG</div>
          </div>

          <div className="setting">
            <div className="setting-header">
              <span className="setting-label">Alpha Matting</span>
              <span className="setting-value">{settings.alphaMatte ? 'On' : 'Off'}</span>
            </div>
            <div className="output-mode-row">
              <button type="button" className={`chip-sm ${settings.alphaMatte ? 'chip-active' : ''}`}
                onClick={() => updateSetting('alphaMatte', !settings.alphaMatte)}>
                {settings.alphaMatte ? '✓ Enabled' : 'Disabled'}
              </button>
            </div>
            <div className="setting-hint">rembg alpha matting - much better hair/fur edges (slower)</div>
          </div>
        </div>
      </section>

      {/* ---- Drop zone ---- */}
      <section ref={dropRef} className="dropzone" onClick={() => document.getElementById('file-input').click()}>
        <input id="file-input" type="file" accept={ACCEPTED.join(',')} multiple
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }} hidden />
        <div className="dropzone-inner">
          <div className="drop-icon">＋</div>
          <div><strong>Drop images here</strong> or click to browse</div>
          <div className="drop-sub">PNG · JPG · WEBP · BMP - multiple files at once</div>
        </div>
      </section>

      {/* ---- Status ---- */}
      <div className={`status status-${status.phase}`}>
        <span className="status-dot" />
        <span>{status.msg}</span>
      </div>

      {/* ---- Gallery ---- */}
      {items.length > 0 && (
        <section className="gallery-section">

          {/* Toolbar: count + view toggle */}
          <div className="gallery-toolbar">
            <span className="gallery-count">
              {items.length} image{items.length !== 1 ? 's' : ''}
              {done.length > 0 && <> · <span className="count-done">{done.length} done</span></>}
            </span>
            <div className="view-toggle">
              <button
                className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => { setViewMode('list'); setPage(0); }}
                title="List view"
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <rect x="1" y="2" width="13" height="2" rx="1" fill="currentColor"/>
                  <rect x="1" y="6.5" width="13" height="2" rx="1" fill="currentColor"/>
                  <rect x="1" y="11" width="13" height="2" rx="1" fill="currentColor"/>
                </svg>
              </button>
              <button
                className={`view-btn ${viewMode === 'grid-small' ? 'active' : ''}`}
                onClick={() => { setViewMode('grid-small'); setPage(0); }}
                title="Small grid"
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <rect x="1"   y="1"   width="5.5" height="5.5" rx="1" fill="currentColor"/>
                  <rect x="8.5" y="1"   width="5.5" height="5.5" rx="1" fill="currentColor"/>
                  <rect x="1"   y="8.5" width="5.5" height="5.5" rx="1" fill="currentColor"/>
                  <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1" fill="currentColor"/>
                </svg>
              </button>
              <button
                className={`view-btn ${viewMode === 'grid-large' ? 'active' : ''}`}
                onClick={() => { setViewMode('grid-large'); setPage(0); }}
                title="Large grid"
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <rect x="1"   y="1"   width="6" height="6" rx="1.5" fill="currentColor"/>
                  <rect x="8"   y="1"   width="6" height="6" rx="1.5" fill="currentColor"/>
                  <rect x="1"   y="8"   width="6" height="6" rx="1.5" fill="currentColor"/>
                  <rect x="8"   y="8"   width="6" height="6" rx="1.5" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Cards */}
          <div className={`gallery gallery-${viewMode}`}>
            {pagedItems.map(it => {
              // ---- List view ----
              if (viewMode === 'list') {
                return (
                  <article key={it.id} className={`card card-list card-${it.status}`}
                    onClick={() => openLightbox(it.id)}>
                    <div className="list-thumbs">
                      <img src={it.sourceUrl} className="list-thumb" alt="" />
                      <div className={`list-thumb-result ${it.resultUrl ? 'thumb-checker' : ''}`}>
                        {it.resultUrl ? (
                          <img src={it.resultUrl} className="list-thumb" alt="" />
                        ) : it.status === 'processing' ? (
                          <div className="list-spinner"><div className="spinner sm" /></div>
                        ) : (
                          <div className="list-spinner muted" />
                        )}
                      </div>
                    </div>
                    <span className="list-name" title={it.name}>{it.name}</span>
                    <span className={`list-badge badge-${it.status}`}>
                      {it.status === 'processing' && modelDownloading ? 'downloading' : it.status}
                    </span>
                    <div className="card-actions" onClick={e => e.stopPropagation()}>
                      {it.status === 'done' && (
                        <button className="btn btn-link" onClick={() => downloadSingle(it)}>↓ PNG</button>
                      )}
                      <button className="btn btn-link danger"
                        onClick={() => removeItem(it.id)}
                        disabled={isBusy && it.status === 'processing'}>✕</button>
                    </div>
                  </article>
                );
              }

              // ---- Small grid ----
              if (viewMode === 'grid-small') {
                return (
                  <article key={it.id} className={`card card-small card-${it.status}`}
                    onClick={() => openLightbox(it.id)} title={it.name}>
                    <div className="small-thumb thumb-checker">
                      {it.resultUrl ? (
                        <img src={it.resultUrl} alt={it.name} />
                      ) : it.status === 'processing' ? (
                        <div className="placeholder">
                          <div className="spinner" />
                        </div>
                      ) : it.status === 'error' ? (
                        <div className="placeholder error">✕</div>
                      ) : (
                        <img src={it.sourceUrl} alt={it.name} className="queued-preview" />
                      )}
                      <span className={`status-badge-dot badge-${it.status}`} />
                    </div>
                    <div className="small-name">{it.name}</div>
                  </article>
                );
              }

              // ---- Large grid (default) ----
              return (
                <article key={it.id} className={`card card-${it.status}`}>
                  <div className="card-pair" onClick={() => openLightbox(it.id)}
                    style={{ cursor: 'pointer' }} title="Click to compare">
                    <div className="thumb">
                      <img src={it.sourceUrl} alt={it.name} />
                      <span className="tag">Original</span>
                    </div>
                    <div className="thumb thumb-checker">
                      {it.resultUrl ? (
                        <>
                          <img src={it.resultUrl} alt="result" />
                          {it.status === 'applying' && (
                            <div className="applying-overlay"><div className="spinner" /></div>
                          )}
                        </>
                      ) : it.status === 'error' ? (
                        <div className="placeholder error">✕ {it.error}</div>
                      ) : it.status === 'processing' ? (
                        <div className="placeholder">
                          <div className="spinner" />
                          {modelDownloading ? 'Downloading model…' : 'Processing…'}
                        </div>
                      ) : (
                        <div className="placeholder muted">Pending</div>
                      )}
                      <span className="tag">Result</span>
                    </div>
                  </div>
                  <div className="card-meta">
                    <span className="name" title={it.name}>{it.name}</span>
                    <div className="card-actions">
                      {it.status === 'done' && (
                        <button className="btn btn-link" onClick={() => downloadSingle(it)}>↓ PNG</button>
                      )}
                      <button className="btn btn-link danger" onClick={() => removeItem(it.id)}
                        disabled={isBusy && it.status === 'processing'}>Remove</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="pagination">
              <button className="pg-btn" disabled={safePage === 0} onClick={() => setPage(0)}>«</button>
              <button className="pg-btn" disabled={safePage === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
              <span className="pg-info">Page {safePage + 1} of {totalPages}</span>
              <button className="pg-btn" disabled={safePage >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next ›</button>
              <button className="pg-btn" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»</button>
            </div>
          )}
        </section>
      )}

      {/* ---- Lightbox ---- */}
      {lightboxId && lightboxItem && (
        <div className="lightbox-overlay" onClick={() => setLightboxId(null)}>
          <div className="lightbox-box" onClick={e => e.stopPropagation()}>

            <div className="lightbox-hdr">
              <span className="lightbox-name" title={lightboxItem.name}>{lightboxItem.name}</span>

              <div className="lightbox-nav">
                <button className="lb-nav-btn" disabled={lightboxIdx <= 0}
                  onClick={() => setLightboxId(items[lightboxIdx - 1].id)}>←</button>
                <span className="lb-counter">{lightboxIdx + 1} / {items.length}</span>
                <button className="lb-nav-btn" disabled={lightboxIdx >= items.length - 1}
                  onClick={() => setLightboxId(items[lightboxIdx + 1].id)}>→</button>
              </div>

              <div className="lightbox-actions">
                {lightboxItem.resultBlob && (
                  <button className="btn btn-link" onClick={() => downloadSingle(lightboxItem)}>↓ PNG</button>
                )}
                <button className="lb-close" onClick={() => setLightboxId(null)}>✕</button>
              </div>
            </div>

            {lightboxItem.resultUrl ? (
              <CompareSlider
                original={lightboxItem.sourceUrl}
                result={lightboxItem.resultUrl}
              />
            ) : (
              <div className="lb-original-only">
                <img src={lightboxItem.sourceUrl} alt={lightboxItem.name} className="lb-original-img" />
                <div className="lb-pending-msg">
                  {lightboxItem.status === 'processing'
                    ? (modelDownloading ? '⬇ Downloading model for first use…' : '⏳ Processing…')
                    : lightboxItem.status === 'error'
                      ? `✕ Error: ${lightboxItem.error}`
                      : 'Not processed yet. Click Remove backgrounds to generate result.'}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <footer>
        <span>
          <a href="https://github.com/danielgatis/rembg" target="_blank" rel="noreferrer">danielgatis/rembg</a>
          {' · '}
          <a href="https://huggingface.co/briaai/RMBG-1.4" target="_blank" rel="noreferrer">briaai/RMBG-1.4</a>
        </span>
        <span>DeBG - local, private, no uploads</span>
      </footer>
    </div>
  );
}
