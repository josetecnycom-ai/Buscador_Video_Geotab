import { DateTime } from "luxon";

const sessionCredentials = new WeakMap();

export function call(api, method, params = {}) {
  if (!api || typeof api.call !== "function") {
    return Promise.reject(new Error("No está disponible la sesión API de MyGeotab."));
  }
  const cachedCredentials = sessionCredentials.get(api);
  const credentialsPromise = cachedCredentials || sessionInfo(api).then((session) => {
    const credentials = {
      database: String(session?.database || ""),
      userName: String(session?.userName || ""),
      sessionId: String(session?.sessionId || ""),
    };
    if (!credentials.database || !credentials.userName || !credentials.sessionId) {
      throw new Error("La sesión de MyGeotab no contiene todas las credenciales necesarias para la API.");
    }
    sessionCredentials.set(api, Promise.resolve(credentials));
    return credentials;
  });
  if (!cachedCredentials) sessionCredentials.set(api, credentialsPromise);
  return credentialsPromise.then((credentials) => new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => fail(new Error(`MyGeotab no respondió a ${method} en 60 segundos.`)), 60000);
    const finish = (callback, value) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        callback(value);
      }
    };
    const ok = (value) => finish(resolve, value);
    const fail = (error) => {
      const base = error?.message || String(error || "Error de MyGeotab.");
      const details = [];
      if (error?.code != null) details.push(`código ${error.code}`);
      if (error?.name) details.push(`tipo ${error.name}`);
      if (error?.data?.type) details.push(`excepción ${error.data.type}`);
      if (error?.data?.requestIndex != null) details.push(`índice ${error.data.requestIndex}`);
      if (Array.isArray(error?.errors)) {
        const messages = error.errors.map((item) => item?.message).filter(Boolean);
        if (messages.length) details.push(messages.join("; "));
      }
      finish(reject, new Error(details.length ? `${base} (${details.join(", ")})` : base));
    };
    try {
      // Mirror the local client: include the active session credentials in the
      // JSON-RPC params instead of relying on implicit SDK injection.
      const result = api.call(method, { ...params, credentials }, ok, fail);
      if (result && typeof result.then === "function") result.then(ok, fail);
    } catch (error) {
      fail(error);
    }
  }));
}

export async function sessionInfo(api) {
  if (api?.credentials?.database) return api.credentials;
  if (typeof api?.getSession === "function") {
    let session;
    try {
      session = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          callback(value);
        };
        const timeout = window.setTimeout(() => {
          finish(reject, new Error("MyGeotab no respondió al consultar la sesión. Recarga el Add-In e inténtalo de nuevo."));
        }, 20000);
        try {
          // In MyGeotab custom pages, getSession is callback-based.
          const result = api.getSession((value) => finish(resolve, value));
          if (result && typeof result.then === "function") {
            result.then((value) => finish(resolve, value), (error) => finish(reject, error));
          } else if (result && typeof result === "object") {
            finish(resolve, result);
          }
        } catch (error) {
          finish(reject, error);
        }
      });
    } catch (error) {
      if (api?.credentials?.database) return api.credentials;
      throw new Error(error?.message || "No se pudo consultar la sesión de MyGeotab.");
    }
    if (session?.database) return session;
    if (api?.credentials?.database) return api.credentials;
    throw new Error("MyGeotab no devolvió la base de datos de la sesión actual.");
  }
  if (api?.credentials?.database) return api.credentials;
  throw new Error("No pude identificar la base de datos de la sesión de MyGeotab.");
}

function text(value) {
  if (value && typeof value === "object") return String(value.id || value.name || "");
  return value == null ? "" : String(value);
}

export function normalizeCameras(cameraItems, devices) {
  const byId = new Map(devices.map((device) => [text(device.id), device]));
  const bySerial = new Map(devices.map((device) => [text(device.serialNumber).toUpperCase(), device]));
  return cameraItems.flatMap((camera) => {
    const serial = text(camera.cameraSerialNumber || camera.serialNumber || camera.serial);
    if (!serial) return [];
    const deviceId = text(camera.deviceId || camera.device);
    const deviceSerial = text(camera.deviceSerialNumber);
    const device = byId.get(deviceId) || bySerial.get(deviceSerial.toUpperCase()) || {};
    return [{
      cameraSerial: serial,
      cameraName: text(camera.name || camera.cameraName),
      assetName: text(camera.deviceName || camera.assetName || device.name) || "Activo sin nombre",
      licensePlate: text(camera.licensePlate || camera.vehicleLicensePlate || device.licensePlate),
      deviceSerial: deviceSerial || text(device.serialNumber),
      timeZone: text(camera.timeZoneId || device.timeZoneId),
      vendor: text(camera.vendor || camera.cameraVendor),
    }];
  });
}

export async function listCameras(api) {
  const [cameraItems, deviceItems] = await Promise.all([
    call(api, "Get", { typeName: "Camera", resultsLimit: 50000 }),
    call(api, "Get", { typeName: "Device", resultsLimit: 50000 }),
  ]);
  return normalizeCameras(cameraItems || [], deviceItems || []);
}

export function localInputToUtc(value, timeZone) {
  const parsed = DateTime.fromISO(value, { zone: timeZone, setZone: true });
  if (!parsed.isValid) {
    throw new Error("La fecha u hora no es válida para la zona horaria del activo.");
  }
  if (parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== value) {
    throw new Error("La hora no existe en la zona horaria del activo por el cambio de horario.");
  }
  if (typeof parsed.getPossibleOffsets === "function" && parsed.getPossibleOffsets().length > 1) {
    throw new Error("La hora elegida se repite por el cambio de horario. Elige una hora distinta.");
  }
  return parsed.toUTC().toISO({ suppressMilliseconds: true });
}

export function rangeDurationSeconds(startValue, endValue, timeZone) {
  const startUtc = DateTime.fromISO(localInputToUtc(startValue, timeZone), { setZone: true });
  const endUtc = DateTime.fromISO(localInputToUtc(endValue, timeZone), { setZone: true });
  const seconds = Math.floor(endUtc.diff(startUtc, "seconds").seconds);
  if (seconds <= 0) throw new Error("La hora final debe ser posterior a la inicial.");
  return seconds;
}

export function makeClips(startValue, endValue, timeZone, cameraSerial, database) {
  const startUtc = DateTime.fromISO(localInputToUtc(startValue, timeZone), { setZone: true });
  const endUtc = DateTime.fromISO(localInputToUtc(endValue, timeZone), { setZone: true });
  const totalSeconds = rangeDurationSeconds(startValue, endValue, timeZone);
  const clips = [];
  for (let offset = 0, index = 1; offset < totalSeconds; offset += 120, index += 1) {
    const duration = Math.min(120, totalSeconds - offset);
    const fromDate = startUtc.plus({ seconds: offset }).toISO({ suppressMilliseconds: true });
    clips.push({
      cameraSerial,
      cameraSerialNumber: cameraSerial,
      fromDate,
      durationSeconds: duration,
      requestEventName: `Captura ${database} ${cameraSerial} ${index}`.slice(0, 100),
      mediaType: "VIDEO",
      index,
      key: `${database}|${cameraSerial}|${fromDate}|${duration}`,
    });
  }
  return clips;
}

export function extractCapture(value) {
  const records = Array.isArray(value) ? value : [value];
  const record = records.find((item) => item && typeof item === "object" && (item.status || item.eventCaptureRequestId || item.id));
  if (!record) return { status: "ERROR", requestId: "", failureReason: "MyGeotab devolvió una respuesta sin ID de solicitud." };
  return {
    status: String(record.status || "QUEUED").toUpperCase(),
    requestId: String(record.eventCaptureRequestId || record.id || ""),
    failureReason: String(record.failureReason || ""),
  };
}

export function extractStatus(value) {
  const records = Array.isArray(value) ? value : [value];
  const record = records.find((item) => item && typeof item === "object" && item.status);
  if (!record) return null;
  return {
    status: String(record.status).toUpperCase(),
    failureReason: String(record.failureReason || ""),
  };
}

