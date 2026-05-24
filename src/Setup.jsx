import { useEffect, useRef, useState } from 'react';
import './Setup.css';

const BACKENDS = [
  {
    id: 'cpu',
    label: 'CPU',
    icon: '🖥',
    title: 'CPU (recommended)',
    desc: 'Works on any Windows machine. ~2-10 s per image depending on model.',
    note: null,
  },
  {
    id: 'gpu',
    label: 'GPU',
    icon: '⚡',
    title: 'NVIDIA GPU (CUDA)',
    desc: 'Requires an NVIDIA GPU with CUDA 11.8+. ~0.2-1 s per image.',
    note: 'If you are unsure, choose CPU. rembg will still work.',
  },
];

export default function Setup({ onComplete }) {
  const [phase, setPhase] = useState('checking'); // checking | select | installing | done | error
  const [pythonFound, setPythonFound] = useState(null); // null | { path, version }
  const [backend, setBackend] = useState('cpu');
  const [log, setLog] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [downloadPct, setDownloadPct] = useState(null);
  const logRef = useRef(null);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Step 0: check system - runs findPython() in the main process
  useEffect(() => {
    (async () => {
      if (!window.electronAPI) { setPhase('select'); return; }
      const { pythonInfo } = await window.electronAPI.checkSetup();
      // pythonInfo comes from a live findPython() call, not cached config
      if (pythonInfo) setPythonFound(pythonInfo);
      setPhase('select');
    })();
  }, []);

  const pushLog = (msg) => setLog((l) => [...l, msg.replace(/\n$/, '')]);

  const startInstall = async () => {
    setPhase('installing');
    setLog([]);
    setDownloadPct(null);

    const result = await window.electronAPI.runSetup(backend, (p) => {
      if (p.type === 'download-progress') {
        setDownloadPct(Math.round(p.pct));
      } else if (p.msg) {
        pushLog(p.msg);
        setDownloadPct(null);
      }
    });

    window.electronAPI.cleanupProgressListener();

    if (result.success) {
      setPhase('done');
    } else {
      setErrorMsg(result.error || 'Unknown error');
      setPhase('error');
    }
  };

  const handleDone = () => {
    // Tell main to start the server now
    window.electronAPI.restartServer();
    onComplete();
  };

  // ---- Render phases ----

  if (phase === 'checking') {
    return (
      <div className="setup-root">
        <div className="setup-card">
          <div className="setup-spinner large" />
          <p className="setup-checking">Checking system…</p>
        </div>
      </div>
    );
  }

  if (phase === 'select') {
    return (
      <div className="setup-root">
        <div className="setup-card wide">
          <div className="setup-logo">
            <div className="setup-logo-icon">⚗</div>
            <div>
              <h1>DeBG</h1>
              <p className="setup-sub">First-time setup - takes 5-10 minutes</p>
            </div>
          </div>

          <div className="setup-steps-bar">
            <span className="step-dot active" />
            <span className="step-line" />
            <span className="step-dot" />
            <span className="step-line" />
            <span className="step-dot" />
          </div>

          {pythonFound ? (
            <div className="setup-info-row ok">
              <span>✓</span>
              <span>Python {pythonFound.version} found. No download needed.</span>
            </div>
          ) : (
            <div className="setup-info-row warn">
              <span>⚠</span>
              <span>Python 3.11-3.13 not found. Installer will download Python 3.12 (~27 MB).</span>
            </div>
          )}

          <h2 className="setup-section-title">Choose compute backend</h2>
          <div className="backend-grid">
            {BACKENDS.map((b) => (
              <button
                key={b.id}
                className={`backend-card ${backend === b.id ? 'selected' : ''}`}
                onClick={() => setBackend(b.id)}
                type="button"
              >
                <div className="backend-icon">{b.icon}</div>
                <div className="backend-title">{b.title}</div>
                <div className="backend-desc">{b.desc}</div>
                {b.note && <div className="backend-note">{b.note}</div>}
                <div className="backend-check">{backend === b.id ? '●' : '○'}</div>
              </button>
            ))}
          </div>

          <button className="setup-btn-primary" onClick={startInstall}>
            Install rembg ({backend.toUpperCase()}) →
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'installing') {
    return (
      <div className="setup-root">
        <div className="setup-card wide">
          <div className="setup-logo small">
            <div className="setup-spinner" />
            <div>
              <h1>Installing…</h1>
              <p className="setup-sub">Do not close this window</p>
            </div>
          </div>

          <div className="setup-steps-bar">
            <span className="step-dot done" />
            <span className="step-line active" />
            <span className="step-dot active" />
            <span className="step-line" />
            <span className="step-dot" />
          </div>

          {downloadPct !== null && (
            <div className="progress-bar-wrap">
              <div className="progress-bar" style={{ width: `${downloadPct}%` }} />
              <span>{downloadPct}%</span>
            </div>
          )}

          <div className="log-box" ref={logRef}>
            {log.map((line, i) => (
              <div key={i} className="log-line">{line}</div>
            ))}
            {log.length === 0 && <div className="log-line muted">Starting…</div>}
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="setup-root">
        <div className="setup-card">
          <div className="setup-done-icon">✓</div>
          <h1>Setup complete!</h1>
          <p className="setup-sub">
            rembg is installed and ready. AI models download automatically on first use
            (~43 MB to 375 MB depending on model chosen).
          </p>
          <button className="setup-btn-primary" onClick={handleDone}>
            Open app →
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="setup-root">
        <div className="setup-card">
          <div className="setup-error-icon">✕</div>
          <h1>Setup failed</h1>
          <pre className="setup-error-msg">{errorMsg}</pre>
          <p className="setup-sub">
            Make sure you have an internet connection and try again. If the problem
            persists, install Python 3.12 manually from python.org, then retry.
          </p>
          <button className="setup-btn-primary" onClick={() => setPhase('select')}>
            ← Try again
          </button>
        </div>
      </div>
    );
  }

  return null;
}
