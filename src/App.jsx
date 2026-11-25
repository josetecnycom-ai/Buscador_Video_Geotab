import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonType } from "@geotab/zenith";
import { call, extractCapture, extractStatus, listCameras, makeClips, makeRequestEventName, rangeDurationSeconds, sessionInfo } from "./geotab.js";

const STORAGE_PREFIX = "vtcplus-video-requests-v1";
const MAX_PENDING = 16;
const MAX_RANGE_SECONDS = 20 * 60;
const ACTIVE = new Set(["PLANNED", "SENDING", "QUEUED", "SENT", "ONGOING", "DUPLICATE"]);
const DONE = new Set(["COMPLETED", "FAIL", "EXPIRED", "REJECTED", "ERROR"]);

function readHistory(key) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(rows) ? rows.map((row) => ({
      ...row,
      cameraSerial: String(row?.cameraSerial || row?.cameraSerialNumber || row?.camera?.cameraSerialNumber || ""),
    })) : [];
  } catch {
    return [];
  }
}

function ButtonView({ children, onClick, disabled, type = "secondary", className = "" }) {
  const buttonType = type === "primary" ? ButtonType.Primary : ButtonType.Secondary;
  return <Button type={buttonType} onClick={onClick} disabled={disabled} className={className}>{children}</Button>;
}

function formatClipStart(row) {
  const date = new Date(row.fromDate);
  if (Number.isNaN(date.getTime())) return row.fromDate;
  try {
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: row.timeZone || "UTC",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return row.fromDate;
  }
}

function statusLabel(status) {
  if (status === "PLANNED") return "PENDIENTE DE ENVÍO";
  if (status === "SENDING") return "ENVIANDO";
  return status;
}

export default function App({ api }) {
  const [database, setDatabase] = useState("");
  const [cameras, setCameras] = useState([]);
  const [camera, setCamera] = useState(null);
  const [query, setQuery] = useState("");
  const [loadingCameras, setLoadingCameras] = useState(true);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [history, setHistory] = useState([]);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState({ text: "", type: "" });
  const [loadError, setLoadError] = useState("");
  const [limitDialogOpen, setLimitDialogOpen] = useState(false);
  const refreshBusy = useRef(false);
  const workerBusy = useRef(false);

  const storageKey = useMemo(() => database ? `${STORAGE_PREFIX}:${database}` : "", [database]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return cameras;
    return cameras.filter((item) => [item.licensePlate, item.assetName, item.cameraSerial, item.cameraName, item.deviceSerial]
      .some((value) => value?.toLocaleLowerCase().includes(needle)));
  }, [cameras, query]);
  const visibleHistory = useMemo(() => history.filter((row) => !camera || row.cameraSerial === camera.cameraSerial), [history, camera]);
  const pending = useMemo(() => history.filter((row) => ACTIVE.has(row.status)), [history]);

  const saveHistory = useCallback((rows) => {
    setHistory(rows);
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(rows));
  }, [storageKey]);

  const reloadCameras = useCallback(async () => {
    setLoadingCameras(true);
    setLoadError("");
    try {
      const items = await listCameras(api);
      setCameras(items);
      if (camera) setCamera(items.find((item) => item.cameraSerial === camera.cameraSerial) || null);
    } catch (error) {
      setLoadError(error.message || "No se pudieron cargar las cámaras.");
    } finally {
      setLoadingCameras(false);
    }
  }, [api, camera]);

  useEffect(() => {
    let alive = true;
    sessionInfo(api).then((session) => {
      if (!alive) return;
      const activeDatabase = String(session?.database || "");
      setDatabase(activeDatabase);
      if (!activeDatabase) setLoadError("La sesión activa no incluye la base de datos.");
    }).catch((error) => alive && setLoadError(error.message));
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (!database) return undefined;
    let alive = true;
    const savedHistory = readHistory(`${STORAGE_PREFIX}:${database}`);
    setHistory(savedHistory);
    setCamera(null);
    setLoadingCameras(true);
    setLoadError("");
    listCameras(api).then((items) => {
      if (!alive) return;
      setCameras(items);
      const pendingRows = savedHistory
        .filter((row) => row.cameraSerial && ACTIVE.has(row.status))
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const pendingCamera = pendingRows
        .map((row) => items.find((item) => item.cameraSerial === row.cameraSerial))
        .find(Boolean);
      if (pendingCamera) {
        setCamera(pendingCamera);
      } else if (pendingRows.length) {
        setNotice({ type: "error", text: "Hay solicitudes locales, pero no encuentro su cámara en la lista actual. Pulsa «Actualizar» para volver a cargarla." });
      }
    }).catch((error) => {
      if (alive) setLoadError(error.message || "No se pudieron cargar las cámaras.");
    }).finally(() => {
      if (alive) setLoadingCameras(false);
    });
    return () => { alive = false; };
  }, [api, database]);

  const refreshStatuses = useCallback(async () => {
    if (workerBusy.current || refreshBusy.current || !history.some((row) => row.requestId && ACTIVE.has(row.status))) return;
    refreshBusy.current = true;
    try {
      const updated = await Promise.all(history.map(async (row) => {
        if (!row.requestId || !ACTIVE.has(row.status)) return row;
        try {
          const result = await call(api, "Get", {
            typeName: "CameraEventCaptureRequest",
            search: { eventCaptureRequestId: [row.requestId] },
          });
          const status = extractStatus(result);
          return status ? { ...row, ...status, updatedAt: new Date().toISOString() } : row;
        } catch (error) {
          return { ...row, lastError: error.message || "No se pudo consultar el estado." };
        }
      }));
      saveHistory(updated);
    } finally {
      refreshBusy.current = false;
    }
  }, [api, history, saveHistory]);

  useEffect(() => {
    const timer = window.setInterval(refreshStatuses, 30000);
    const onFocus = () => refreshStatuses();
    window.addEventListener("focus", onFocus);
    window.addEventListener("vtc-video-focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("vtc-video-focus", onFocus);
    };
  }, [refreshStatuses]);

  const submitRange = async (resume = false, retryErrors = false) => {
    if (!camera || !database) return;
    let rows = history;
    let newClips = [];
    let scopeKeys = new Set();
    if (!resume) {
      if (!camera.timeZone) {
        setNotice({ type: "error", text: "MyGeotab no informó la zona horaria de este activo; no enviaré horas con una conversión dudosa." });
        return;
      }
      let clips;
      try {
        clips = makeClips(start, end, camera.timeZone, camera.cameraSerial, database, camera.licensePlate || camera.assetName || camera.cameraSerial);
      } catch (error) {
        setNotice({ type: "error", text: error.message });
        return;
      }
      const knownKeys = new Set(history.map((row) => row.key));
      newClips = clips.filter((clip) => !knownKeys.has(clip.key));
      scopeKeys = new Set(clips.map((clip) => clip.key));
      const plan = newClips.map((clip) => ({
        ...clip,
        assetName: camera.assetName,
        licensePlate: camera.licensePlate,
        timeZone: camera.timeZone,
        status: "PLANNED",
        requestId: "",
        failureReason: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      rows = [...history, ...plan];
      saveHistory(rows);
    } else if (retryErrors) {
      const retryKeys = new Set(rows
        .filter((row) => row.cameraSerial === camera.cameraSerial && row.status === "ERROR" && !row.requestId)
        .map((row) => row.key));
      scopeKeys = retryKeys;
      rows = rows.map((row) => retryKeys.has(row.key)
        ? {
          ...row,
          requestEventName: makeRequestEventName(row.fromDate, row.timeZone, row.licensePlate || row.assetName, row.cameraSerial),
          status: "PLANNED",
          failureReason: "",
          lastError: "",
          updatedAt: new Date().toISOString(),
        }
        : row);
      saveHistory(rows);
    } else {
      scopeKeys = new Set(rows
        .filter((row) => row.cameraSerial === camera.cameraSerial && (ACTIVE.has(row.status) || row.status === "PLANNED"))
        .map((row) => row.key));
      rows = rows.map((row) => row.cameraSerial === camera.cameraSerial && row.status === "PLANNED" && !row.requestId
        ? {
          ...row,
          requestEventName: makeRequestEventName(row.fromDate, row.timeZone, row.licensePlate || row.assetName, row.cameraSerial),
          updatedAt: new Date().toISOString(),
        }
        : row);
      saveHistory(rows);
    }
    if (!rows.some((row) => row.cameraSerial === camera.cameraSerial && (ACTIVE.has(row.status) || row.status === "PLANNED"))) {
      const previousFailure = rows.find((row) => scopeKeys.has(row.key) && ["FAIL", "EXPIRED", "REJECTED", "ERROR"].includes(row.status));
      setNotice(previousFailure
        ? { type: "error", text: `Una solicitud del intervalo ya terminó como ${previousFailure.status}. ${previousFailure.failureReason || "Revisa el historial."}` }
        : { type: "info", text: "No hay solicitudes pendientes para esta cámara." });
      return;
    }
    workerBusy.current = true;
    setWorking(true);
    setNotice({ type: "info", text: retryErrors ? `Reintentando ${scopeKeys.size} solicitudes fallidas…` : resume ? "Reanudando las solicitudes guardadas…" : `${newClips.length} clips nuevos preparados; se enviarán por tandas.` });
    try {
      // Resume is safe: recorded IDs are polled, never submitted again.
      for (let offset = 0; offset < rows.length; offset += MAX_PENDING) {
        const wave = rows.filter((row) => row.cameraSerial === camera.cameraSerial && row.requestId && ACTIVE.has(row.status));
        for (const row of wave) {
          try {
            const result = await call(api, "Get", {
              typeName: "CameraEventCaptureRequest",
              search: { eventCaptureRequestId: [row.requestId] },
            });
            const state = extractStatus(result);
            if (state) rows = rows.map((item) => item.key === row.key ? { ...item, ...state, updatedAt: new Date().toISOString() } : item);
          } catch (error) {
            rows = rows.map((item) => item.key === row.key ? { ...item, lastError: error.message } : item);
          }
        }
        saveHistory(rows);
        const outstanding = rows.filter((row) => row.cameraSerial === camera.cameraSerial && row.requestId && ACTIVE.has(row.status));
        if (outstanding.length) {
          setNotice({ type: "info", text: `${outstanding.length} solicitudes pendientes. Esperando a que MyGeotab libere espacio…` });
          let consecutivePollFailures = 0;
          while (rows.some((row) => row.cameraSerial === camera.cameraSerial && row.requestId && ACTIVE.has(row.status))) {
            await new Promise((resolve) => window.setTimeout(resolve, 30000));
            let pollFailed = false;
            const refreshed = await Promise.all(rows.map(async (row) => {
              if (row.cameraSerial !== camera.cameraSerial || !row.requestId || !ACTIVE.has(row.status)) return row;
              try {
                const result = await call(api, "Get", {
                  typeName: "CameraEventCaptureRequest",
                  search: { eventCaptureRequestId: [row.requestId] },
                });
                const state = extractStatus(result);
                return state ? { ...row, ...state, updatedAt: new Date().toISOString() } : row;
              } catch (error) {
                pollFailed = true;
                return { ...row, lastError: error.message || "Error consultando el estado." };
              }
            }));
            rows = refreshed;
            saveHistory(rows);
            consecutivePollFailures = pollFailed ? consecutivePollFailures + 1 : 0;
            if (consecutivePollFailures >= 3) {
              setNotice({ type: "error", text: "MyGeotab aceptó solicitudes, pero falló tres veces seguidas al consultar sus estados. Se detuvo el indicador; conserva los identificadores y vuelve a actualizar más tarde." });
              return;
            }
          }
        }
        const terminalFailure = rows.find((row) => scopeKeys.has(row.key) && ["FAIL", "EXPIRED", "REJECTED", "ERROR"].includes(row.status));
        if (terminalFailure) {
          setNotice({ type: "error", text: `La solicitud ${terminalFailure.index} terminó como ${terminalFailure.status}. ${terminalFailure.failureReason || terminalFailure.lastError || "Revisa el estado en el historial."} No se enviaron automáticamente los siguientes clips.` });
          return;
        }
        const unsent = rows.filter((row) => row.cameraSerial === camera.cameraSerial && ["PLANNED", "SENDING"].includes(row.status));
        if (!unsent.length) break;
        const nextWave = unsent.slice(0, MAX_PENDING);
        for (let sendIndex = 0; sendIndex < nextWave.length; sendIndex += 1) {
          const row = nextWave[sendIndex];
          rows = rows.map((item) => item.key === row.key ? { ...item, status: "SENDING", updatedAt: new Date().toISOString(), lastError: "" } : item);
          saveHistory(rows);
          setNotice({ type: "info", text: `Enviando clip ${sendIndex + 1} de ${nextWave.length} de esta tanda a MyGeotab…` });
          try {
            const result = await call(api, "Add", {
              typeName: "CameraEventCaptureRequest",
              entity: {
                cameraSerialNumber: row.cameraSerial,
                fromDate: row.fromDate,
                durationSeconds: row.durationSeconds,
                requestEventName: row.requestEventName,
                mediaType: "VIDEO",
              },
            });
            const captured = extractCapture(result);
            rows = rows.map((item) => item.key === row.key ? { ...item, ...captured, updatedAt: new Date().toISOString() } : item);
            saveHistory(rows);
            if (!captured.requestId) throw new Error(captured.failureReason || "MyGeotab no devolvió el identificador de solicitud.");
          } catch (error) {
            rows = rows.map((item) => item.key === row.key ? { ...item, status: item.status === "REJECTED" ? "REJECTED" : "ERROR", failureReason: error.message, updatedAt: new Date().toISOString() } : item);
            saveHistory(rows);
            throw error;
          }
        }
        setNotice({ type: "info", text: `Enviada una tanda de ${nextWave.length}. Esperando el resultado de MyGeotab…` });
        let consecutivePollFailures = 0;
        while (rows.some((row) => nextWave.some((sent) => sent.key === row.key) && row.requestId && ACTIVE.has(row.status))) {
          await new Promise((resolve) => window.setTimeout(resolve, 30000));
          let pollFailed = false;
          rows = await Promise.all(rows.map(async (row) => {
            if (!nextWave.some((sent) => sent.key === row.key) || !row.requestId || !ACTIVE.has(row.status)) return row;
            try {
              const result = await call(api, "Get", {
                typeName: "CameraEventCaptureRequest",
                search: { eventCaptureRequestId: [row.requestId] },
              });
              const state = extractStatus(result);
              return state ? { ...row, ...state, updatedAt: new Date().toISOString() } : row;
            } catch (error) {
              pollFailed = true;
              return { ...row, lastError: error.message || "Error consultando el estado." };
            }
          }));
          saveHistory(rows);
          consecutivePollFailures = pollFailed ? consecutivePollFailures + 1 : 0;
          if (consecutivePollFailures >= 3) {
            setNotice({ type: "error", text: "MyGeotab aceptó solicitudes, pero falló tres veces seguidas al consultar sus estados. Se detuvo el indicador; conserva los identificadores y vuelve a actualizar más tarde." });
            return;
          }
        }
        const failure = rows.find((row) => nextWave.some((sent) => sent.key === row.key) && ["FAIL", "EXPIRED", "REJECTED", "ERROR"].includes(row.status));
        if (failure) {
          setNotice({ type: "error", text: `La solicitud ${failure.index} terminó como ${failure.status}. ${failure.failureReason || failure.lastError || "Revisa el historial."} No se enviaron automáticamente los siguientes clips.` });
          return;
        }
      }
      setNotice({ type: "success", text: "Todas las solicitudes de este intervalo han finalizado. Los vídeos se consultan desde MyGeotab." });
    } catch (error) {
      setNotice({ type: "error", text: error.message || "No se pudo completar la solicitud." });
    } finally {
      workerBusy.current = false;
      setWorking(false);
    }
  };

  const startNewRequest = async () => {
    if (!camera || !start || !end) {
      setNotice({ type: "error", text: "Selecciona una cámara e indica el intervalo completo." });
      return;
    }
    if (rangeValidation.seconds > MAX_RANGE_SECONDS) {
      setLimitDialogOpen(true);
      return;
    }
    if (rangeValidation.error) {
      setNotice({ type: "error", text: rangeValidation.error });
      return;
    }
    try {
      const clips = makeClips(start, end, camera.timeZone, camera.cameraSerial, database, camera.licensePlate || camera.assetName || camera.cameraSerial);
      const exists = clips.some((clip) => history.some((row) => row.key === clip.key));
      if (!window.confirm(`Se solicitará vídeo para ${camera.assetName} (${camera.cameraSerial}). El intervalo se dividirá en clips de hasta 2 minutos. ¿Continuar?`)) return;
      if (exists) setNotice({ type: "info", text: "Los clips ya registrados no se duplicarán; se solicitarán solo los que falten." });
      await submitRange(false);
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    }
  };

  const resumePending = async () => {
    if (!camera) {
      setNotice({ type: "error", text: "Selecciona la cámara de los clips pendientes antes de reanudar." });
      return;
    }
    await submitRange(true);
  };

  const retryFailed = async () => {
    if (!camera) {
      setNotice({ type: "error", text: "Selecciona la cámara de las solicitudes fallidas antes de reintentar." });
      return;
    }
    await submitRange(true, true);
  };

  const activeCount = history.filter((row) => row.cameraSerial === camera?.cameraSerial && ACTIVE.has(row.status)).length;
  const failedRetryCount = history.filter((row) => row.cameraSerial === camera?.cameraSerial && row.status === "ERROR" && !row.requestId).length;
  const rangeValidation = useMemo(() => {
    if (!camera || !start || !end) return { seconds: null, error: "" };
    try {
      const seconds = rangeDurationSeconds(start, end, camera.timeZone);
      return seconds > MAX_RANGE_SECONDS
        ? { seconds, error: "El intervalo supera el máximo permitido de 20 minutos. Reduce la hora de inicio o fin para continuar." }
        : { seconds, error: "" };
    } catch (error) {
      return { seconds: null, error: error.message || "Revisa las fechas y horas seleccionadas." };
    }
  }, [camera, start, end]);

  return (
    <main className="vr-shell">
      <header className="vr-header">
        <div className="vr-brand-mark" aria-hidden="true">▶</div>
        <div className="vr-heading">
          <div className="vr-eyebrow">MYGEOTAB · GESTIÓN DE VÍDEO</div>
          <h1>Solicitud de vídeo</h1>
          <p>Solicita grabaciones directamente a la cámara y consúltalas después en MyGeotab.</p>
        </div>
        <div className={`vr-session ${database ? "is-connected" : "is-connecting"}`}><span className="vr-dot" />{database ? "Conectado" : "Conectando…"}<span className="vr-database">{database || "Cargando base…"}</span></div>
      </header>

      {notice.text && <div className={`vr-notice vr-notice--${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</div>}
      {loadError && <div className="vr-notice vr-notice--error" role="alert">{loadError}</div>}

      <div className="vr-layout">
        <section className="vr-card vr-form-card">
          <div className="vr-card-heading"><span className="vr-step">1</span><div><h2>Elige una cámara</h2><p>Busca por matrícula, activo o serie de cámara.</p></div><ButtonView onClick={reloadCameras} disabled={loadingCameras}>Actualizar</ButtonView></div>
          <label className="vr-label" htmlFor="camera-search">Buscar en {cameras.length} cámaras</label>
          <input id="camera-search" className="vr-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ej.: 1234 ABC, furgón, GEJ9WK…" />
          <div className="vr-camera-list" aria-label="Cámaras disponibles">
            {loadingCameras && <div className="vr-empty"><span className="vr-spinner" />Cargando cámaras de esta base…</div>}
            {!loadingCameras && filtered.length === 0 && <div className="vr-empty">No hay cámaras que coincidan con la búsqueda.</div>}
            {!loadingCameras && filtered.slice(0, 100).map((item) => (
              <button type="button" key={item.cameraSerial} className={`vr-camera ${camera?.cameraSerial === item.cameraSerial ? "is-selected" : ""}`} onClick={() => setCamera(item)} aria-pressed={camera?.cameraSerial === item.cameraSerial}>
                <span className="vr-camera-icon" aria-hidden="true">◉</span>
                <span className="vr-camera-info"><strong>{item.licensePlate || item.assetName}</strong><span>{item.licensePlate ? item.assetName : `Cámara ${item.cameraSerial}`}</span></span>
                <span className="vr-camera-serial">{item.cameraSerial}</span>
                <span className="vr-check" aria-hidden="true">{camera?.cameraSerial === item.cameraSerial ? "✓" : ""}</span>
              </button>
            ))}
            {!loadingCameras && filtered.length > 100 && <div className="vr-list-foot">Se muestran 100 resultados. Escribe más caracteres para afinar la búsqueda.</div>}
          </div>
          {camera && <div className="vr-selected"><span className="vr-selected-label">CÁMARA SELECCIONADA</span><strong>{camera.licensePlate ? `${camera.licensePlate} · ` : ""}{camera.assetName}</strong><span>Serie {camera.cameraSerial} · Zona horaria {camera.timeZone || "no disponible"}</span></div>}

          <div className="vr-divider" />
          <div className="vr-card-heading"><span className="vr-step">2</span><div><h2>Indica el intervalo</h2><p>Las fechas se interpretan en la hora local del activo.</p></div></div>
          <div className="vr-date-grid">
            <div><label className="vr-label" htmlFor="range-start">Desde</label><input id="range-start" type="datetime-local" className="vr-input" value={start} onChange={(event) => setStart(event.target.value)} /></div>
            <div><label className="vr-label" htmlFor="range-end">Hasta</label><input id="range-end" type="datetime-local" className="vr-input" value={end} onChange={(event) => setEnd(event.target.value)} /></div>
          </div>
          {rangeValidation.error && start && end && <div className="vr-range-warning" role="alert">{rangeValidation.error}</div>}
          <div className="vr-info-strip"><span aria-hidden="true">ⓘ</span><span>Máximo 20 minutos por solicitud. El vídeo se divide en clips de hasta 2 minutos; la cámara entrega las vistas y el audio que tenga habilitados.</span></div>
          <div className="vr-form-actions">
            <ButtonView type="primary" onClick={startNewRequest} disabled={!camera || !start || !end || working || !camera.timeZone || Boolean(rangeValidation.error && rangeValidation.seconds <= MAX_RANGE_SECONDS)}>Solicitar capturas</ButtonView>
            {activeCount > 0 && <ButtonView onClick={resumePending} disabled={working}>Reanudar {activeCount} pendientes</ButtonView>}
            {failedRetryCount > 0 && <ButtonView onClick={retryFailed} disabled={working}>Reintentar {failedRetryCount} errores</ButtonView>}
            {working && <span className="vr-working"><span className="vr-spinner" />Procesando solicitudes</span>}
          </div>
        </section>

        <aside className="vr-side">
          <section className="vr-card vr-summary">
            <div className="vr-summary-top"><span className="vr-summary-icon" aria-hidden="true">▣</span><div><h2>Estado de solicitudes</h2><p>Esta base de datos</p></div></div>
            <div className="vr-stat"><strong>{history.length}</strong><span>clips en historial local</span></div>
            <div className="vr-stat"><strong>{pending.length}</strong><span>pendientes de completar</span></div>
            <div className="vr-capacity"><span>Cola por cámara</span><strong>Máximo 16 solicitudes</strong></div>
            <p className="vr-side-note">Las solicitudes siguen su curso en MyGeotab aunque cierres esta página. Al volver, se consultan los estados y puedes reanudar los clips que falten.</p>
          </section>
        <section className="vr-card vr-history-card">
            <div className="vr-history-heading"><div><h2>Actividad reciente</h2><p>{camera ? camera.assetName : "Todas las cámaras"}</p></div><ButtonView onClick={() => {
              const pendingToSend = history.filter((row) => ["PLANNED", "SENDING"].includes(row.status));
              const requestsWithId = history.some((row) => row.requestId && ACTIVE.has(row.status));
              if (!requestsWithId && pendingToSend.length) {
                setNotice({ type: "info", text: `${pendingToSend.length} clips siguen pendientes de envío. Selecciona la cámara correspondiente y pulsa «Reanudar».` });
              } else if (!requestsWithId) {
                setNotice({ type: "info", text: "No hay solicitudes de MyGeotab que necesiten actualizar su estado." });
              } else {
                refreshStatuses();
              }
            }} disabled={working}>↻</ButtonView></div>
            {visibleHistory.length === 0 ? <div className="vr-empty vr-history-empty">Todavía no hay solicitudes en este navegador.</div> : (
              <div className="vr-history-list">
                {[...visibleHistory].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((row) => (
                  <div className="vr-history-row" key={row.key}>
                    <div className={`vr-status-dot status-${row.status}`} />
                    <div className="vr-history-main"><strong>{row.licensePlate || row.assetName}</strong><span>{formatClipStart(row)} · {row.durationSeconds}s · hora local del activo</span>{["PLANNED", "SENDING"].includes(row.status) && <em>{row.status === "PLANNED" ? "Aún no consta como enviada a MyGeotab. Pulsa «Reanudar» para continuar." : "Enviando a MyGeotab; esperando respuesta."}</em>}{row.failureReason && <em>{row.failureReason}</em>}{row.lastError && !row.failureReason && <em>{row.lastError}</em>}</div>
                    <span className={`vr-pill status-${row.status}`}>{statusLabel(row.status)}</span>
                  </div>
                ))}
              </div>
            )}
            {visibleHistory.length > 30 && <p className="vr-list-foot">Mostrando las 30 más recientes. Se conservan {visibleHistory.length}.</p>}
          </section>
          <div className="vr-footnote">No se descargan archivos. Para visualizar las grabaciones, abre la sección de vídeo de MyGeotab cuando la captura figure como completada.</div>
        </aside>
      </div>
      {limitDialogOpen && <div className="vr-modal-backdrop"><section className="vr-limit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="vr-limit-title" aria-describedby="vr-limit-description"><span className="vr-dialog-icon" aria-hidden="true">!</span><h2 id="vr-limit-title">Intervalo superior a 20 minutos</h2><p id="vr-limit-description">Para evitar errores y un uso excesivo de datos, cada solicitud puede cubrir como máximo 20 minutos. Reduce el intervalo antes de continuar.</p><ButtonView type="primary" onClick={() => setLimitDialogOpen(false)}>Entendido</ButtonView></section></div>}
    </main>
  );
}
