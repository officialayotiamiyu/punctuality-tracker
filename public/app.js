// Punctuality Tracker — Supabase edition (GitHub Pages ready).
// - Relative asset paths so it runs under <user>.github.io/<repo>/
// - QR scanning: BarcodeDetector with jsQR fallback (iOS Safari)
// - Punctuality engine: on-time / late / absent vs configurable shift start
// - Admin: date filter, daily summary, roster, CSV export
// - Optional signup allowlist (see config.js -> allowedEmails)

const appConfig = window.APP_CONFIG || {};
const supabase = window.supabase?.createClient
  ? window.supabase.createClient(appConfig.supabaseUrl, appConfig.supabaseAnonKey)
  : null;

if (!supabase) {
  throw new Error('Supabase client failed to load. Check config.js and the supabase-js script tag.');
}

const outboxDbName = 'attendance-outbox';
const outboxStore = 'scans';
let activeUserProfile = null;
let activeAction = null;
let scanLoopId = null;
let activeStream = null;
let scanCanvas = null;
let scanCanvasCtx = null;
let employeeChannel = null;
let adminChannel = null;
let qrChannel = null;

const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const registerName = document.getElementById('registerName');
const registerEmail = document.getElementById('registerEmail');
const registerPassword = document.getElementById('registerPassword');
const authStatus = document.getElementById('authStatus');
const employeeSection = document.getElementById('employeeSection');
const adminSection = document.getElementById('adminSection');
const userMeta = document.getElementById('userMeta');
const networkLabel = document.getElementById('networkLabel');
const networkDot = document.getElementById('networkDot');
const syncLabel = document.getElementById('syncLabel');
const syncDot = document.getElementById('syncDot');
const scanStatus = document.getElementById('scanStatus');
const stopScanBtn = document.getElementById('stopScanBtn');
const scannerVideo = document.getElementById('scannerVideo');
const employeeAttendanceBody = document.getElementById('employeeAttendanceBody');
const adminAttendanceBody = document.getElementById('adminAttendanceBody');
const qrCanvas = document.getElementById('qrCanvas');
const currentQrText = document.getElementById('currentQrText');
const qrMeta = document.getElementById('qrMeta');
const kpiOnTime = document.getElementById('kpiOnTime');
const kpiLate = document.getElementById('kpiLate');
const kpiAbsent = document.getElementById('kpiAbsent');
const kpiArrivals = document.getElementById('kpiArrivals');
const kpiDepartures = document.getElementById('kpiDepartures');
const kpiOffline = document.getElementById('kpiOffline');
const shiftInfo = document.getElementById('shiftInfo');
const dateFilter = document.getElementById('dateFilter');
const summaryDateLabel = document.getElementById('summaryDateLabel');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const dailySummaryBody = document.getElementById('dailySummaryBody');
const rosterBody = document.getElementById('rosterBody');
const toast = document.getElementById('toast');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function showToast(message, tone = 'info') {
  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.style.borderColor = tone === 'error' ? 'rgba(239,68,68,.65)' : tone === 'success' ? 'rgba(16,185,129,.65)' : 'rgba(51,65,85,.95)';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

function setAuthMode(mode) {
  if (mode === 'register') {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    document.getElementById('tabLoginBtn').classList.add('secondary');
    document.getElementById('tabRegisterBtn').classList.remove('secondary');
  } else {
    registerForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    document.getElementById('tabRegisterBtn').classList.add('secondary');
    document.getElementById('tabLoginBtn').classList.remove('secondary');
  }
}

function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeCsv(value) {
  const s = String(value ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

function shiftConfig() {
  const raw = appConfig.shiftStart || '09:00';
  const parts = raw.split(':').map((n) => parseInt(n, 10));
  const hour = isNaN(parts[0]) ? 9 : parts[0];
  const minute = isNaN(parts[1]) ? 0 : parts[1];
  const grace = Number(appConfig.graceMinutes) || 0;
  return {
    shiftStartMinutes: hour * 60 + minute,
    graceMinutes: grace,
    thresholdMinutes: hour * 60 + minute + grace,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (+${grace} min grace)`,
  };
}

// --- Offline outbox (IndexedDB) -------------------------------------------

async function openOutbox() {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(outboxDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(outboxStore)) {
        db.createObjectStore(outboxStore, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllPendingScans() {
  const db = await openOutbox();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(outboxStore, 'readonly');
    const store = tx.objectStore(outboxStore);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function savePendingScan(payload) {
  const db = await openOutbox();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(outboxStore, 'readwrite');
    tx.objectStore(outboxStore).put(payload);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function removePendingScan(id) {
  const db = await openOutbox();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(outboxStore, 'readwrite');
    tx.objectStore(outboxStore).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function updatePendingBadge() {
  const items = await getAllPendingScans();
  if (!items.length) {
    syncLabel.textContent = 'No pending sync';
    syncDot.classList.remove('offline', 'error');
    return;
  }
  syncLabel.textContent = `${items.length} pending sync`;
  syncDot.classList.add('offline');
}

function updateNetworkBadge() {
  const online = navigator.onLine;
  networkLabel.textContent = online ? 'Online' : 'Offline';
  networkDot.classList.toggle('offline', !online);
}

// --- Session / profile -------------------------------------------------------

function setAppState({ authenticated, profile }) {
  authView.classList.toggle('hidden', authenticated);
  appView.classList.toggle('hidden', !authenticated);
  if (authenticated && profile) {
    userMeta.textContent = `${profile.name || profile.email} · ${profile.role}`;
    employeeSection.classList.toggle('hidden', profile.role !== 'employee');
    adminSection.classList.toggle('hidden', profile.role !== 'admin');
  }
}

async function loadProfile(user) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (profile) return profile;

  if (!error) {
    const name = user.user_metadata?.full_name || user.email?.split('@')[0] || 'Employee';
    const { data: created, error: insertError } = await supabase
      .from('profiles')
      .upsert({
        id: user.id,
        name,
        email: user.email,
        role: 'employee',
        active: true,
      })
      .select()
      .single();
    if (!insertError && created) return created;
    console.error('Profile fallback insert failed', insertError);
    return null;
  }

  console.error('Could not load profile', error);
  return null;
}

function renderRows(target, rows, admin = false) {
  if (!rows.length) {
    target.innerHTML = `<tr><td colspan="${admin ? 6 : 4}" class="small">No records yet.</td></tr>`;
    return;
  }
  target.innerHTML = rows.map((item) => {
    const syncText = item.queued_offline ? 'Synced later' : 'Live';
    const statusClass = item.status === 'accepted' ? 'status-success' : 'status-danger';
    if (admin) {
      return `<tr>
        <td>${item.employee_name || item.employee_email || 'Employee'}</td>
        <td>${item.action}</td>
        <td>${formatDateTime(item.local_scanned_at)}</td>
        <td>${formatDateTime(item.server_received_at)}</td>
        <td>${item.queued_offline ? 'Yes' : 'No'}</td>
        <td class="${statusClass}">${item.status}</td>
      </tr>`;
    }
    return `<tr>
      <td>${item.action}</td>
      <td>${formatDateTime(item.local_scanned_at)}</td>
      <td>${syncText}</td>
      <td class="${statusClass}">${item.status}</td>
    </tr>`;
  }).join('');
}

// --- Realtime listeners ------------------------------------------------------

async function refreshEmployeeAttendance(userId) {
  const { data } = await supabase
    .from('attendance')
    .select('*')
    .eq('employee_id', userId)
    .order('local_scanned_at', { ascending: false })
    .limit(50);
  renderRows(employeeAttendanceBody, data || [], false);
}

function startEmployeeListeners(userId) {
  removeRealtimeChannels();
  employeeChannel = supabase
    .channel(`attendance-${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'attendance', filter: `employee_id=eq.${userId}` },
      () => refreshEmployeeAttendance(userId)
    )
    .subscribe();
  refreshEmployeeAttendance(userId);
}

// --- Admin dashboard (punctuality engine) -------------------------------------

async function refreshAdminAttendance() {
  const { data } = await supabase
    .from('attendance')
    .select('*')
    .order('server_received_at', { ascending: false })
    .limit(5000);
  renderRows(adminAttendanceBody, data || [], true);
  return data || [];
}

async function refreshRosterAndSummary(attendanceRows) {
  const { data: profiles } = await supabase
    .from('profiles')
    .select('*')
    .eq('role', 'employee');

  const employees = (profiles || []).filter((p) => p.active !== false);
  const cfg = shiftConfig();
  const filterValue = dateFilter.value || toLocalDateStr(new Date());
  const target = new Date(`${filterValue}T00:00:00`);

  const isSameDay = (iso) => {
    if (!iso) return false;
    const dt = new Date(iso);
    return dt.getFullYear() === target.getFullYear() && dt.getMonth() === target.getMonth() && dt.getDate() === target.getDate();
  };

  const dayRows = (attendanceRows || []).filter((row) => isSameDay(row.local_scanned_at));

  const summary = employees.map((emp) => {
    const rows = dayRows.filter((row) => row.employee_id === emp.id);
    const arrives = rows.filter((r) => r.action === 'arrive').sort((a, b) => new Date(a.local_scanned_at) - new Date(b.local_scanned_at));
    const leaves = rows.filter((r) => r.action === 'leave').sort((a, b) => new Date(a.local_scanned_at) - new Date(b.local_scanned_at));
    const arriveRow = arrives[0] || null;
    const leaveRow = leaves.length ? leaves[leaves.length - 1] : null;

    let status = 'Absent';
    let lateMin = 0;
    if (arriveRow) {
      const dt = new Date(arriveRow.local_scanned_at);
      const arrivalMin = dt.getHours() * 60 + dt.getMinutes();
      status = arrivalMin > cfg.thresholdMinutes ? 'Late' : 'On time';
      lateMin = Math.max(0, arrivalMin - cfg.thresholdMinutes);
    }

    let hours = '—';
    if (arriveRow && leaveRow) {
      hours = ((new Date(leaveRow.local_scanned_at) - new Date(arriveRow.local_scanned_at)) / 3600000).toFixed(1);
    }

    return {
      id: emp.id,
      name: emp.name || emp.email,
      email: emp.email,
      active: emp.active !== false,
      arrive: arriveRow ? arriveRow.local_scanned_at : null,
      leave: leaveRow ? leaveRow.local_scanned_at : null,
      status,
      lateMin,
      hours,
    };
  });

  summary.sort((a, b) => a.name.localeCompare(b.name));
  renderSummary(summary, filterValue);
  renderRoster(summary, filterValue);
  updateOverviewKpis(summary, dayRows);
}

function renderSummary(summary, filterValue) {
  summaryDateLabel.textContent = filterValue;
  if (!summary.length) {
    dailySummaryBody.innerHTML = `<tr><td colspan="6" class="small">No active employees yet. Create employee accounts first.</td></tr>`;
    return;
  }
  dailySummaryBody.innerHTML = summary.map((s) => {
    const cls = s.status === 'Late' ? 'status-danger' : s.status === 'Absent' ? 'status-warn' : 'status-success';
    return `<tr>
      <td>${s.name}</td>
      <td>${formatTime(s.arrive)}</td>
      <td>${formatTime(s.leave)}</td>
      <td class="${cls}">${s.status}</td>
      <td>${s.hours}</td>
      <td>${s.status === 'Late' ? s.lateMin + ' min' : '—'}</td>
    </tr>`;
  }).join('');
}

function renderRoster(summary, filterValue) {
  const isToday = filterValue === toLocalDateStr(new Date());
  if (!summary.length) {
    rosterBody.innerHTML = `<tr><td colspan="4" class="small">No active employees yet.</td></tr>`;
    return;
  }
  rosterBody.innerHTML = summary.map((s) => {
    const statusToday = s.status === 'Absent' ? (isToday ? 'No scan yet' : 'Absent') : s.status;
    return `<tr>
      <td>${s.name}</td>
      <td>${s.email}</td>
      <td>${statusToday}</td>
      <td>${s.active ? 'Yes' : 'No'}</td>
    </tr>`;
  }).join('');
}

function updateOverviewKpis(summary, dayRows) {
  kpiOnTime.textContent = summary.filter((s) => s.status === 'On time').length;
  kpiLate.textContent = summary.filter((s) => s.status === 'Late').length;
  kpiAbsent.textContent = summary.filter((s) => s.status === 'Absent').length;
  kpiArrivals.textContent = dayRows.filter((r) => r.action === 'arrive').length;
  kpiDepartures.textContent = dayRows.filter((r) => r.action === 'leave').length;
  kpiOffline.textContent = dayRows.filter((r) => r.queued_offline).length;
}

function exportDailyCsv() {
  const filterValue = dateFilter.value || toLocalDateStr(new Date());
  const rows = Array.from(dailySummaryBody.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())
  );
  if (!rows.length) {
    showToast('Nothing to export yet.', 'info');
    return;
  }
  const header = ['Employee', 'Arrive', 'Leave', 'Status', 'Hours worked', 'Late (min)'];
  const lines = [header, ...rows].map((r) => r.map(escapeCsv).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + lines], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `punctuality-${filterValue}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('CSV downloaded.', 'success');
}

async function refreshCurrentQr() {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'currentQr')
    .maybeSingle();
  const qr = data?.value || null;
  if (!qr?.code) {
    currentQrText.textContent = 'No QR generated yet.';
    qrMeta.textContent = 'Click regenerate QR to create the first static code.';
    const ctx = qrCanvas.getContext('2d');
    ctx.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
    return;
  }
  currentQrText.textContent = qr.code;
  qrMeta.textContent = `Generated ${formatDateTime(qr.generatedAt)}`;
  if (window.QRCode) {
    QRCode.toCanvas(qrCanvas, qr.code, { width: 280, margin: 1, color: { dark: '#111827', light: '#ffffff' } });
  }
}

async function refreshAdminDashboard() {
  const rows = await refreshAdminAttendance();
  await refreshRosterAndSummary(rows);
}

function startAdminListeners() {
  removeRealtimeChannels();
  adminChannel = supabase
    .channel('admin-attendance')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, refreshAdminDashboard)
    .subscribe();
  qrChannel = supabase
    .channel('admin-qr')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings', filter: 'key=eq.currentQr' }, refreshCurrentQr)
    .subscribe();
  refreshAdminDashboard();
  refreshCurrentQr();
}

function removeRealtimeChannels() {
  if (employeeChannel) supabase.removeChannel(employeeChannel);
  if (adminChannel) supabase.removeChannel(adminChannel);
  if (qrChannel) supabase.removeChannel(qrChannel);
  employeeChannel = null;
  adminChannel = null;
  qrChannel = null;
}

// --- Server-side RPC -----------------------------------------------------------

async function submitScan(payload) {
  const { data, error } = await supabase.rpc('submit_attendance', {
    p_scanned_code: payload.scannedCode,
    p_action: payload.action,
    p_local_scanned_at: payload.localScannedAt,
    p_device_info: payload.deviceInfo || {},
    p_queued_offline: Boolean(payload.queuedOffline),
  });
  if (error) throw new Error(error.message);
  return data;
}

async function syncPendingScans() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || !navigator.onLine) {
    await updatePendingBadge();
    return;
  }

  const pending = await getAllPendingScans();
  if (!pending.length) {
    await updatePendingBadge();
    return;
  }

  for (const item of pending) {
    try {
      await submitScan(item.payload);
      await removePendingScan(item.id);
    } catch (error) {
      console.error('Sync failed', error);
      syncDot.classList.add('error');
      syncLabel.textContent = 'Sync error, will retry';
      return;
    }
  }
  syncDot.classList.remove('error');
  await updatePendingBadge();
  showToast('Pending scans synced.', 'success');
}

async function handleAttendanceScan(scannedCode) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || !activeAction) return;

  const payload = {
    scannedCode,
    action: activeAction,
    localScannedAt: new Date().toISOString(),
    queuedOffline: !navigator.onLine,
    deviceInfo: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    },
  };

  if (!navigator.onLine) {
    await savePendingScan({
      id: crypto.randomUUID(),
      payload,
      createdAt: Date.now(),
    });
    await updatePendingBadge();
    showToast('Saved offline. It will sync automatically.', 'success');
    scanStatus.textContent = 'Saved offline. Waiting for connection.';
    stopScanner();
    return;
  }

  try {
    await submitScan(payload);
    showToast(`${activeAction} recorded successfully.`, 'success');
    scanStatus.textContent = `${activeAction} recorded successfully.`;
    stopScanner();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Scan failed.', 'error');
    scanStatus.textContent = error.message || 'Scan failed.';
  }
}

// --- QR scanner (BarcodeDetector + jsQR fallback for iOS) -----------------------

async function beginScanner(action) {
  activeAction = action;
  scanStatus.textContent = `Scanning for ${action}...`;
  stopScanBtn.classList.remove('hidden');

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    scannerVideo.srcObject = activeStream;
    await scannerVideo.play();

    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      tickBarcodeDetector(detector);
    } else if (window.jsQR) {
      if (!scanCanvas) {
        scanCanvas = document.createElement('canvas');
        scanCanvasCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
      }
      tickJsQR();
    } else {
      showToast('QR scanning is not available in this browser. Use Chrome on Android or Safari on iOS.', 'error');
      scanStatus.textContent = 'Scanner not available.';
      stopScanner();
    }
  } catch (error) {
    console.error(error);
    showToast('Could not start camera. Please allow camera permission.', 'error');
    scanStatus.textContent = 'Could not start camera.';
    stopScanner();
  }
}

function tickBarcodeDetector(detector) {
  const tick = async () => {
    if (!activeStream) return;
    try {
      const results = await detector.detect(scannerVideo);
      if (results?.length) {
        const rawValue = results[0].rawValue?.trim();
        if (rawValue) {
          await handleAttendanceScan(rawValue);
          return;
        }
      }
    } catch (error) {
      console.error('Detector error', error);
    }
    scanLoopId = requestAnimationFrame(tick);
  };
  tick();
}

function tickJsQR() {
  const process = () => {
    if (!activeStream || !scannerVideo.videoWidth) {
      scanLoopId = requestAnimationFrame(process);
      return;
    }
    try {
      const vw = scannerVideo.videoWidth;
      const vh = scannerVideo.videoHeight;
      const maxDim = 720;
      const scale = Math.min(1, maxDim / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      scanCanvas.width = w;
      scanCanvas.height = h;
      scanCanvasCtx.drawImage(scannerVideo, 0, 0, w, h);
      const imageData = scanCanvasCtx.getImageData(0, 0, w, h);
      const code = window.jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        const rawValue = String(code.data).trim();
        if (rawValue) {
          handleAttendanceScan(rawValue);
          return;
        }
      }
    } catch (error) {
      console.error('jsQR error', error);
    }
    scanLoopId = requestAnimationFrame(process);
  };
  scanLoopId = requestAnimationFrame(process);
}

function stopScanner() {
  if (scanLoopId) cancelAnimationFrame(scanLoopId);
  scanLoopId = null;
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
  }
  activeStream = null;
  scannerVideo.srcObject = null;
  stopScanBtn.classList.add('hidden');
  activeAction = null;
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (error) {
      console.error('SW registration failed', error);
    }
  }
}

// --- Event wiring ---------------------------------------------------------------

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authStatus.textContent = 'Signing in...';
  const { error } = await supabase.auth.signInWithPassword({
    email: loginEmail.value,
    password: loginPassword.value,
  });
  authStatus.textContent = error ? error.message : '';
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const email = registerEmail.value.trim().toLowerCase();
  const allowed = (appConfig.allowedEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) {
    authStatus.textContent = 'Signup is restricted to your team. Ask the admin to add your email.';
    return;
  }

  authStatus.textContent = 'Creating account...';
  const { data, error } = await supabase.auth.signUp({
    email,
    password: registerPassword.value,
    options: {emailRedirectTo: 'https://officialayotiamiyu.github.io/punctuality-tracker/ },
  });
  if (error) {
    authStatus.textContent = error.message;
    return;
  }
  if (!data.session) {
    authStatus.textContent = 'Account created. Check your email to confirm, then log in.';
    return;
  }
  authStatus.textContent = '';
});

document.getElementById('tabLoginBtn').addEventListener('click', () => setAuthMode('login'));
document.getElementById('tabRegisterBtn').addEventListener('click', () => setAuthMode('register'));
document.getElementById('signOutBtn').addEventListener('click', async () => {
  stopScanner();
  await supabase.auth.signOut();
});
document.getElementById('syncNowBtn').addEventListener('click', syncPendingScans);
stopScanBtn.addEventListener('click', stopScanner);
document.querySelectorAll('.scanTrigger').forEach((button) => {
  button.addEventListener('click', () => beginScanner(button.dataset.action));
});
document.getElementById('copyQrBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentQrText.textContent);
    showToast('QR code copied.', 'success');
  } catch {
    showToast('Could not copy the QR code.', 'error');
  }
});
document.getElementById('regenerateQrBtn').addEventListener('click', async () => {
  try {
    const { data, error } = await supabase.rpc('regenerate_qr');
    if (error) throw new Error(error.message);
    showToast(`New QR generated: ${data.code}`, 'success');
  } catch (error) {
    showToast(error.message || 'Could not regenerate QR.', 'error');
  }
});
dateFilter.addEventListener('change', async () => {
  const rows = await refreshAdminAttendance();
  await refreshRosterAndSummary(rows);
});
exportCsvBtn.addEventListener('click', exportDailyCsv);

window.addEventListener('online', async () => {
  updateNetworkBadge();
  await syncPendingScans();
});
window.addEventListener('offline', updateNetworkBadge);

supabase.auth.onAuthStateChange(async (event, session) => {
  if (!session || event === 'SIGNED_OUT') {
    removeRealtimeChannels();
    stopScanner();
    activeUserProfile = null;
    setAppState({ authenticated: false });
    return;
  }

  if (event === 'TOKEN_REFRESHED') return;

  try {
    const profile = await loadProfile(session.user);
    if (!profile) {
      showToast('Could not load profile. Check that the profile row / trigger exists.', 'error');
      return;
    }
    activeUserProfile = profile;
    setAppState({ authenticated: true, profile });
    updateNetworkBadge();
    await updatePendingBadge();
    if (profile.role === 'admin') {
      shiftInfo.textContent = shiftConfig().label;
      if (!dateFilter.value) dateFilter.value = toLocalDateStr(new Date());
      startAdminListeners();
    } else {
      startEmployeeListeners(session.user.id);
    }
    await syncPendingScans();
  } catch (error) {
    console.error(error);
    showToast('Could not load profile.', 'error');
  }
});

setAuthMode('login');
updateNetworkBadge();
registerServiceWorker();
