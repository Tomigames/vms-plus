// VMS+ (formerly VC Dashboard) — prototype.
// Runs on my.firstinspires.org/VMS pages using the signed-in session.
// Loading and viewing only read from VMS. Five tabs can write: Staffing (assign, remove, move people),
// Roles (targets, open or close applications), Shift times, Notify (assignment emails) and Message (mass email). Each one previews
// its changes and does nothing until they are confirmed.
// Volunteer data stays in memory. Saved in this browser: shift-time settings, which events and tab
// were open, the notify subject and message, and staged assignments as ID numbers only (no names or emails).
(() => {
  'use strict';
  if (window.__vcDash) return;
  window.__vcDash = true;

  const SVC = '/VMS/Services/VolunteerService.asmx/';
  const ALL_DAY = '06:00am - 10:00pm';
  const CONCURRENCY = 4;

  // ---------- VMS access (read-only) ----------

  // VMS limits how fast one browser may call it: past the limit every request is redirected to a "maintenance"
  // page for about two minutes. When that happens, stop sending anything until it has passed.
  let blockedUntil = 0;
  const THROTTLED = 'VMS is limiting requests from this browser for a couple of minutes (it shows a "maintenance" page). '
    + 'Nothing is wrong with your data. Wait two minutes, then press Refresh.';
  // What "Copy diagnostics" reports: how many requests went to each kind of VMS page, and the recent failures.
  // Only page and service names are kept, never the query string, so no names, emails or ID numbers.
  const diag = { since: Date.now(), requests: {}, errors: [], ms: {} };
  const diagKey = (url, method) => {
    const u = String(url);
    const svcName = /VolunteerService\.asmx\/(\w+)/.exec(u);
    if (svcName) return svcName[1];
    const rep = /ReportID=(\d+)/i.exec(u);
    const page = (/\/VMS\/([^?#]+)/i.exec(u) || [, u])[1];
    return (method && method !== 'GET' ? method + ' ' : '') + page + (rep ? ' (report ' + rep[1] + ')' : '');
  };
  const diagError = (key, what) => {
    diag.errors.push({ t: Date.now(), key, what });
    if (diag.errors.length > 20) diag.errors.shift();
  };
  async function vfetch(url, options) {
    const key = diagKey(url, options && options.method);
    if (Date.now() < blockedUntil) throw new Error(THROTTLED);
    diag.requests[key] = (diag.requests[key] || 0) + 1;
    const t0 = Date.now();
    let res;
    try { res = await fetch(url, options); } catch (e) { diagError(key, 'network error: ' + (e.message || e)); throw e; }
    diag.ms[key] = Math.max(diag.ms[key] || 0, Date.now() - t0);
    if (/maintenance/i.test(res.url || '')) {
      blockedUntil = Date.now() + 120000;
      diagError(key, 'VMS maintenance page (rate limit)');
      throw new Error(THROTTLED);
    }
    if (!res.ok) diagError(key, 'HTTP ' + res.status);
    return res;
  }

  // VMS answers one request per session at a time, so on very large events (Championship) requests queue up behind
  // slow ones and its gateway gives up with a 502/503/504. Reads are safe to repeat: after such an error, all further
  // reads go one at a time and the failed one is tried again after a pause.
  let svcLimit = CONCURRENCY, svcActive = 0;
  const svcWaiting = [];
  async function svcSlot() {
    while (svcActive >= svcLimit) await new Promise((r) => svcWaiting.push(r));
    svcActive++;
  }
  function svcFree() {
    svcActive--;
    const next = svcWaiting.shift();
    if (next) next();
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRY_WAITS = [2000, 6000, 15000];

  async function svc(method, params) {
    const q = Object.entries(params)
      .map(([k, v]) => k + '=' + encodeURIComponent(typeof v === 'string' ? JSON.stringify(v) : v))
      .join('&');
    let res;
    for (let attempt = 0; ; attempt++) {
      await svcSlot();
      let failed = '';
      try {
        res = await vfetch(SVC + method + '?' + q, {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          credentials: 'same-origin',
        });
        if ([500, 502, 503, 504].includes(res.status)) failed = 'HTTP ' + res.status;
      } catch (e) {
        if (Date.now() < blockedUntil) throw e; // rate limited: retrying would only extend the block
        failed = e.message || 'network error';
      } finally { svcFree(); }
      if (!failed) break;
      if (attempt >= RETRY_WAITS.length) throw new Error(method + ' failed (' + failed + ')');
      svcLimit = 1;
      await pause(RETRY_WAITS[attempt]);
    }
    if (!res.ok) throw new Error(method + ' failed (HTTP ' + res.status + ')');
    let d;
    try {
      d = (await res.json()).d;
    } catch (e) {
      throw new Error('VMS session expired. Sign in again and reload.');
    }
    if (d === '') return [];
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { /* leave as text */ }
    }
    if (d == null || d.Status === 3) throw new Error('VMS session expired. Sign in again and reload.');
    return d;
  }

  async function svcPost(method, body) {
    const res = await vfetch(SVC + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = (await res.json()).d;
    if (d == null || d.Status === 3) throw new Error('VMS session expired. Sign in again and reload.');
    if (d.Status !== 0) throw new Error(d.Message || 'VMS refused the change');
    return d;
  }

  async function postJson(url, body) {
    const res = await vfetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let d;
    try { d = (await res.json()).d; } catch (e) { throw new Error('VMS session expired. Sign in again and reload.'); }
    if (d == null || d === false || d.Status === 3) throw new Error('VMS session expired. Sign in again and reload.');
    if (typeof d === 'object' && 'Status' in d && d.Status !== 0) throw new Error(d.Message || 'VMS refused the change');
    return d;
  }

  async function fetchDoc(url) {
    const res = await vfetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Could not load ' + url + ' (HTTP ' + res.status + ')');
    return { doc: new DOMParser().parseFromString(await res.text(), 'text/html'), url: res.url };
  }

  async function pool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    });
    await Promise.all(workers);
  }

  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const param = (href, name) => {
    const m = new RegExp('[?&]' + name + '=([^&#]*)', 'i').exec(href || '');
    return m ? decodeURIComponent(m[1]) : null;
  };

  async function listEvents() {
    const { doc, url } = await fetchDoc('/VMS/Default.aspx');
    const events = [];
    const seen = new Set();
    doc.querySelectorAll('a[href*="EventDetails.aspx"]').forEach((a) => {
      const id = Number(param(a.getAttribute('href'), 'ID'));
      if (!id || seen.has(id)) return;
      seen.add(id);
      const cells = [...(a.closest('tr') ? a.closest('tr').cells : [])].map(txt);
      const di = cells.findIndex((c) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c));
      events.push({
        id, vmsId: id,
        name: txt(a),
        date: di >= 0 ? cells[di] : '',
        days: di >= 0 ? Number(cells[di + 1]) || 1 : 1,
        program: di >= 0 ? cells[di + 2] || '' : '',
      });
    });
    // A coordinator with a single event is redirected straight to that event.
    if (!events.length && /EventDetails\.aspx/i.test(url)) {
      const id = Number(param(url, 'ID'));
      if (id) events.push({ id, vmsId: id, name: 'Event ' + id, date: '', days: 1, program: '' });
    }
    events.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0) || a.name.localeCompare(b.name));
    return events;
  }

  // Minimal CSV reader that copes with quoted fields containing commas and line breaks.
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Some facts are only in VMS reports, so those reports' CSV exports are read in the background.
  // Each reader keeps just the columns it needs and discards the rest.
  // VMS keeps one "current report" per signed-in session: opening a report runs it, and Export sends whichever
  // report ran last. Two reports in flight at once can therefore swap data, so they are run strictly one at a time,
  // and each is recognised by columns only it has (`mustHave`, and `mustNot` where another report is a superset).
  let reportQueue = Promise.resolve();
  function reportRows(evId, reportId, mustHave, mustNot) {
    const run = reportQueue.then(() => reportRowsNow(evId, reportId, mustHave, mustNot));
    reportQueue = run.catch(() => {});
    return run;
  }
  async function reportRowsNow(evId, reportId, mustHave, mustNot) {
    const url = '/VMS/Reports/ReportViewer.aspx?EventID=' + evId + '&ReportID=' + reportId + '&Auto=1';
    const { doc } = await fetchDoc(url);
    // A report with nothing in it shows an empty grid and has no CSV to export.
    const grid = doc.getElementById('MainContent_gv');
    if (grid && grid.rows.length <= 1) return [];
    const form = new URLSearchParams();
    doc.querySelectorAll('input[type=hidden]').forEach((i) => form.append(i.name, i.value));
    form.append('ctl00$MainContent$btnExport', 'Export');
    const res = await vfetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
    });
    if (!res.ok || !/csv/i.test(res.headers.get('content-type') || '')) throw new Error('report export failed');
    const rows = parseCsv(await res.text());
    const head = rows.findIndex((r) => mustHave.every((c) => r.includes(c)));
    if (head < 0 || (mustNot || []).some((c) => rows[head].includes(c))) throw new Error('report layout not recognised');
    const cols = rows[head];
    return rows.slice(head + 1).filter((r) => r.length > 1).map((r) => {
      const o = {};
      cols.forEach((c, i) => { o[c] = (r[i] || '').trim(); });
      return o;
    });
  }

  // Report 27, Volunteer Application Status: one row per person and role they applied for.
  // It says who applied for what, with which preference, and whether that application has been assigned.
  const personKey = (email, last, first) => [email, last, first].map((t) => (t || '').toLowerCase().trim()).join('|');
  async function loadApplications(evId) {
    return (await reportRows(evId, 27, ['Email', 'Date Applied', 'Role', 'Assignment Status'])).map((r) => ({
      email: r.Email.toLowerCase(),
      key: personKey(r.Email, r['Last Name'], r['Legal First Name']),
      role: cleanRole(r.Role || '').toLowerCase(),
      pref: r.Preference || '',
      open: r['Assignment Status'] === 'Applied',
      date: r['Date Applied'] || '',
    }));
  }
  // The earliest date each person applied.
  function appliedDatesFrom(apps) {
    const dates = new Map();
    apps.forEach((r) => {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(r.date);
      if (!m || !r.email) return;
      const when = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
      if (!dates.has(r.email) || when < dates.get(r.email)) dates.set(r.email, when);
    });
    return dates;
  }

  // VMS only gives applicants one role at a time, and most people apply for several roles, so reading every role
  // repeats the same people many times. The application report already says who applied for which role, so only
  // enough roles are read to have every applicant's record once (`coverRoles`); the rest are built from those
  // (`deriveApplicants`). Anything that does not line up exactly is handed back to be read from VMS directly.
  const openRows = (apps, role) => apps.filter((x) => x.open && x.role === role.name.toLowerCase());
  function coverRoles(roles, apps) {
    const rowsFor = new Map(roles.map((r) => [r, openRows(apps, r)]));
    const uncovered = new Set();
    rowsFor.forEach((rows) => rows.forEach((x) => uncovered.add(x.key)));
    const left = new Set(roles), picked = [];
    while (uncovered.size) {
      let best = null, gain = 0;
      left.forEach((r) => {
        const rows = rowsFor.get(r);
        const n = rows.filter((x) => uncovered.has(x.key)).length;
        // New people per person read: a short list of new people beats a long list of mostly known ones.
        if (n && n / rows.length > gain) { best = r; gain = n / rows.length; }
      });
      if (!best) break;
      left.delete(best);
      picked.push(best);
      rowsFor.get(best).forEach((x) => uncovered.delete(x.key));
    }
    return picked;
  }
  // Returns the roles that still have to be read directly.
  function deriveApplicants(roles, cover, apps) {
    const rest = roles.filter((r) => !cover.includes(r));
    const known = new Map(), unclear = new Set();
    let trusted = true;
    cover.forEach((role) => {
      const got = Array.isArray(role.applicants) ? role.applicants : [];
      const seen = new Set();
      got.forEach((v) => {
        const k = personKey(v.Email, v.LastName, v.FirstName);
        seen.add(k);
        if (known.has(k) && known.get(k).PeopleID !== v.PeopleID) unclear.add(k);
        else known.set(k, v);
      });
      // The report must describe every role that was read exactly, or it is not relied on for the others.
      const expect = new Set(openRows(apps, role).map((x) => x.key));
      if (expect.size !== seen.size || [...expect].some((k) => !seen.has(k))) trusted = false;
    });
    if (!trusted) return rest;
    return rest.filter((role) => {
      const rows = openRows(apps, role);
      if (!rows.every((x) => known.has(x.key) && !unclear.has(x.key))) return true;
      role.applicants = rows.map((x) => ({ ...known.get(x.key), Priority: x.pref, InRole: 0 }));
      return false;
    });
  }

  // Report 21, Training and Certifications: one row per assigned person, role and course.
  async function loadTraining(evId) {
    const out = new Map();
    (await reportRows(evId, 21, ['Email', 'Course Name'])).forEach((r) => {
      const email = r.Email.toLowerCase();
      if (!email || !r['Course Name']) return;
      const requiredCol = Object.keys(r).find((k) => /^required/i.test(k));
      if (!out.has(email)) out.set(email, []);
      out.get(email).push({
        role: r.Role || '', course: r['Course Name'], done: !!r['Completion Date'],
        required: /^(req|y|t|1)/i.test(requiredCol ? r[requiredCol] : ''),
        assigned: /^assigned/i.test(r['Assignment Status'] || ''),
      });
    });
    return out;
  }

  // Report 31, Previous Season Volunteers: what each person did at this event last season.
  async function loadLastSeason(evId) {
    const out = new Map();
    (await reportRows(evId, 31, ['Email', 'Roles Assigned'], ['Start Time', 'Emergency Contact'])).forEach((r) => {
      const email = r.Email.toLowerCase();
      if (email && r['Roles Assigned']) out.set(email, r['Roles Assigned']);
    });
    return out;
  }
  const fmtDay = (ts) => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate(); };

  // ---------- Multi-day events ----------
  // VMS schedules an event as a row of day positions starting at the schedule's first date. Each shift has a
  // StartingPosition and a PositionsSpanned. A multi-day event is shown here as one column per day, each column
  // behaving like a one-day event; `ev.id` is then "<VMS id>@<position>" and `ev.vmsId` is what VMS is called with.

  const DAY_MS = 86400000;
  const dateOf = (text) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text || '');
    return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
  };
  const dayGap = (a, b) => Math.round((b - a) / DAY_MS);
  const covers = (a, pos) => a.StartingPosition <= pos && pos < a.StartingPosition + (a.PositionsSpanned || 1);
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // VMS writes an applicant's available days as two-letter codes, e.g. "Fr Sa Su". Empty means not stated.
  const DAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
  const availableDays = (v) => {
    const t = typeof v.DaysAvailable === 'string' ? v.DaysAvailable.toLowerCase() : '';
    const days = (t.match(/[a-z]{2}/g) || []).filter((c) => DAY_CODES.includes(c));
    return days.length ? days : null;
  };
  // Testing aid: VMS event ids listed here are split across every day of their schedule, not just the event's own days.
  const splitAll = () => {
    try { return new Set((JSON.parse(localStorage.getItem('vcDash.splitDays')) || []).map(Number)); } catch (e) { return new Set(); }
  };

  // The first and last date of an event's schedule, read from a role's scheduling page.
  async function loadExtraEmail(x) {
    if (vmsExtraEmail) return;
    try {
      const { doc } = await fetchDoc('/VMS/Roles/RoleScheduling.aspx?ID=' + x.ev.vmsId + '&RoleID=' + x.role.id + (x.role.custom ? '&IsCustom=True' : ''));
      const extra = doc.getElementById('MainContent_hdnUserExtraEmail');
      if (extra && extra.value) vmsExtraEmail = extra.value.trim();
    } catch (e) { /* leave the box empty */ }
  }
  async function loadWindow(ev, role) {
    const { doc } = await fetchDoc('/VMS/Roles/RoleScheduling.aspx?ID=' + ev.id + '&RoleID=' + role.id + (role.custom ? '&IsCustom=True' : ''));
    const code = [...doc.querySelectorAll('script')].map((x) => x.textContent).join('\n');
    const extra = doc.getElementById('MainContent_hdnUserExtraEmail');
    if (extra && extra.value && !vmsExtraEmail) vmsExtraEmail = extra.value.trim();
    const a = /var startDate\s*=\s*moment\('([^']+)'\)/.exec(code), b = /var endDate\s*=\s*moment\('([^']+)'\)/.exec(code);
    const start = a && dateOf(a[1]), end = b && dateOf(b[1]);
    if (!start || !end || end < start) throw new Error('schedule dates not found');
    return { start, end };
  }

  // Turn one loaded event into its columns: itself for a one-day event, one per day otherwise.
  function splitDays(raw) {
    raw.src = raw;
    const ev = raw.ev, first = dateOf(ev.date), w = raw.sched;
    const all = splitAll().has(ev.id);
    if (!w || !first || (ev.days <= 1 && !all)) return [raw];
    const last = dayGap(w.start, w.end);
    const days = [];
    if (all) for (let pos = 0; pos <= last; pos++) days.push(pos);
    else for (let i = 0; i < ev.days; i++) { const pos = dayGap(w.start, first) + i; if (pos >= 0 && pos <= last) days.push(pos); }
    if (days.length < 2) return [raw];
    return days.map((pos) => {
      const date = new Date(w.start.getFullYear(), w.start.getMonth(), w.start.getDate() + pos);
      return {
        ev: { ...ev, id: ev.id + '@' + pos, vmsId: ev.id, days: 1, pos, multi: true, wd: WEEKDAYS[date.getDay()],
          date: (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear() },
        roles: raw.roles.map((r) => {
          const everyone = Array.isArray(r.assigned) ? r.assigned : [];
          const shiftsOf = (v) => v.Assignments || [];
          // On this day: anyone with a shift covering it, plus anyone in the role with no shift at all yet.
          const rows = everyone.filter((v) => !shiftsOf(v).length || shiftsOf(v).some((a) => covers(a, pos))).map((v) => {
            const mine = shiftsOf(v).filter((a) => covers(a, pos));
            return { ...v, Assignments: mine, allShifts: shiftsOf(v),
              otherDays: shiftsOf(v).length > mine.length || mine.some((a) => (a.PositionsSpanned || 1) > 1) };
          });
          // In the role on another day only: offered on this day the same way an applicant is.
          const elsewhere = everyone.filter((v) => shiftsOf(v).length && !shiftsOf(v).some((a) => covers(a, pos)))
            .map((v) => ({ ...v, ID: v.PeopleID, Priority: '', otherDay: true }));
          const told = rows.filter((v) => v.Assignments.some((a) => a.IsNotified)).length;
          // Applicants say which days they can come ("Fr Sa Su"); they are only offered on those days.
          const code = DAY_CODES[date.getDay()];
          const canCome = (v) => !availableDays(v) || availableDays(v).includes(code);
          const applying = (Array.isArray(r.applicants) ? r.applicants : []).filter(canCome);
          return { ...r, assigned: rows,
            // Someone in the role on another day is only offered here if this is one of their available days too.
            applicants: [...applying, ...elsewhere.filter(canCome)],
            counts: r.counts ? { ...r.counts, assigned: told, tentative: rows.length - told,
              applicants: r.readFailed ? r.counts.applicants : applying.length } : null };
        }),
        appliedDates: raw.appliedDates, training: raw.training, lastSeason: raw.lastSeason, src: raw,
      };
    });
  }

  // The date VMS expects ("MM/DD/YYYY") for a day position of a multi-day column's event.
  const posDate = (item, pos) => {
    const st = item.src.sched.start;
    const d = new Date(st.getFullYear(), st.getMonth(), st.getDate() + pos);
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
  };
  const saveShift = (vmsId, rowId, asgId, from, to, t) => svcPost('SaveAssignment', {
    eventID: vmsId, peopleRoleID: String(rowId), assignmentID: String(asgId), assignmentType: 'Tentative',
    startDate: from, endDate: to, startTime: t ? t.start : '', endTime: t ? t.end : '', duplicateVolunteerIDs: [],
  });
  // What VMS holds right now for one person in one role. Shift ids change with every save, so they are re-read before each change.
  async function liveRow(item, role, peopleId) {
    const rows = await svc('GetAssignedVolunteers', { eventID: item.ev.vmsId, roleID: role.id, isCustom: role.custom, viewType: 'Event', day: 0 });
    return rows.find((v) => v.PeopleID === peopleId) || null;
  }
  // Change one day of a shift. VMS joins all-day shifts on neighbouring days into one shift covering several days,
  // and saving that shift for a single day drops its other days, so those are put back as their own all-day shift.
  // `want` is the new time for the day, or null to take the day away.
  async function carveDay(item, rowId, a, pos, want) {
    const vmsId = item.ev.vmsId;
    const first = a.StartingPosition, last = first + (a.PositionsSpanned || 1) - 1;
    const D = (n) => posDate(item, n);
    if (want) {
      await saveShift(vmsId, rowId, a.ID, D(pos), D(pos), want);
      if (first < pos) await saveShift(vmsId, rowId, 0, D(first), D(pos - 1), null);
      if (last > pos) await saveShift(vmsId, rowId, 0, D(pos + 1), D(last), null);
    } else if (first === last) {
      await svcPost('ChangeScheduleType', { eventID: vmsId, peopleRoleID: String(rowId), assignmentID: String(a.ID), assignType: 'Remove' });
    } else if (first < pos) {
      await saveShift(vmsId, rowId, a.ID, D(first), D(pos - 1), null);
      if (last > pos) await saveShift(vmsId, rowId, 0, D(pos + 1), D(last), null);
    } else {
      await saveShift(vmsId, rowId, a.ID, D(pos + 1), D(last), null);
    }
  }

  const cleanRole = (name) => name.replace(/\s*\((hidden|inactive)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();

  // A first load reads everything. A refresh after a change passes the previous result as `prev`:
  // the reports are kept, and when `only` is given just those roles' people lists are read again.
  async function loadEvent(ev, tick, prev, only) {
    // Role counts come from the event page in one request.
    const counts = new Map();
    const { doc } = await fetchDoc('/VMS/Events/EventDetails.aspx?ID=' + ev.id);
    doc.querySelectorAll('a[href*="RoleScheduling.aspx"]').forEach((a) => {
      const tr = a.closest('tr');
      if (!tr) return;
      const nums = [...tr.cells].map(txt).filter((c) => /^-?\d+$/.test(c)).map(Number);
      if (nums.length >= 4) {
        counts.set(cleanRole(txt(a)).toLowerCase(), {
          target: nums[0], assigned: nums[1], tentative: nums[2], applicants: nums[3],
          hidden: /\(hidden\)/i.test(txt(a)),
          invite: !!tr.querySelector('a[href*="ExpressInvite"]'),
        });
      }
    });

    const rawRoles = await svc('GetRoles', { eventID: ev.id, roleType: 0 });
    const roles = rawRoles.map((r) => {
      const name = cleanRole(r.Name);
      return {
        id: r.ID, custom: !!r.IsCustom, key: !!r.IsKey, name,
        inactive: /\(inactive\)/i.test(r.Name),
        counts: counts.get(name.toLowerCase()) || null,
        // Roles VMS leaves off the event page (such as Volunteer Coordinator) carry no target or shifts.
        admin: !counts.has(name.toLowerCase()),
        assigned: [], applicants: [],
      };
    });
    let appliedDates = new Map(), training = new Map(), lastSeason = new Map();
    let sched = prev ? prev.sched : null;
    const before = prev ? new Map(prev.roles.map((r) => [r.id + ':' + r.custom, r])) : null;
    // A refresh of named roles reads just those. A first load, or a refresh of everything, takes applicants from the report.
    const whole = !(prev && only);
    let apps = null;
    if (prev) { appliedDates = prev.appliedDates; training = prev.training; lastSeason = prev.lastSeason; }

    // The application report comes first, because it decides which lists are worth reading.
    // It is a nice-to-have: without it every role is read directly.
    const quiet = new Set();
    // Hidden applicants. VMS lets a coordinator hide an applicant from one role or from every role of the event.
    // Someone hidden from the whole event is on every role's Hidden list, so reading two roles' lists finds them.
    // Someone hidden from one role is found because that role's applicant count is lower than the report says (`odd`).
    let eventHidden = prev && prev.eventHidden ? prev.eventHidden : [];
    const odd = new Set();
    let visible = null;
    const hiddenTab = (role) => svc('GetUnassignedVolunteers', { eventID: ev.id, roleID: role.id, tab: 'Hidden', isCustom: role.custom });
    roles.forEach((role) => {
      const old = before && before.get(role.id + ':' + role.custom);
      role.hidden = old && old.hidden ? old.hidden : [];
    });
    if (whole) {
      tick(0, 1);
      try { apps = await loadApplications(ev.id); appliedDates = appliedDatesFrom(apps); } catch (e) { apps = null; }
      tick(1, 0);
      const probes = roles.filter((r) => !r.admin).slice(0, 2);
      let lists = [];
      try { lists = await Promise.all(probes.map(hiddenTab)); } catch (e) { lists = []; }
      if (lists.length === 2 && lists.every(Array.isArray)) {
        const both = new Set(lists[1].map((v) => v.PeopleID));
        eventHidden = lists[0].filter((v) => both.has(v.PeopleID));
        const all = new Set(eventHidden.map((v) => v.PeopleID));
        probes.forEach((r, i) => { r.hidden = lists[i].filter((v) => !all.has(v.PeopleID)); });
      } else eventHidden = [];
      if (apps) {
        const gone = new Set(eventHidden.map((v) => personKey(v.Email, v.LastName, v.FirstName)));
        visible = apps.filter((x) => !gone.has(x.key));
        roles.forEach((role) => {
          if (!role.admin && role.counts && openRows(visible, role).length !== role.counts.applicants) odd.add(role);
        });
      }
      if (!prev && apps) {
        // A role is quiet when nothing suggests anyone is in it: no count on the event page and no application
        // marked as assigned. Quiet roles are still read, but afterwards, in the background.
        const busy = new Set(apps.filter((x) => !x.open).map((x) => x.role));
        roles.forEach((role) => {
          const c = role.counts;
          if (!role.admin && c && c.assigned + c.tentative === 0 && !busy.has(role.name.toLowerCase())) quiet.add(role);
        });
      }
    }

    const jobs = [];
    const needApplicants = [];
    roles.forEach((role) => {
      const old = before && before.get(role.id + ':' + role.custom);
      if (old && only && !only.has(role.name.toLowerCase())) {
        role.assigned = old.assigned; role.applicants = old.applicants; role.unchecked = old.unchecked; role.readFailed = old.readFailed;
        return;
      }
      if (quiet.has(role)) role.unchecked = true;
      else {
        jobs.push(async () => {
          role.assigned = await svc('GetAssignedVolunteers', {
            eventID: ev.id, roleID: role.id, isCustom: role.custom, viewType: 'Event', day: 0,
          });
        });
      }
      // A role the event page shows with no applicants needs no applicant request, unless someone may be hidden there.
      if (role.counts && role.counts.applicants === 0 && !odd.has(role)) return;
      needApplicants.push(role);
    });
    // If VMS still cannot give one role's applicants after retrying, the event loads without them and says so,
    // instead of failing as a whole.
    const direct = (role) => async () => {
      try {
        role.applicants = await svc('GetUnassignedVolunteers', { eventID: ev.id, roleID: role.id, tab: 'Applicants', isCustom: role.custom });
        role.readFailed = false;
      } catch (e) {
        if (Date.now() < blockedUntil || /session expired/i.test(e.message)) throw e;
        role.applicants = []; role.readFailed = true;
      }
    };
    // Roles that may have someone hidden are read directly, together with their Hidden list.
    const oddOnes = needApplicants.filter((r) => odd.has(r)), plain = needApplicants.filter((r) => !odd.has(r));
    const cover = whole && visible ? coverRoles(plain, visible) : plain;
    cover.forEach((role) => jobs.push(direct(role)));
    oddOnes.forEach((role) => {
      jobs.push(direct(role));
      jobs.push(async () => {
        const all = new Set(eventHidden.map((v) => v.PeopleID));
        try { role.hidden = (await hiddenTab(role)).filter((v) => !all.has(v.PeopleID)); } catch (e) { role.hidden = []; }
      });
    });
    if (!prev) {
      // Only events shown as several day columns need their schedule dates.
      const anchor = roles.find((r) => !r.admin) || roles[0];
      if (anchor && (ev.days > 1 || splitAll().has(ev.id))) {
        jobs.push(async () => { try { sched = await loadWindow(ev, anchor); } catch (e) { sched = null; } });
      }
    }
    tick(0, jobs.length);
    await pool(jobs, CONCURRENCY, async (job) => { await job(); tick(1, 0); });
    if (whole && visible) {
      const more = deriveApplicants(plain, cover, visible).map(direct);
      tick(0, more.length);
      await pool(more, CONCURRENCY, async (job) => { await job(); tick(1, 0); });
    }
    // The training and last-season reports are slow and only add flags, so they follow in the background.
    return { ev, roles, appliedDates, training, lastSeason, sched, eventHidden, apps: whole ? apps : (prev ? prev.apps : null),
      extrasPending: prev ? !!prev.extrasPending : true };
  }

  // ---------- Data model ----------

  // FIRST's training report lists courses for every role a person holds, at any event. Only the required, unfinished
  // courses for roles they hold at this event count here.
  const owedTraining = (e) => (e && e.training ? e.training : []).filter((t) => t.required && !t.done
    && e.assign.some((a) => a.role.toLowerCase() === cleanRole(t.role || '').toLowerCase()));
  function buildPeople(loaded) {
    const people = new Map();
    const get = (v) => {
      let p = people.get(v.PeopleID);
      if (!p) {
        p = {
          id: v.PeopleID,
          first: v.PreferredName || v.FirstName || '',
          last: v.LastName || '',
          email: v.Email || '',
          age: typeof v.Age === 'number' && v.Age > 0 ? v.Age : null,
          cleared: v.MeetsYPPRequirements !== false,
          clearance: v.YPPStatus || '',
          ev: {}, raw: v,
        };
        people.set(v.PeopleID, p);
      }
      return p;
    };
    const slot = (p, evId) => (p.ev[evId] = p.ev[evId] || { assign: [], applied: [], recs: [] });

    loaded.forEach(({ ev, roles }) => {
      roles.forEach((role) => {
        (Array.isArray(role.assigned) ? role.assigned : []).forEach((v) => {
          slot(get(v), ev.id).recs.push({ role: role.name, v });
          slot(get(v), ev.id).assign.push({
            role: role.name, roleId: role.id, custom: role.custom, admin: role.admin,
            shifts: (v.Assignments || []).map((a) => ({
              time: a.ScheduleDisplayTime || '',
              type: a.TypeName || '',
              shadow: a.Type === 3,
              notified: !!a.IsNotified,
            })),
          });
        });
        (Array.isArray(role.applicants) ? role.applicants : []).forEach((v) => {
          slot(get(v), ev.id).recs.push({ role: role.name, v });
          slot(get(v), ev.id).applied.push({ role: role.name, roleId: role.id, pref: v.Priority || '', times: v.InRole || 0, otherDay: !!v.otherDay });
        });
      });
    });

    people.forEach((p) => {
      loaded.forEach(({ ev, appliedDates, training, lastSeason }) => {
        const e = p.ev[ev.id];
        if (!e) return;
        const email = p.email.toLowerCase();
        if (appliedDates && appliedDates.get(email)) e.appliedOn = appliedDates.get(email);
        if (training && training.get(email)) e.training = training.get(email);
        if (lastSeason && lastSeason.get(email)) e.lastSeason = lastSeason.get(email);
      });
      const whens = Object.values(p.ev).map((e) => e.appliedOn).filter(Boolean);
      p.appliedOn = whens.length ? Math.min(...whens) : null;
    });

    people.forEach((p) => {
      const evs = Object.values(p.ev);
      const assigns = evs.flatMap((e) => e.assign);
      const shifts = assigns.flatMap((a) => a.shifts);
      p.assignedAnywhere = assigns.length > 0;
      p.flags = [];
      if (p.age != null && p.age < 18) p.flags.push('minor');
      if (!p.cleared) p.flags.push('clearance');
      if (shifts.some((s) => s.time === ALL_DAY)) p.flags.push('allday');
      if (shifts.some((s) => !s.notified)) p.flags.push('unnotified');
      if (assigns.some((a) => a.shifts.length === 0 && !a.admin)) p.flags.push('noshift');
      if (evs.some((e) => e.assign.filter((a) => !a.admin).length > 1)) p.flags.push('multirole');
      if (p.assignedAnywhere && evs.some((e) => e.assign.length === 0 && e.applied.length > 0)) p.flags.push('partial');
      const sets = evs.map((e) => e.assign.filter((a) => !a.admin).map((a) => a.role).sort().join('|')).filter(Boolean);
      if (new Set(sets).size > 1) p.flags.push('rolediff');
      if (evs.some((e) => owedTraining(e).length)) p.flags.push('training');
      if ((p.raw.SignedConsentReleaseStatus || '') === 'Unsigned') p.flags.push('consent');
      if (evs.some((e) => e.lastSeason)) p.flags.push('returning');
    });
    return [...people.values()].sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first));
  }

  const FLAG_LABEL = {
    minor: 'Minor',
    clearance: 'Needs clearance',
    allday: '6am–10pm',
    unnotified: 'Not notified',
    noshift: 'No shift set',
    multirole: 'Multiple roles',
    partial: 'Assigned some days only',
    rolediff: 'Role differs by day',
    training: 'Training incomplete',
    consent: 'Consent not signed',
    returning: 'Here last season',
  };
  const FLAG_TONE = { minor: 'info', clearance: 'bad', allday: 'warn', unnotified: 'warn', noshift: 'warn', multirole: 'info', partial: 'warn', rolediff: 'info', training: 'warn', consent: 'warn', returning: 'ok' };

  // ---------- UI ----------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .root { --bg:#f6f7f9; --panel:#fff; --ink:#1b2430; --muted:#5d6b7c; --line:#dfe3e9; --accent:#0066b3; --onaccent:#fff; color-scheme: light;
      --ok:#1f7a3d; --okbg:#e3f4e8; --warn:#8a5a00; --warnbg:#fff1d0; --bad:#a3271f; --badbg:#fde4e1; --info:#234e8a; --infobg:#e4edfb;
      position: fixed; inset: 0; z-index: 2147483000; background: var(--bg); color: var(--ink);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; }
    /* Dark colours apply when the theme is set to Dark, or when it is Auto and the computer is in dark mode. */
    .root.dark { --bg:#12161c; --panel:#1b222b; --ink:#e7ecf2; --muted:#9aa7b6; --line:#2c3643; --accent:#5aa9e6;
        --ok:#7fd69a; --okbg:#173524; --warn:#f0c264; --warnbg:#3b2f10; --bad:#ff9d94; --badbg:#44201c; --info:#9cc0f5; --infobg:#1c2c47; --onaccent:#0b1520; color-scheme: dark; }
    @media (prefers-color-scheme: dark) {
      .root:not(.light) { --bg:#12161c; --panel:#1b222b; --ink:#e7ecf2; --muted:#9aa7b6; --line:#2c3643; --accent:#5aa9e6;
        --ok:#7fd69a; --okbg:#173524; --warn:#f0c264; --warnbg:#3b2f10; --bad:#ff9d94; --badbg:#44201c; --info:#9cc0f5; --infobg:#1c2c47; --onaccent:#0b1520; color-scheme: dark; }
    }
    header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
    h1 { font-size: 16px; margin: 0; font-weight: 650; }
    .events { display: flex; flex-wrap: wrap; gap: 6px 14px; flex: 1 1 320px; }
    .events label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; white-space: nowrap; }
    .events:not(.picker) { flex-wrap: nowrap; min-width: 0; overflow: hidden; }
    .events.picker { position: relative; min-width: 0; }
    .events label[hidden], .evnone[hidden] { display: none; }
    .evsearch { width: 100%; box-sizing: border-box; }
    .evclear { margin: 0; white-space: nowrap; align-self: flex-start; }
    .evtools { display: flex; gap: 14px; }
    .events label.past { color: var(--muted, #888); }
    .evclear:disabled { color: var(--muted, #888); cursor: default; text-decoration: none; }
    .evbtn { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .evmenu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 20; display: flex; flex-direction: column; gap: 8px; min-width: 300px; max-height: 60vh; overflow: auto;
      background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; box-shadow: 0 6px 18px rgba(0,0,0,.18); }
    button, select, input[type=search], input[type=time], input[type=text], input[type=email], input[type=number], textarea { font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
    button { cursor: pointer; }
    button.primary { background: var(--accent); border-color: var(--accent); color: var(--onaccent); }
    button:disabled { opacity: .5; cursor: default; }
    .tabs { display: flex; gap: 4px; padding: 8px 16px 0; }
    .tabs button { border-radius: 6px 6px 0 0; border-bottom: none; }
    .tabs button.on { background: var(--accent); border-color: var(--accent); color: var(--onaccent); }
    main { flex: 1; overflow: auto; padding: 12px 16px 24px; }
    .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .bar .grow { flex: 1; }
    .muted { color: var(--muted); }
    .msg { padding: 10px 12px; border-radius: 6px; margin-bottom: 10px; background: var(--infobg); color: var(--info); }
    .msg.err { background: var(--badbg); color: var(--bad); }
    table { border-collapse: collapse; width: 100%; background: var(--panel); }
    th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
    th { position: sticky; top: -12px; background: var(--panel); font-weight: 600; z-index: 1; }
    th small { display: block; font-weight: 400; color: var(--muted); }
    /* People: the volunteer column stays in view while the event columns scroll sideways. */
    table.ptable th:first-child, table.ptable td:first-child { position: sticky; left: -16px; z-index: 2; background: var(--panel); min-width: 200px;
      box-shadow: 1px 0 0 var(--line); }
    table.ptable th:first-child { z-index: 3; }
    table.ptable td { min-width: 150px; }
    .tabs .diagbtn { margin-left: auto; align-self: center; border: none; background: none; }
    tr.group td { background: var(--bg); font-weight: 600; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .num { font-variant-numeric: tabular-nums; font-weight: 600; }
    .sub { color: var(--muted); font-size: 12px; }
    td.short { background: var(--warnbg); }
    td.full { background: var(--okbg); }
    .chip { display: inline-block; font-size: 12px; padding: 1px 7px; border-radius: 10px; margin: 1px 4px 1px 0; white-space: nowrap; }
    .chip.ok { background: var(--okbg); color: var(--ok); }
    .chip.warn { background: var(--warnbg); color: var(--warn); }
    .chip.bad { background: var(--badbg); color: var(--bad); }
    .chip.info { background: var(--infobg); color: var(--info); }
    .line { margin-bottom: 3px; }
    .board { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 14px; align-items: start; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
    .rolelist { padding: 0; overflow: hidden; }
    .rrow { display: flex; justify-content: space-between; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line); cursor: pointer; }
    .rrow:hover { background: var(--bg); }
    .rrow.on { background: var(--infobg); color: var(--info); font-weight: 600; }
    /* With many events the counts don't fit beside the name: they move to their own line and wrap between events. */
    .rrow { flex-wrap: wrap; row-gap: 2px; }
    .rrow .rname { flex: 1 1 130px; }
    .rrow .cnt { margin-left: auto; max-width: 100%; text-align: right; font-variant-numeric: tabular-nums; }
    .rrow .cnt > span { white-space: nowrap; }
    .hscroll { overflow-x: auto; }
    /* Day buttons wrap onto more lines instead of pushing the flags out of view. */
    .pacts { text-align: right; max-width: 380px; }
    .lo { color: var(--warn); } .hi { color: var(--ok); }
    .days { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .chip.plain { background: var(--bg); color: var(--ink); border: 1px solid var(--line); }
    .chip.new { background: var(--infobg); color: var(--info); border: 1px dashed var(--accent); }
    .chip button { border: none; background: none; padding: 0 0 0 4px; color: inherit; }
    .prow { display: grid; grid-template-columns: minmax(180px, 320px) minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); }
    @media (max-width: 900px) {
      .prow { grid-template-columns: minmax(0, 1fr) auto; }
      .prow .pflags { grid-column: 1; grid-row: 2; }
    }
    .pname { font-weight: 600; cursor: pointer; }
    .vcnote { display: inline-block; position: relative; width: 15px; height: 11px; margin: 0 2px 0 7px; border-radius: 3px; background: var(--accent); vertical-align: -1px; cursor: help; }
    .vcnote::after { content: ''; position: absolute; left: 3px; bottom: -4px; border-style: solid; border-width: 4px 4px 0 0; border-color: var(--accent) transparent transparent transparent; }
    input.otheremail { width: 280px; max-width: 100%; margin-left: 4px; }
    .lnk { border: none; background: none; color: var(--accent); padding: 0; margin: 2px 12px 0 0; font-size: 12px; cursor: pointer; }
    .lnk:hover { text-decoration: underline; }
    .lnk.copying { opacity: .6; cursor: progress; }
    .lnk.copied, .lnk.failed { border-radius: 4px; padding: 0 4px; text-decoration: none; animation: vcpop .45s ease-out; }
    .lnk.copied { color: var(--ok); background: var(--okbg); }
    .lnk.failed { color: var(--bad); background: var(--badbg); }
    @keyframes vcpop { 0% { transform: scale(.85); } 55% { transform: scale(1.12); } 100% { transform: scale(1); } }
    .chip.gone { text-decoration: line-through; color: var(--muted); border-style: dashed; }
    .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 2px 14px; margin: 6px 0 10px; }
    .linkbox { user-select: all; overflow-wrap: anywhere; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
    input.tgt { width: 62px; padding: 2px 6px; font-weight: 600; }
    input.tgt.dirty { border-color: var(--accent); background: var(--infobg); }
    input.tgt.bad { border-color: var(--bad); background: var(--badbg); }
    .chip.plain.click { cursor: pointer; }
    .panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(480px, 100%); z-index: 5; overflow: auto;
      background: var(--panel); border-left: 1px solid var(--line); box-shadow: -4px 0 16px rgba(0,0,0,.18); padding: 14px 16px 28px; }
    .panel h2 { margin: 0; font-size: 17px; }
    .panel h3 { margin: 18px 0 6px; font-size: 13px; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 3px; }
    .kv { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 3px 10px; margin: 0; }
    .kv dt { color: var(--muted); } .kv dd { margin: 0; overflow-wrap: anywhere; }
    .panel ul { margin: 0; padding-left: 18px; } .panel li { margin-bottom: 3px; }
    .prow button { padding: 3px 10px; margin-left: 4px; }
    .field { display: block; margin-bottom: 10px; }
    .field span { display: block; font-weight: 600; margin-bottom: 3px; }
    .field input[type=text], .field textarea { width: 100%; max-width: 720px; }
    h2 { font-size: 15px; margin: 18px 0 8px; }
    section:first-of-type h2 { margin-top: 4px; }
    details { margin: 0 0 8px; }
    summary { cursor: pointer; color: var(--accent); margin-bottom: 6px; }
    table.narrow { width: auto; min-width: 560px; }
    .toast { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 6px; }
    .sp { flex: 1; }
    .inf { color: var(--info); } .bd { color: var(--bad); }
    .rname { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .agechip { flex: none; width: 54px; overflow: hidden; box-sizing: border-box; margin: 0; padding: 0 4px; text-align: center; font-size: 11px; font-weight: 600; }
    .agechip.none { visibility: hidden; }
    .agemark { display: inline-block; font-size: 11px; font-weight: 600; border: 1px solid currentColor; border-radius: 8px; padding: 0 5px; margin-left: 4px; line-height: 15px; }
    .seg { padding: 3px 9px; font-size: 12px; border-radius: 0; }
    .seg:first-of-type { border-radius: 6px 0 0 6px; } .seg:last-of-type { border-radius: 0 6px 6px 0; border-left: none; }
    .seg.on { background: var(--accent); border-color: var(--accent); color: var(--onaccent); }
    table.rt { table-layout: fixed; }
    table.rt th, table.rt td { border: none; border-bottom: 1px solid var(--line); padding: 3px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; position: static; }
    table.rt th { vertical-align: bottom; }
    table.rt .d { width: 170px; }
    table.rt tr.openrow td { border-bottom: none; }
    table.rt tr.stagedrow td { background: var(--infobg); }
    .cell { display: flex; align-items: center; gap: 6px; }
    .xbtn { border: none; background: none; padding: 0 2px; color: var(--muted); }
    .slots { display: grid; gap: 4px 6px; align-items: center; }
    .slothead { font-weight: 600; padding: 0 8px; }
    .slothead small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
    .slotn { color: var(--muted); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
    .slot { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; min-height: 26px; display: flex; align-items: center; gap: 6px; padding: 2px 8px; white-space: nowrap; overflow: hidden; color: var(--ink); }
    .slot.new { background: var(--infobg); border: 1px dashed var(--accent); }
    .slot.open { background: none; border-style: dashed; color: var(--muted); font-size: 12px; cursor: pointer; width: 100%; text-align: left; }
    .slot.pick { border: 2px solid var(--accent); background: var(--infobg); color: var(--info); font-size: 12px; font-weight: 600; }
    .daymark { display: inline-flex; align-items: center; gap: 4px; }
    .filltag { display: inline-flex; align-items: center; gap: 6px; background: var(--infobg); color: var(--info); border: 1px solid var(--accent); border-radius: 10px; padding: 1px 4px 1px 9px; font-size: 12px; font-weight: 600; }
    .launch { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147482999; font: 600 14px system-ui, sans-serif;
      background: #0066b3; color: #fff; border-radius: 22px; padding: 10px 16px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  `;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v);
    });
    kids.flat(Infinity).forEach((kid) => {
      if (kid == null || kid === false) return;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
    return el;
  }
  const chip = (tone, label, title) => h('span', { class: 'chip ' + tone, title }, label);
  const noteText = (rows) => rows.map((r) => (r.postedDate ? r.postedDate + (r.postedBy ? ', ' + r.postedBy : '') + ': ' : '') + r.note).join('\n\n');
  const usableNotes = (rows) => (Array.isArray(rows) ? rows.filter((r) => r && typeof r.note === 'string' && r.note.trim()) : []);
  // A speech-bubble mark next to someone with coordinator comments; hovering shows them.
  const noteMark = (id) => {
    const rows = vcNotes.get(id);
    if (!rows || !rows.length) return null;
    return h('span', { class: 'vcnote', title: 'Coordinator comments:\n\n' + noteText(rows), role: 'img', 'aria-label': 'Has coordinator comments' });
  };

  // ---------- Recommended minimum ages, from FIRST's volunteer role pages ----------
  // Source: https://www.firstinspires.org/community/volunteers/roles/<slug>, read 11/12/2026.
  // Each entry: [FIRST role title, page slug, ages, where the role is used]. Ages are per program
  // (fll = FIRST LEGO League Challenge, explore = FLL Explore, ftc, frc) or `all`, as [minimum, preferred, note].
  // Championship-only details are left out except for Championship-only roles. FIRST lets the event's VC grant
  // exceptions after review and approval by the local Program Delivery Partner.
  const AGE_RULES = [
    ['Accommodation Coordinator', 'accommodation-coordinator', { all: [21] }],
    ['Assistant Field Manager', 'assistant-field-manager', { fll: [18] }, 'FLL only'],
    ['Assistant Scorekeeper', 'assistant-scorekeeper', { fll: [15] }, 'FLL Challenge only'],
    ['Attendee Registration Assistant', 'attendee-registration-assistant', { all: [18] }, 'Championship only'],
    ['Audio Visual Crew', 'audio-visual-crew', {}, 'FTC and FRC; no age given'],
    ['Ceremony Assistant', 'ceremony-assistant', { explore: [21] }, 'FLL Explore only'],
    ['Concessions', 'concessions', { fll: [18] }, 'FLL Challenge only'],
    ['Conference Coordinator', 'conference-coordinator', { all: [21] }, 'Championship only'],
    ['Conference Room Attendant', 'conference-room-attendant', { all: [15] }, 'Championship only'],
    ['Control System Advisor', 'control-system-advisor', { all: [18] }, 'FTC and FRC'],
    ['Cross-Program Championship Floater', 'cross-program-championship-floater', { all: [18] }, 'Championship only'],
    ['Dean\'s List Interviewer', 'deans-list-interviewers', { ftc: [18] }, 'FTC only'],
    ['Dean\'s List Reviewer', 'deans-list-reviewers', { ftc: [18] }, 'FTC only'],
    ['Emcee', 'emcee', { fll: [15], ftc: [18], frc: [18] }],
    ['Event Manager', 'event-manager', { frc: [18] }, 'FRC districts only'],
    ['Event Photographer', 'event-photographer', { fll: [18], ftc: [13, 18], frc: [13, 18] }],
    ['Field Assembly/Disassembly', 'field-assembly-disassembly', { all: [13, 18] }, 'FTC and FRC'],
    ['Field Manager', 'field-manager', { fll: [21] }, 'FLL only'],
    ['Field Resetter', 'field-resetter', { all: [13] }],
    ['Field Supervisor', 'field-supervisor', { all: [18] }, 'FTC and FRC'],
    ['FIRST Alumni and Individual Giving', 'first-alumni-and-individual-giving', { all: [18] }, 'Championship only'],
    ['FIRST Impact Award Room Monitor', 'first-impact-award-room-monitor', { frc: [15] }, 'FRC Championship only'],
    ['FIRST Technical Advisor', 'first-technical-advisor', { ftc: [18], frc: [18, 21] }, 'FTC and FRC'],
    ['FIRST Technical Advisor Assistant', 'first-technical-advisor-assistant', { all: [18] }, 'FTC and FRC'],
    ['Floater', 'floater', { fll: [13, 0, 'Depends on the role they cover (13 to 18+)'] }, 'FLL only'],
    ['Game Announcer', 'game-announcer', { ftc: [15], frc: [18] }, 'FTC and FRC'],
    ['Head Judge', 'head-judge', { fll: [18] }, 'FLL only'],
    ['Head Referee', 'head-referee', { fll: [18], ftc: [21, 23], frc: [21] }],
    ['Head Reviewer', 'head-reviewer', { explore: [21] }, 'FLL Explore only'],
    ['Information Booth Assistant', 'information-booth-assistant', { all: [18] }, 'Championship only'],
    ['Inspection Manager', 'inspection-manager', { all: [18] }, 'FTC and FRC'],
    ['Judge', 'judge', { fll: [15, 18], ftc: [18, 21], frc: [18, 21] }],
    ['Judge Advisor', 'judge-advisor', { fll: [21], ftc: [23], frc: [23] }],
    ['Judge Advisor Assistant', 'judge-advisor-assistant', { all: [18] }],
    ['Lead Queuer', 'lead-queuer', { fll: [15], ftc: [18], frc: [18] }],
    ['Lead Robot Inspector', 'lead-robot-inspector', { all: [21] }, 'FTC and FRC'],
    ['Load-In/Out Crew', 'load-in-out-crew', { all: [13] }],
    ['Machine Shop Staff', 'machine-shop-staff', { frc: [18] }, 'FRC only'],
    ['Official Scorer', 'official-scorer', { all: [15, 18] }, 'FTC and FRC'],
    ['Pit Administration Supervisor', 'pit-administration-supervisor', { all: [21] }, 'FTC and FRC'],
    ['Pit Administrator', 'pit-administrator', { fll: [18], ftc: [18], frc: [18] }],
    ['Pit Announcer', 'pit-announcer', { frc: [18] }, 'FRC Championship only'],
    ['Pit Runner', 'pit-runner', { all: [13] }],
    ['Planning Committee', 'planning-committee', { frc: [18] }, 'FRC regionals only'],
    ['Practice Field Disassembly', 'practice-field-dissasembly', { frc: [15] }, 'FRC Championship only'],
    ['Practice Field Attendant', 'practice-field-attendant', { ftc: [15] }, 'FTC'],
    ['Practice Table Coordinator', 'practice-table-coordinator', { all: [18] }, 'FLL Championship only'],
    ['Practice Table Manager', 'practice-table-manager', { all: [18] }, 'FLL Championship only'],
    ['Queuer', 'queuer', { explore: [15, 0, '13 with a parent'], fll: [15, 0, '13 with a parent'], ftc: [13, 15], frc: [13, 15] }],
    ['Quiet Room Attendant', 'quiet-room-attendant', { frc: [18] }, 'FRC only'],
    ['Quiet Room Lead Volunteer', 'quiet-room-lead-volunteer', { all: [18] }, 'Championship only'],
    ['Referee', 'referee', { fll: [15, 18, '18 for direct access to the Event Hub; 15 for offline scoring'], ftc: [18], frc: [18] }],
    ['Reviewer', 'reviewer', { explore: [15, 18] }, 'FLL Explore'],
    ['Robot Inspector', 'robot-inspector', { all: [18] }, 'FTC and FRC'],
    ['Safety Attendant', 'safety-attendant', { all: [13] }],
    ['Safety Manager', 'safety-manager', { frc: [18] }, 'FRC only'],
    ['Score Runner', 'score-runner', { fll: [15] }, 'FLL Challenge only'],
    ['Scorekeeper', 'scorekeeper', { fll: [15], ftc: [18], frc: [18] }],
    ['Scoring Event Admin', 'scoring-event-admin', { ftc: [18] }, 'FTC only'],
    ['Scoring League Admin', 'scoring-league-admin', { ftc: [18] }, 'FTC only'],
    ['Special Operations', 'special-operations', { frc: [15] }, 'FRC Championship only'],
    ['Student Ambassador', 'student-ambassador', { all: [13] }, 'FRC, and FTC at Championship'],
    ['Student Ambassador Coordinator', 'student-ambassador-coordinator', { frc: [18] }, 'FRC only'],
    ['Team Activities', 'team-activities', { explore: [15] }, 'FLL Explore and Championship only'],
    ['Team Registration', 'team-registration', { fll: [18] }, 'FLL Challenge only'],
    ['Technical Director', 'technical-director', { ftc: [18, 21] }, 'FTC only'],
    ['Technical Staff', 'technical-staff', { fll: [18] }, 'FLL only'],
    ['Test/Practice Attendant', 'test-practice-attendant', { frc: [13, 0, 'Leads 18+'] }, 'FRC only'],
    ['Time Keeper', 'time-keeper', { fll: [15] }, 'FLL Challenge only'],
    ['Tournament/Event Director', 'tournament-event-director', { all: [21] }],
    ['Volunteer Central', 'volunteer-central', { all: [18] }, 'Championship only'],
    ['Volunteer Check-In', 'volunteer-check-in', { all: [18] }],
    ['Volunteer Coordinator', 'volunteer-coordinator', { all: [21] }],
    ['Volunteer Room Assistant', 'volunteer-room-assistant', { frc: [18] }, 'FRC only'],
    ['Webcast Operator', 'webcast-operator', { frc: [18] }, 'FRC regionals and Championship only'],
  ];
  // VMS role names that differ from FIRST's page titles.
  const AGE_ALIASES = {
    'judging queuer': 'queuer', 'robot game queuer': 'queuer', 'lead robot game queuer': 'lead-queuer', 'lead judging queuer': 'lead-queuer',
    'lead judge': 'head-judge', 'tournament director': 'tournament-event-director', 'event director': 'tournament-event-director',
    'volunteer room assistant and check-in': 'volunteer-check-in', 'load-in/load-out crew': 'load-in-out-crew',
    'a/v crew': 'audio-visual-crew', 'av crew': 'audio-visual-crew', 'team check-in/registration': 'team-registration',
    'deans list interviewer': 'deans-list-interviewers', 'deans list reviewer': 'deans-list-reviewers',
  };
  const ageKey = (name) => (name || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const AGE_BY_NAME = new Map();
  AGE_RULES.forEach((r) => { AGE_BY_NAME.set(ageKey(r[0]), r); AGE_BY_NAME.set(ageKey(r[1].replace(/-/g, ' ')), r); });
  Object.entries(AGE_ALIASES).forEach(([vms, slug]) => AGE_BY_NAME.set(ageKey(vms), AGE_RULES.find((r) => r[1] === slug)));
  const PROGRAM_NAME = { fll: 'FIRST LEGO League Challenge', explore: 'FIRST LEGO League Explore', ftc: 'FIRST Tech Challenge', frc: 'FIRST Robotics Competition' };
  const programOf = (ev) => {
    const t = (ev && ev.program) || '';
    return /explore/i.test(t) ? 'explore' : /lego/i.test(t) ? 'fll' : /tech challenge/i.test(t) ? 'ftc' : /robotics competition/i.test(t) ? 'frc' : '';
  };
  // The age rule for a role at one event, or null when FIRST gives none.
  // `other` means FIRST only lists the role for a different program; its age is still shown as a guide.
  function ageRule(roleName, ev) {
    const r = AGE_BY_NAME.get(ageKey(roleName));
    if (!r) return null;
    const [title, slug, ages, where] = r;
    const prog = programOf(ev);
    let a = (prog && ages[prog]) || ages.all, other = false;
    if (!a) {
      const vals = Object.values(ages);
      const mins = [...new Set(vals.map((v) => v[0]))];
      if (mins.length !== 1) return null;
      a = vals.sort((x, y) => (y[1] || 0) - (x[1] || 0))[0];
      other = true;
    }
    return { title, url: 'https://www.firstinspires.org/community/volunteers/roles/' + slug, min: a[0], pref: a[1] || 0, note: a[2] || '', where: where || '', other, prog };
  }
  const ageText = (rule) => rule.min + '+' + (rule.pref > rule.min ? ' (' + rule.pref + '+ preferred)' : '') + (rule.note ? '. ' + rule.note : '');
  // How a person's age compares with a role's rule: 'under' the minimum, under the 'pref'erred age, or null.
  const ageIssue = (person, rule) => (!person || person.age == null || !rule ? null
    : person.age < rule.min ? 'under' : rule.pref && person.age < rule.pref ? 'pref' : null);
  // The strictest rule among the loaded events that have this role.
  const strictestRule = (roleName, items) => items.map((l) => ageRule(roleName, l.ev)).filter(Boolean)
    .sort((a, b) => b.min - a.min || b.pref - a.pref)[0] || null;

  // ---------- Shift-time settings (per event, with optional per-role times) ----------

  const TIMES_KEY = 'vcDash.shiftTimes.v1';
  const MIN_TIME = '06:00', MAX_TIME = '22:00';
  function readTimes() {
    try { return JSON.parse(localStorage.getItem(TIMES_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveTimes() {
    // Drop blank per-role rows so only times that were actually set are kept.
    const keep = (k, v) => (v && typeof v === 'object' && 'start' in v && !('roles' in v) && !v.start && !v.end ? undefined : v);
    try { localStorage.setItem(TIMES_KEY, JSON.stringify(state.times, keep)); } catch (e) { /* settings just won't persist */ }
  }
  const cfgFor = (evId) => (state.times[evId] = state.times[evId] || { start: '', end: '', roles: {} });
  const validTime = (t) => !!t && !!t.start && !!t.end && t.start < t.end && t.start >= MIN_TIME && t.end <= MAX_TIME;
  function effectiveTime(evId, roleName) {
    const cfg = cfgFor(evId);
    const own = cfg.roles[roleName.toLowerCase()];
    if (validTime(own)) return own;
    return validTime(cfg) ? { start: cfg.start, end: cfg.end } : null;
  }
  // "13:00" -> "01:00pm", the way VMS prints shift times.
  function vmsClock(t) {
    const [hh, mm] = t.split(':').map(Number);
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return String(h12).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + (hh < 12 ? 'am' : 'pm');
  }
  const vmsRange = (t) => vmsClock(t.start) + ' - ' + vmsClock(t.end);
  function vmsDate(d) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d || '');
    return m ? m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') + '/' + m[3] : null;
  }

  // Every shift whose time differs from the configured time for its event and role.
  function plannedChanges() {
    const out = [];
    state.loaded.forEach(({ ev, roles }) => {
      if (ev.days > 1 || !vmsDate(ev.date)) return;
      roles.forEach((role) => {
        if (role.admin || role.inactive) return;
        const want = effectiveTime(ev.id, role.name);
        if (!want) return;
        (Array.isArray(role.assigned) ? role.assigned : []).forEach((v) => {
          const all = v.Assignments || [];
          // Shadow shifts and anyone with several shifts in one role are edge cases left to VMS.
          if (all.length > 1 || all.some((a) => a.Type === 3)) return;
          const a = all[0];
          const from = a ? a.ScheduleDisplayTime || '' : '';
          if (from === vmsRange(want)) return;
          out.push({
            key: ev.id + ':' + v.ID + ':' + (a ? a.ID : 0),
            ev, role: role.name, rowId: v.ID, asgId: a ? a.ID : '0', peopleId: v.PeopleID,
            name: (v.PreferredName || v.FirstName || '') + ' ' + (v.LastName || ''),
            from, want, notified: a ? !!a.IsNotified : false,
          });
        });
      });
    });
    return out;
  }

  // ---------- Saved progress (survives reloads) ----------

  const DRAFTS_KEY = 'vcDash.drafts.v1';
  const saved = (() => {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {}; } catch (e) { /* start clean */ }
    return {
      staged: Array.isArray(d.staged) ? d.staged.filter((x) => x && x.evId && x.role && x.peopleId) : [],
      notify: d.notify || {},
      selected: Array.isArray(d.selected) ? d.selected : null,
      tab: d.tab, staffRole: d.staffRole, showAssigned: !!d.showAssigned, hideZero: !!d.hideZero, hideLast: !!d.hideLast, staffMode: d.staffMode === 'slot' ? 'slot' : 'person', theme: ['light', 'dark'].includes(d.theme) ? d.theme : 'auto',
      showNeeded: !!d.showNeeded, showOther: !!d.showOther, showAges: d.showAges !== false, hidePast: d.hidePast !== false,
      reminded: d.reminded && typeof d.reminded === 'object' ? d.reminded : {},
    };
  })();
  function saveDrafts() {
    const data = {
      staged: [...state.staged, ...state.parked].map((x) => ({ evId: x.evId, role: x.role, peopleId: x.peopleId, ...(x.remove ? { remove: true } : {}) })),
      notify: { subject: state.notify.subject, message: state.notify.message, bcc: state.notify.bcc },
      selected: state.events.length ? [...state.selected] : saved.selected,
      tab: state.tab, staffRole: state.staffRole, showAssigned: state.showAssigned, hideZero: state.hideZero, hideLast: state.hideLast, staffMode: state.staffMode, theme: state.theme, showNeeded: state.showNeeded, showOther: state.showOther, showAges: state.showAges, hidePast: state.hidePast,
      reminded: state.reminded,
    };
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(data)); } catch (e) { /* progress just won't persist */ }
  }

  // After a load, re-check every saved draft against what VMS says now.
  // Drafts for events that are not loaded stay parked until those events are loaded.
  function restoreDrafts() {
    const all = [...state.staged, ...state.parked];
    state.staged = []; state.parked = [];
    let dropped = 0;
    all.forEach((d) => {
      const item = state.loaded.find((l) => l.ev.id === d.evId);
      if (!item) { state.parked.push(d); return; }
      const role = roleIn(item, d.role);
      const person = state.people.find((x) => x.id === d.peopleId);
      const name = person ? person.first + ' ' + person.last : '';
      if (d.remove) {
        // A staged removal only still makes sense if the person is still in that role.
        const row = role && role.assigned.find((v) => v.PeopleID === d.peopleId);
        if (row && person) {
          state.staged.push({ remove: true, evId: d.evId, role: role.name, peopleId: d.peopleId, name,
            notified: (row.Assignments || []).some((a) => a.IsNotified) });
        } else dropped += 1;
        return;
      }
      const ok = role && person && person.ev[d.evId] && person.cleared
        && !realAssign(person, d.evId).some((a) => a.role === role.name)
        && !state.staged.some((x) => !x.remove && x.evId === d.evId && x.peopleId === d.peopleId);
      if (ok) state.staged.push({ evId: d.evId, role: role.name, peopleId: d.peopleId, name });
      else dropped += 1;
    });
    const notes = [];
    if (state.fresh && state.staged.length) notes.push('Restored ' + plural(state.staged.length, 'staged change') + ' from your last session.');
    if (dropped) notes.push(plural(dropped, 'saved draft') + ' no longer fit what is in VMS and ' + (dropped === 1 ? 'was' : 'were') + ' removed.');
    state.restoreNote = notes.join(' ');
    state.fresh = false;
  }

  const state = {
    parked: saved.staged, restoreNote: '', fresh: true,
    times: readTimes(), picks: new Map(), confirming: false, applying: false, applyResult: null,
    events: [], selected: new Set(), loaded: [], people: [],
    tab: ['staff', 'roles', 'people', 'times', 'notify', 'message'].includes(saved.tab) ? saved.tab : 'staff', busy: false,
    staffRole: saved.staffRole || '', staged: [], showAssigned: saved.showAssigned, poolSearch: '', staffConfirm: false, staffApplying: false, staffResult: null,
    detail: null,
    toggleKey: '', toggling: false, inviteLink: null, hideAsk: null, hiding: false,
    newRole: { open: false, name: '', desc: '', target: '1', allow: true, evs: null, confirming: false, saving: false, error: '', result: null },
    msg: { evs: null, aud: '0', allRoles: true, roles: new Set(), subject: '', message: '', bcc: false, confirming: false, sending: false, error: '', result: null },
    targetEdit: false, targetEdits: new Map(), targetConfirm: false, targetApplying: false, targetResult: null, copyFrom: 0, copyTo: 1,
    notify: { subject: saved.notify.subject || '', message: saved.notify.message || '', bcc: !!saved.notify.bcc, other: false, otherEmail: '', picks: new Map(), confirming: false, sending: false, error: '', result: null }, progress: '', error: '',
    note: '', drafting: false, theme: saved.theme, staffMode: saved.staffMode, showNeeded: saved.showNeeded, showOther: saved.showOther, fill: null, onlyShort: false, hideZero: saved.hideZero, hideLast: saved.hideLast, showAges: saved.showAges, hidePast: saved.hidePast, reminded: saved.reminded, sort: 'name', search: '', status: 'all', role: '', toast: '',
  };

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  let timesDirty = false; // Shift times tab: a time was typed and the tab hasn't been redrawn yet.
  // Coordinator comments on each person's VMS profile (peopleID -> list), read in the background after a load. Memory only.
  const vcNotes = new Map();
  // The extra email address VMS fills into its own Notify form, read from a role page. Memory only.
  let vmsExtraEmail = '';
  shadow.append(h('style', {}, CSS));
  const launch = h('button', { class: 'launch', onclick: open }, 'VMS+');
  const root = h('div', { class: 'root', hidden: true });
  shadow.append(launch, root);
  document.documentElement.append(host);

  async function open() {
    root.hidden = false;
    launch.hidden = true;
    if (!state.events.length) {
      state.busy = true; state.progress = 'Finding your events…'; render();
      try {
        state.events = await listEvents();
        const ids = state.events.map((e) => e.id);
        const remembered = (saved.selected || []).filter((id) => ids.includes(id));
        // Start with nothing ticked, unless events were picked on an earlier visit.
        state.selected = new Set(remembered);
      } catch (e) { state.error = e.message; }
      state.busy = false; state.progress = '';
    }
    render();
  }
  function close() { root.hidden = true; launch.hidden = false; }

  // An event is past once its last day is over. Past events are hidden from the picker unless asked for, and a
  // hidden event is not loaded even if it is still ticked from an earlier visit.
  function isPast(ev) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(ev.date || '');
    if (!m) return false;
    const lastDay = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]) + Math.max(1, ev.days || 1) - 1);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return lastDay < today;
  }
  const shownEvents = () => (state.hidePast ? state.events.filter((ev) => !isPast(ev)) : state.events);

  async function load() {
    const evs = shownEvents().filter((e) => state.selected.has(e.id));
    if (!evs.length) return;
    state.busy = true; state.error = ''; state.loaded = []; state.people = [];
    state.parked = [...state.staged, ...state.parked]; state.staged = [];
    state.staffConfirm = false; state.staffResult = null; state.notify.result = null;
    let done = 0, total = 0;
    const tick = (d, t) => { done += d; total += t; state.progress = 'Loading ' + done + ' of ' + total + ' lists…'; renderHeader(); };
    try {
      const out = [];
      for (const ev of evs) out.push(...splitDays(await loadEvent(ev, tick)));
      state.loaded = out;
      state.people = buildPeople(out);
      restoreDrafts();
    } catch (e) { state.error = e.message; }
    state.busy = false; state.progress = '';
    render();
    background();
  }

  const evLabel = (ev) => (ev.date ? (ev.wd ? ev.wd + ' ' : '') + ev.date.replace(/\/\d{4}$/, '') + ' · ' : '') + ev.name;
  const roleUrl = (ev, r) => '/VMS/Roles/RoleScheduling.aspx?ID=' + ev.vmsId + '&RoleID=' + r.id + (r.custom ? '&IsCustom=True' : '');

  let headerEl, mainEl, tabsEl;
  const panelEl = h('aside', { class: 'panel', hidden: true });
  const staffLabel = () => 'Staffing' + (state.staged.length ? ' (' + state.staged.length + ' staged)' : '');
  function render() {
    // Redrawing must not move the page: keep the scroll position, except when changing tab.
    const top = mainEl && !state.toTop ? mainEl.scrollTop : 0;
    state.toTop = false;
    root.classList.toggle('dark', state.theme === 'dark');
    root.classList.toggle('light', state.theme === 'light');
    root.replaceChildren();
    headerEl = h('header');
    mainEl = h('main');
    const tabs = h('div', { class: 'tabs' },
      [['staff', staffLabel()], ['roles', 'Roles'], ['people', 'People (' + state.people.length + ')'],
        ['times', 'Shift times'], ['notify', 'Notify (' + pendingNotifications().length + ')'], ['message', 'Message']].map(([t, label]) => h('button', {
        class: state.tab === t ? 'on' : '',
        onclick: () => { state.tab = t; state.confirming = false; state.staffConfirm = false; state.notify.confirming = false; state.msg.confirming = false; state.toggleKey = ''; state.toTop = true; render(); },
      }, label)),
      h('button', { class: 'lnk diagbtn', title: 'Copy version, load details and recent errors to paste into a bug report. No names or emails.',
        onclick: (e) => copyDiagnostics(e.currentTarget) }, 'Copy diagnostics'));
    tabsEl = tabs;
    root.append(headerEl, tabs, mainEl, panelEl);
    renderPanel();
    if (state.toast) root.append(h('div', { class: 'toast' }, state.toast));
    renderHeader();
    renderMain();
    mainEl.scrollTop = top;
  }

  function renderHeader() {
    if (!headerEl) return;
    headerEl.replaceChildren(
      h('h1', {}, 'VMS+'),
      eventPicker(),
      h('span', { class: 'muted' }, state.progress || state.note),
      h('button', {
        title: 'Auto follows your computer\u2019s light or dark setting. Click to change.',
        onclick: () => { state.theme = { auto: 'dark', dark: 'light', light: 'auto' }[state.theme]; saveDrafts(); render(); },
      }, 'Theme: ' + { auto: 'Auto', dark: 'Dark', light: 'Light' }[state.theme]),
      h('button', { class: 'primary', disabled: state.busy, onclick: load }, state.loaded.length ? 'Refresh' : 'Load'),
      h('button', { onclick: close }, 'Close'),
    );
    // Events that do not fit on one row switch to a dropdown.
    if (!eventsCompact) setTimeout(() => {
      const el = headerEl && headerEl.querySelector('.events');
      if (!eventsCompact && el && el.isConnected && el.scrollWidth > el.clientWidth + 1) { eventsCompact = true; renderHeader(); }
    }, 0);
  }

  // Event checkboxes in a row, or in a dropdown when the row would overflow.
  let eventsCompact = false, eventsOpen = false, resizeTimer = 0, eventsQuery = '';
  // The typed phrase as a whole wins ("group 2"); when no event contains it, every word must appear somewhere.
  const evMatches = (ev, q) => {
    if (!q) return true;
    const text = (e) => evLabel(e).toLowerCase();
    if (shownEvents().some((e) => text(e).includes(q))) return text(ev).includes(q);
    return q.split(/\s+/).every((w) => text(ev).includes(w));
  };
  function eventPicker() {
    const q = eventsCompact ? eventsQuery.trim().toLowerCase() : '';
    const list = shownEvents();
    const boxes = list.map((ev) => h('label', { 'data-ev': ev.id, hidden: !evMatches(ev, q), class: isPast(ev) ? 'past' : '' },
      h('input', {
        type: 'checkbox', checked: state.selected.has(ev.id), disabled: state.busy,
        onchange: (e) => { e.target.checked ? state.selected.add(ev.id) : state.selected.delete(ev.id); saveDrafts(); if (eventsCompact) renderHeader(); else clearAll.disabled = state.busy || !state.selected.size; },
      }), evLabel(ev)));
    const clearAll = h('button', { class: 'lnk evclear', disabled: state.busy || !state.selected.size,
      onclick: () => { state.selected.clear(); saveDrafts(); renderHeader(); } }, 'Uncheck all');
    const pastCount = state.events.filter(isPast).length;
    const pastToggle = pastCount ? h('button', { class: 'lnk evclear', disabled: state.busy,
      title: state.hidePast ? 'Show events whose last day is over' : 'Hide events whose last day is over',
      onclick: () => { state.hidePast = !state.hidePast; saveDrafts(); eventsCompact = false; renderHeader(); },
    }, state.hidePast ? 'Show past (' + pastCount + ')' : 'Hide past') : null;
    if (!eventsCompact) return h('div', { class: 'events' }, boxes, clearAll, pastToggle);
    const chosen = list.filter((ev) => state.selected.has(ev.id));
    const label = !chosen.length ? 'Choose events'
      : chosen.length === 1 ? evLabel(chosen[0])
        : chosen.length + ' of ' + list.length + ' events: ' + chosen.map(evShort).join(' · ');
    return h('div', { class: 'events picker' },
      h('button', { class: 'evbtn', title: chosen.map(evLabel).join('\n'), onclick: () => {
        eventsOpen = !eventsOpen; eventsQuery = '';
        renderHeader();
        if (eventsOpen) { const s = headerEl.querySelector('.evsearch'); if (s) s.focus(); }
      } }, label + ' ▾'),
      eventsOpen ? h('div', { class: 'evmenu' },
        // Filtering hides rows in place, so typing never loses focus.
        h('input', { class: 'evsearch', type: 'search', placeholder: 'Search events', value: eventsQuery,
          oninput: (e) => {
            eventsQuery = e.target.value;
            const words = eventsQuery.trim().toLowerCase();
            let shown = 0;
            e.target.parentElement.querySelectorAll('label[data-ev]').forEach((l) => {
              const ev = state.events.find((x) => String(x.id) === l.dataset.ev);
              l.hidden = !evMatches(ev, words);
              if (!l.hidden) shown++;
            });
            e.target.parentElement.querySelector('.evnone').hidden = shown > 0;
          } }),
        h('div', { class: 'evtools' }, clearAll, pastToggle),
        boxes,
        h('div', { class: 'sub evnone', hidden: list.some((ev) => evMatches(ev, q)) }, list.length ? 'No events match.' : 'No upcoming events.')) : null);
  }
  // A click anywhere else closes the dropdown; a resize checks again whether the row fits.
  root.addEventListener('click', (e) => {
    if (eventsOpen && !e.composedPath().some((n) => n.classList && n.classList.contains('picker'))) { eventsOpen = false; eventsQuery = ''; renderHeader(); }
  });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { eventsCompact = false; eventsOpen = false; renderHeader(); }, 200);
  });

  function renderMain() {
    saveDrafts();
    timesDirty = false;
    if (tabsEl && tabsEl.firstChild) tabsEl.firstChild.textContent = staffLabel();
    const top = mainEl.scrollTop;
    // A box marked with data-fk keeps the keyboard focus across a redraw.
    const was = shadow.activeElement;
    const focusKey = was && mainEl.contains(was) && was.dataset ? was.dataset.fk : '';
    mainEl.replaceChildren();
    if (state.error) mainEl.append(h('div', { class: 'msg err' }, state.error, ' ',
      h('button', { class: 'lnk', onclick: (e) => copyDiagnostics(e.currentTarget) }, 'Copy diagnostics')));
    const failedReads = [];
    new Set(state.loaded.map((l) => l.src)).forEach((raw) => raw.roles.forEach((r) => {
      if (r.readFailed) failedReads.push(r.name + ' (' + evShort(raw.ev) + ')');
    }));
    if (failedReads.length) mainEl.append(h('div', { class: 'msg err' },
      'VMS could not send the applicant list for ' + failedReads.join(', ')
      + ', even after retrying. Those roles show no applicants here; assigned volunteers are complete. Press Refresh to try again.'));
    if (!state.loaded.length) {
      mainEl.append(h('div', { class: 'msg' }, state.busy ? 'Working…'
        : 'Tick the events to view together, then press Load. Loading only reads from VMS. Nothing changes in VMS until you confirm it.'));
      return;
    }
    const views = { staff: staffView, roles: rolesView, people: peopleView, times: timesView, notify: notifyView, message: messageView };
    mainEl.append(views[state.tab]());
    mainEl.scrollTop = top;
    if (focusKey) {
      const again = [...mainEl.querySelectorAll('[data-fk]')].find((el) => el.dataset.fk === focusKey);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
  }

  // ----- Roles tab -----

  function rolesView() {
    // Targets, invite links and applications belong to the whole VMS event (a role's target is the same on every day),
    // so a multi-day event is one column here, with its counts for the whole event, not one column per day.
    const loaded = [];
    state.loaded.forEach((l) => {
      if (!l.ev.multi) { loaded.push(l); return; }
      if (loaded.some((x) => x.src === l.src)) return;
      const cols = state.loaded.filter((x) => x.src === l.src);
      loaded.push({ ev: { ...l.ev, wd: '', date: l.src.ev.date, days: cols.length, span: cols[0].ev.date.replace(/\/\d{4}$/, '') + '–' + cols[cols.length - 1].ev.date.replace(/\/\d{4}$/, '') },
        roles: l.src.roles, src: l.src });
    });
    const names = new Map();
    loaded.forEach(({ roles }, i) => roles.forEach((r) => {
      const k = r.name.toLowerCase();
      if (!names.has(k)) names.set(k, { name: r.name, key: false, per: [] });
      const row = names.get(k);
      row.key = row.key || r.key;
      row.per[i] = r;
    }));
    const count = (r) => {
      const c = r.counts;
      if (r.admin) return { target: null, assigned: r.assigned.length, pending: 0, applicants: r.applicants.length };
      const pendingPeople = r.assigned.filter((v) => !(v.Assignments || []).some((a) => a.IsNotified)).length;
      return {
        target: c ? c.target : null,
        assigned: c ? c.assigned : r.assigned.length - pendingPeople,
        pending: pendingPeople,
        applicants: c ? c.applicants : r.applicants.length,
      };
    };
    let rows = [...names.values()].sort((a, b) => (b.key - a.key) || a.name.localeCompare(b.name));
    const isShort = (row) => row.per.some((r) => { if (!r) return false; const c = count(r); return c.target > 0 && c.assigned < c.target; });
    if (state.onlyShort) rows = rows.filter(isShort);
    // A role with no target is only hidden if nobody is in it or has applied. While editing targets everything stays visible.
    const inUse = (row) => row.per.some((r) => r && (r.admin || (r.counts && (r.counts.target > 0 || r.counts.applicants > 0))
      || r.assigned.length > 0 || r.applicants.some((v) => !v.otherDay)));
    const hiddenCount = state.hideZero && !state.targetEdit ? rows.filter((row) => !inUse(row)).length : 0;
    if (hiddenCount) rows = rows.filter(inUse);

    const totals = loaded.map(({ roles }) => roles.reduce((t, r) => {
      if (r.admin) return t;
      const c = count(r);
      t.target += Math.max(0, c.target || 0); t.assigned += c.assigned; t.pending += c.pending;
      if (c.target > 0 && c.assigned < c.target) t.short += 1;
      return t;
    }, { target: 0, assigned: 0, pending: 0, short: 0 }));

    const firstCol = () => true;
    const daysOf = (i) => (loaded[i].ev.multi ? loaded[i].ev.days : 1);
    const allDays = (i) => (daysOf(i) > 1 ? ' (all ' + daysOf(i) + ' days)' : '');
    const firsts = loaded.map((l, i) => i).filter(firstCol);
    if (!firsts.includes(state.copyFrom)) state.copyFrom = firsts[0] || 0;
    if (!firsts.includes(state.copyTo) || state.copyTo === state.copyFrom) state.copyTo = firsts.find((i) => i !== state.copyFrom) || 0;
    const editing = state.targetEdit;
    const working = state.targetApplying;
    const edits = state.targetEdits;
    const editKey = (ev, r) => ev.id + ':' + r.id + ':' + (r.custom ? 1 : 0);
    const targetKey = (ev, r) => (ev.vmsId || ev.id) + ':' + r.id + ':' + (r.custom ? 1 : 0);
    const nEdits = () => plural(edits.size, 'target change');
    let applyBtn = null;
    const onTarget = (ev, r, from, input) => {
      const raw = input.value.trim();
      const ok = /^\d{1,3}$/.test(raw) && Number(raw) <= 200;
      const key = targetKey(ev, r);
      if (ok && Number(raw) !== from) edits.set(key, { ev, r, from, value: Number(raw) });
      else edits.delete(key);
      input.classList.toggle('bad', !ok);
      input.classList.toggle('dirty', edits.has(key));
      // Update the button in place so typing down a column keeps the cursor where it is.
      if (applyBtn) { applyBtn.textContent = 'Apply ' + nEdits() + '…'; applyBtn.disabled = !edits.size; }
    };
    const copyTargets = () => {
      const a = state.copyFrom, b = state.copyTo;
      if (a === b || !loaded[a] || !loaded[b] || loaded[a].ev.vmsId === loaded[b].ev.vmsId) return;
      names.forEach((row) => {
        const src = row.per[a], dst = row.per[b];
        if (!src || !dst || !src.counts || !dst.counts || src.admin || dst.admin) return;
        const pending = edits.get(targetKey(loaded[a].ev, src));
        const want = pending ? pending.value : src.counts.target;
        if (want !== dst.counts.target) edits.set(targetKey(loaded[b].ev, dst), { ev: loaded[b].ev, r: dst, from: dst.counts.target, value: want });
        else edits.delete(targetKey(loaded[b].ev, dst));
      });
      state.targetConfirm = false; renderMain();
    };

    const cellActions = (ev, r, i) => {
      const key = editKey(ev, r);
      const hidden = r.counts.hidden;
      const span = ''; // the column header already says the event runs several days
      const every = daysOf(i) > 1 ? 'Applies to every day of this event' : '';
      return [
        r.counts.invite ? h('button', { class: 'lnk', title: 'Copy the Express Volunteer sign-up link for this role' + span, onclick: (e) => copyInvite(ev, r, e.currentTarget) }, 'Invite link') : null,
        r.custom ? null : (state.toggleKey === key
          ? [h('button', { class: 'lnk', disabled: state.toggling, onclick: () => toggleApplications(ev, r, hidden) },
              (hidden ? 'Confirm: allow applications' : 'Confirm: stop applications') + span),
            h('button', { class: 'lnk', onclick: () => { state.toggleKey = ''; renderMain(); } }, 'Cancel')]
          : h('button', { class: 'lnk', title: every, onclick: () => { state.toggleKey = key; renderMain(); } },
            (hidden ? 'Allow applications' : 'Stop applications') + span)),
      ];
    };

    const cell = (ev, r, i) => {
      if (!r) return h('td', { class: 'muted' }, '—');
      const c = count(r);
      const cls = c.target > 0 ? (c.assigned < c.target ? 'short' : 'full') : '';
      const bits = [];
      if (c.pending) bits.push(c.pending + ' not notified');
      if (c.applicants) bits.push(c.applicants + ' applicant' + (c.applicants === 1 ? '' : 's'));
      if (r.counts && r.counts.hidden) bits.push('hidden');
      if (r.inactive) bits.push('inactive');
      const pending = edits.get(targetKey(ev, r));
      return h('td', { class: cls },
        editing && c.target != null
          ? [h('span', { class: 'num' }, c.assigned + ' / '),
            h('input', { type: 'number', min: 0, max: 200, step: 1, class: 'tgt' + (pending ? ' dirty' : ''), disabled: working,
              value: pending ? pending.value : c.target,
              title: 'Target for ' + r.name + (daysOf(i) > 1 ? ' on each of the ' + daysOf(i) + ' days' : ''),
              oninput: (e) => onTarget(ev, r, c.target, e.target) })]
          : h('a', { class: 'num', href: roleUrl(ev, r), target: '_blank', title: 'Open this role in VMS' },
            c.target == null ? c.assigned + (c.assigned === 1 ? ' person' : ' people') : c.assigned + ' / ' + c.target),
        bits.length ? h('div', { class: 'sub' }, bits.join(' · ')) : null,
        !editing && !r.admin && r.counts && firstCol(i) ? h('div', {}, cellActions(ev, r, i)) : null);
    };

    const body = [];
    let lastKey = null;
    rows.forEach((row) => {
      if (row.key !== lastKey) {
        lastKey = row.key;
        body.push(h('tr', { class: 'group' }, h('td', { colSpan: loaded.length + 1 }, row.key ? 'Key roles' : 'Other roles')));
      }
      body.push(h('tr', {}, h('td', {}, row.name), loaded.map(({ ev }, i) => cell(ev, row.per[i], i))));
    });

    return h('div', {},
      h('div', { class: 'bar' },
        h('label', {}, h('input', {
          type: 'checkbox', checked: state.onlyShort,
          onchange: (e) => { state.onlyShort = e.target.checked; renderMain(); },
        }), ' Only roles short of target'),
        h('label', {}, h('input', {
          type: 'checkbox', checked: state.hideZero,
          onchange: (e) => { state.hideZero = e.target.checked; renderMain(); },
        }), ' Hide roles with no target' + (hiddenCount ? ' (' + hiddenCount + ' hidden)' : '')),
        h('span', { class: 'muted grow' }, editing ? 'Type new targets, then apply. Nothing changes in VMS until you confirm.' : 'Each cell is assigned and notified / target.'),
        !editing
          ? [h('button', { onclick: () => { state.newRole.open = !state.newRole.open; state.newRole.confirming = false; state.newRole.error = ''; renderMain(); } },
              state.newRole.open ? 'Close add role' : 'Add role'),
            h('button', { onclick: () => { state.targetEdit = true; state.targetResult = null; state.newRole.open = false; renderMain(); } }, 'Edit targets')]
          : [
            loaded.filter((l, i) => firstCol(i)).length > 1 ? [
              'Copy targets from ',
              h('select', { disabled: working, onchange: (e) => { state.copyFrom = Number(e.target.value); } },
                loaded.map(({ ev }, i) => (firstCol(i) ? h('option', { value: i, selected: state.copyFrom === i }, evShort(ev) + allDays(i)) : null))),
              ' to ',
              h('select', { disabled: working, onchange: (e) => { state.copyTo = Number(e.target.value); } },
                loaded.map(({ ev }, i) => (firstCol(i) ? h('option', { value: i, selected: state.copyTo === i }, evShort(ev) + allDays(i)) : null))),
              h('button', { disabled: working, onclick: copyTargets }, 'Copy'),
            ] : null,
            state.targetConfirm
              ? [h('strong', {}, 'Apply ' + nEdits() + ' to VMS?'),
                h('button', { class: 'primary', disabled: working, onclick: applyTargets }, working ? 'Applying…' : 'Yes, apply'),
                h('button', { disabled: working, onclick: () => { state.targetConfirm = false; renderMain(); } }, 'Back')]
              : [(applyBtn = h('button', { class: 'primary', disabled: !edits.size, onclick: () => { state.targetConfirm = true; renderMain(); } }, 'Apply ' + nEdits() + '…')),
                h('button', { onclick: () => { edits.clear(); state.targetEdit = false; state.targetConfirm = false; renderMain(); } }, edits.size ? 'Discard and close' : 'Done')],
          ]),
      resultBox(state.targetResult, (ok) => plural(ok, 'target') + ' updated in VMS.', ''),
      resultBox(state.newRole.result, (ok) => 'Role added to ' + plural(ok, 'event') + '.', ''),
      addRoleForm(),
      state.inviteLink ? h('div', { class: 'msg' + (state.inviteLink.error ? ' err' : '') },
        h('strong', {}, state.inviteLink.label), state.inviteLink.error ? ': ' + state.inviteLink.error : (state.inviteLink.copied ? ' (copied)' : ' (copy it from here)'),
        state.inviteLink.url ? h('div', { class: 'linkbox' }, state.inviteLink.url) : null,
        h('button', { class: 'lnk', onclick: () => { state.inviteLink = null; renderMain(); } }, 'Dismiss')) : null,
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Role'),
          loaded.map(({ ev }, i) => h('th', {}, evLabel(ev),
            ev.span ? h('small', {}, ev.days + ' days, ' + ev.span + ' · counts for the whole event') : null,
            h('small', {}, totals[i].assigned + ' / ' + totals[i].target + ' filled · ' + totals[i].short + ' roles short'
              + (totals[i].pending ? ' · ' + totals[i].pending + ' not notified' : '')),
            h('div', {},
              h('button', { class: 'lnk', title: allDays(i) ? 'One link for every day of this event' : '', onclick: (e) => copyInvite(ev, null, e.currentTarget) }, 'Event invite link'),
              h('button', { class: 'lnk', title: 'Copy the QR code image and open VMS\'s QR code page', onclick: (e) => copyQr(ev, e.currentTarget) }, 'QR code')))))),
        h('tbody', {}, body)));
  }

  // ----- Add a custom role (Roles tab) -----

  function addRoleForm() {
    const nr = state.newRole;
    if (!nr.open) return null;
    const loaded = state.loaded;
    const evIds = nr.evs || new Set(loaded.map((l) => l.ev.id));
    const picked = loaded.filter((l) => evIds.has(l.ev.id));
    const again = () => { nr.confirming = false; renderMain(); };
    const check = () => {
      const name = nr.name.trim();
      if (!name) return 'Enter a name for the role.';
      if (!/^\d{1,3}$/.test(String(nr.target).trim()) || Number(nr.target) > 200) return 'Target must be a whole number from 0 to 200.';
      if (!picked.length) return 'Tick at least one event.';
      const clash = picked.filter((l) => l.roles.some((r) => r.name.toLowerCase() === name.toLowerCase()));
      if (clash.length) return 'A role called "' + name + '" already exists on ' + clash.map((l) => evShort(l.ev)).join(' and ') + '.';
      return '';
    };
    return h('div', { class: 'card' },
      h('h2', { style: 'margin-top:0' }, 'Add a role'),
      nr.error ? h('div', { class: 'msg err' }, nr.error) : null,
      h('label', { class: 'field' }, h('span', {}, 'Name'),
        h('input', { type: 'text', value: nr.name, disabled: nr.saving, oninput: (e) => { nr.name = e.target.value; nr.error = ''; } })),
      h('label', { class: 'field' }, h('span', {}, 'Target'),
        h('input', { type: 'number', class: 'tgt', min: 0, max: 200, step: 1, value: nr.target, disabled: nr.saving, oninput: (e) => { nr.target = e.target.value; nr.error = ''; } })),
      h('label', { class: 'field' }, h('span', {}, 'Description'),
        h('textarea', { rows: 3, value: nr.desc, disabled: nr.saving, placeholder: 'What the role involves. Include a minimum age if there is one.',
          oninput: (e) => { nr.desc = e.target.value; } })),
      h('label', { class: 'field' }, h('input', { type: 'checkbox', checked: nr.allow, disabled: nr.saving,
        onchange: (e) => { nr.allow = e.target.checked; again(); } }), ' Let volunteers apply for this role'),
      h('div', { class: 'field' }, h('span', {}, 'Add to'),
        loaded.map((l) => h('label', { style: 'margin-right:16px' }, h('input', { type: 'checkbox', checked: evIds.has(l.ev.id), disabled: nr.saving,
          onchange: (e) => { const next = new Set(evIds); e.target.checked ? next.add(l.ev.id) : next.delete(l.ev.id); nr.evs = next; again(); } }), ' ' + evLabel(l.ev)))),
      h('div', { class: 'bar', style: 'margin-bottom:0' },
        nr.confirming
          ? [h('strong', {}, 'Add "' + nr.name.trim() + '" to ' + plural(picked.length, 'event') + ' in VMS?'),
            h('button', { class: 'primary', disabled: nr.saving, onclick: () => saveNewRole(picked) }, nr.saving ? 'Adding…' : 'Yes, add'),
            h('button', { disabled: nr.saving, onclick: again }, 'Cancel')]
          : h('button', { class: 'primary', onclick: () => {
              nr.error = check();
              nr.confirming = !nr.error;
              renderMain();
            } }, 'Add role…')));
  }

  async function saveNewRole(picked) {
    const nr = state.newRole;
    nr.saving = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    const done = new Set();
    for (const { ev } of picked) {
      mark(touched, ev.id, nr.name.trim());
      if (done.has(ev.vmsId)) continue;
      done.add(ev.vmsId);
      try {
        await postJson('/VMS/Services/CustomRoleService.asmx/AddCustomRole', {
          ID: 0, eventID: ev.vmsId, Target: String(Number(nr.target)), Name: nr.name.trim(), Description: nr.desc.trim(), IsHidden: !nr.allow,
        });
        ok += 1;
      } catch (e) {
        failed.push(evShort(ev) + ' (' + e.message + ')');
      }
    }
    await reloadEvents(touched);
    nr.saving = false; nr.confirming = false;
    nr.result = { ok, failed };
    if (!failed.length) { nr.open = false; nr.name = ''; nr.desc = ''; nr.target = '1'; }
    render();
  }

  // Express Volunteer links and their QR codes come from the same VMS page, so one read gives both.
  // They are remembered, so a second click is instant.
  const inviteCache = new Map();
  async function inviteData(ev, r) {
    const key = ev.vmsId + ':' + (r ? (r.custom ? 'c' : 's') + r.id : 'event');
    if (inviteCache.has(key)) return inviteCache.get(key);
    const { doc } = await fetchDoc('/VMS/ExpressInvite.aspx?EventId=' + ev.vmsId
      + (r ? '&RoleId=' + r.id + '&IsCustom=' + (r.custom ? 'True' : 'False') : ''));
    const m = /https:\/\/my\.firstinspires\.org\/ExpressVolunteer\/[^\s"'<]+/.exec(doc.body ? doc.body.innerHTML : '');
    if (!m) throw new Error('VMS did not give a link for this');
    const img = doc.querySelector('#qr_code');
    const qr = img && /^data:image\/png;base64,/.test(img.getAttribute('src') || '') ? img.getAttribute('src') : '';
    const data = { url: m[0], qr };
    inviteCache.set(key, data);
    return data;
  }

  // Animates the clicked button while `work` runs: "Copying…", then a green "✓ Copied" or a red "Could not copy".
  // Only the button changes, so the page stays where it is.
  async function flashCopy(btn, work) {
    if (btn && btn.dataset.busy) return null; // already working on this button
    const text = btn ? btn.dataset.text || btn.textContent : '';
    if (btn) {
      btn.dataset.busy = '1'; btn.dataset.text = text;
      btn.style.minWidth = btn.offsetWidth + 'px';
      btn.classList.remove('copied', 'failed'); btn.classList.add('copying');
      btn.textContent = 'Copying…';
    }
    let ok = true;
    try { await work(); } catch (e) { ok = false; }
    if (btn) {
      btn.classList.remove('copying'); btn.classList.add(ok ? 'copied' : 'failed');
      btn.textContent = ok ? '✓ Copied' : 'Could not copy';
      setTimeout(() => {
        btn.classList.remove('copied', 'failed'); btn.textContent = text; btn.style.minWidth = ''; delete btn.dataset.busy;
      }, 1600);
    }
    return ok;
  }

  // A plain-text report for bug reports: version, what is loaded, request counts and recent errors.
  // It deliberately leaves out volunteer names, emails and ages.
  function diagnosticsText() {
    let version = 'unknown (not installed)';
    try { version = chrome.runtime.getManifest().version; } catch (e) { /* injected copy */ }
    const chromeV = (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1] || '?';
    const stamp = (t) => { const d = new Date(t); return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 8); };
    const lines = ['VMS+ diagnostics', 'Version ' + version + ' · Chrome ' + chromeV + ' · ' + stamp(Date.now()), ''];
    const srcs = [...new Set(state.loaded.map((l) => l.src))];
    lines.push('Events loaded: ' + srcs.length + (state.busy ? ' (still loading: ' + (state.progress || '') + ')' : ''));
    srcs.forEach((raw) => {
      const ev = raw.ev;
      const cols = state.loaded.filter((l) => l.src === raw).length;
      const roles = raw.roles.filter((r) => !r.admin);
      const assigned = roles.reduce((t, r) => t + (Array.isArray(r.assigned) ? r.assigned.length : 0), 0);
      const applicants = roles.reduce((t, r) => t + (Array.isArray(r.applicants) ? r.applicants.length : 0), 0);
      const failed = roles.filter((r) => r.readFailed).length;
      const quiet = roles.filter((r) => r.unchecked).length;
      lines.push('- Event ' + ev.vmsId + ' · ' + (ev.program || '?') + ' · ' + (ev.date || '?') + ' · ' + plural(ev.days || 1, 'day')
        + (cols > 1 ? ' shown as ' + cols + ' columns' : '') + ' · ' + plural(roles.length, 'role') + ' · '
        + assigned + ' assignments · ' + applicants + ' applications'
        + (failed ? ' · ' + failed + ' applicant lists failed' : '') + (quiet ? ' · ' + quiet + ' roles still checking' : '')
        + (raw.extrasPending ? ' · training/last season still loading' : ''));
    });
    const sel = state.events.filter((e) => state.selected.has(e.id));
    if (sel.length !== srcs.length) lines.push('Ticked but not loaded: ' + sel.filter((e) => !srcs.some((r) => r.ev.vmsId === e.vmsId)).map((e) => e.vmsId).join(', '));
    lines.push('');
    const total = Object.values(diag.requests).reduce((a, b) => a + b, 0);
    lines.push('Requests to VMS since ' + stamp(diag.since) + ': ' + total);
    Object.entries(diag.requests).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => lines.push('- ' + k + ': ' + n + ' (slowest ' + ((diag.ms[k] || 0) / 1000).toFixed(1) + 's)'));
    lines.push('Rate-limit pause: ' + (Date.now() < blockedUntil ? 'active, ' + Math.ceil((blockedUntil - Date.now()) / 1000) + 's left' : 'none'));
    lines.push('');
    lines.push('Recent errors: ' + (diag.errors.length ? '' : 'none'));
    diag.errors.forEach((x) => lines.push('- ' + stamp(x.t) + ' · ' + x.key + ' · ' + x.what));
    if (state.error) lines.push('Message shown: ' + state.error);
    lines.push('');
    lines.push('Tab: ' + state.tab + ' · theme ' + state.theme + ' · hide no-target roles ' + (state.hideZero ? 'on' : 'off')
      + ' · minimum ages ' + (state.showAges ? 'on' : 'off') + ' · hide past ' + (state.hidePast ? 'on' : 'off') + ' · staffing view ' + state.staffMode);
    lines.push('Screen ' + window.innerWidth + '×' + window.innerHeight);
    return lines.join('\n');
  }
  const copyDiagnostics = (btn) => flashCopy(btn, () => navigator.clipboard.writeText(diagnosticsText()));

  async function copyInvite(ev, r, btn) {
    const label = (r ? r.name + ' on ' : 'Whole event, ') + evShort(ev);
    let url = '', err = '';
    const ok = await flashCopy(btn, async () => {
      try { url = (await inviteData(ev, r)).url; } catch (e) { err = e.message; throw e; }
      await navigator.clipboard.writeText(url);
    });
    if (ok !== false) return;
    // Only when copying fails: show the link (or the error) so it can be copied by hand.
    state.inviteLink = url ? { label, url, copied: false } : { label, url: '', error: err || 'Could not copy' };
    renderMain();
  }

  // Copies the event's QR code image (a PNG, ready to paste into a flyer or slide), then opens VMS's QR page as before.
  async function copyQr(ev, btn) {
    const page = '/VMS/ExpressInvite.aspx?EventId=' + ev.vmsId;
    const ok = await flashCopy(btn, async () => {
      const { qr } = await inviteData(ev, null);
      if (!qr) throw new Error('No QR code on the VMS page');
      const blob = await (await fetch(qr)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    if (ok === null) return;
    // Open the page behind the dashboard when installed; otherwise in a new tab.
    if (!(canBackground() && await backgroundOpen(location.origin + page))) window.open(page, '_blank');
  }
  const backgroundOpen = (url) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'vc-open', url }, (res) => resolve(!chrome.runtime.lastError && !!res && !!res.ok));
    } catch (e) { resolve(false); }
  });

  // Standard roles only: VMS handles custom roles' visibility on its Manage Custom Roles page.
  async function toggleApplications(ev, r, allow) {
    state.toggling = true; renderMain();
    try {
      await postJson('/VMS/Roles/RoleDetails.aspx/SetVIMSVisibility', { Value: allow, EventID: ev.vmsId, RoleID: r.id });
      await reloadEvents(new Map([[ev.id, new Set()]]));
      state.targetResult = null;
      toast(r.name + ' on ' + evShort(ev) + (allow ? ' is open to applications again.' : ' no longer accepts applications.'));
    } catch (e) { state.error = e.message; }
    state.toggling = false; state.toggleKey = '';
    render();
  }

  async function applyTargets() {
    state.targetApplying = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    const done = new Set();
    for (const { ev, r, value } of state.targetEdits.values()) {
      mark(touched, ev.id);
      const once = ev.vmsId + ':' + r.id + ':' + r.custom;
      if (done.has(once)) continue;
      done.add(once);
      try {
        await svcPost('UpdateTarget', { eventID: ev.vmsId, roleID: r.id, isCustom: r.custom, target: value });
        ok += 1;
      } catch (e) {
        failed.push(r.name + ' on ' + (ev.multi ? ev.name + ' (every day)' : evShort(ev)) + ' (' + e.message + ')');
      }
    }
    await reloadEvents(touched);
    state.targetEdits.clear();
    state.targetApplying = false; state.targetConfirm = false; state.targetEdit = false;
    state.targetResult = { ok, failed };
    render();
  }

  // ----- People tab -----

  const STATUS = [
    ['all', 'Everyone'],
    ['assigned', 'Assigned'],
    ['unassigned', 'Applicants not assigned anywhere'],
    ['unnotified', 'Not notified yet'],
    ['allday', 'Shift is 6am–10pm'],
    ['noshift', 'On schedule, no shift set'],
    ['partial', 'Assigned some days only'],
    ['rolediff', 'Role differs by day'],
    ['todo', 'Anything outstanding (clearance, training, consent)'],
    ['training', 'Required training incomplete'],
    ['consent', 'Consent not signed'],
    ['returning', 'Here last season'],
    ['clearance', 'Needs clearance'],
    ['minor', 'Minors'],
    ['adult', 'Adults only'],
  ];

  function matches(p) {
    const s = state.status;
    if (s === 'assigned' && !p.assignedAnywhere) return false;
    if (s === 'unassigned' && p.assignedAnywhere) return false;
    if (s === 'adult' && p.flags.includes('minor')) return false;
    if (FLAG_LABEL[s] && !p.flags.includes(s)) return false;
    if (s === 'todo' && !owed(p).length) return false;
    if (state.role) {
      const inRole = Object.values(p.ev).some((e) =>
        e.assign.some((a) => a.role === state.role) || (!p.assignedAnywhere && e.applied.some((a) => a.role === state.role)));
      if (!inRole) return false;
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      if (!(p.first + ' ' + p.last + ' ' + p.email).toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function peopleView() {
    const loaded = state.loaded;
    const shown = state.people.filter(matches);
    if (state.sort !== 'name') {
      const dir = state.sort === 'oldest' ? 1 : -1;
      // People with no known date go last either way.
      shown.sort((a, b) => (a.appliedOn == null) - (b.appliedOn == null) || dir * ((a.appliedOn || 0) - (b.appliedOn || 0)));
    }
    const roleNames = [...new Set(loaded.flatMap(({ roles }) => roles.map((r) => r.name)))].sort();
    const emails = [...new Set(shown.map((p) => p.email).filter(Boolean))];
    const remind = ['todo', 'clearance', 'training', 'consent'].includes(state.status) ? state.status : '';

    const evCell = (ev, p) => {
      const e = p.ev[ev.id];
      if (!e) return h('td', { class: 'muted' }, '—');
      const out = [];
      e.assign.forEach((a) => {
        if (!a.shifts.length) out.push(h('div', { class: 'line' }, h('strong', {}, a.role), ' ', a.admin ? null : chip('warn', 'No shift set')));
        a.shifts.forEach((s) => out.push(h('div', { class: 'line' },
          h('strong', {}, a.role), ' ', s.time, ' ',
          s.shadow ? chip('info', 'Shadow') : null,
          s.notified ? chip('ok', 'Notified') : chip('warn', 'Not notified'))));
      });
      if (e.applied.length) {
        out.push(h('div', { class: 'sub' }, 'Applied: ' + e.applied
          .slice().sort((a, b) => String(a.pref).localeCompare(String(b.pref), undefined, { numeric: true }))
          .map((a) => a.role + (a.pref ? ' (#' + a.pref + ')' : '')).join(', ')));
      }
      if (e.appliedOn) out.push(h('div', { class: 'sub' }, 'Applied on ' + fmtDay(e.appliedOn)));
      return h('td', {}, out);
    };

    return h('div', {},
      h('div', { class: 'bar' },
        h('input', { type: 'search', placeholder: 'Search name or email', value: state.search,
          oninput: (e) => { state.search = e.target.value; refreshPeople(); } }),
        h('select', { onchange: (e) => { state.status = e.target.value; renderMain(); } },
          STATUS.map(([v, l]) => h('option', { value: v, selected: state.status === v }, l))),
        h('select', { onchange: (e) => { state.role = e.target.value; renderMain(); } },
          h('option', { value: '' }, 'Any role'),
          roleNames.map((r) => h('option', { value: r, selected: state.role === r }, r))),
        h('select', { title: 'Sort', onchange: (e) => { state.sort = e.target.value; renderMain(); } },
          [['name', 'Sort by name'], ['oldest', 'Applied earliest first'], ['newest', 'Applied latest first']]
            .map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l))),
        h('span', { class: 'muted grow' }, shown.length + ' of ' + state.people.length + ' people'),
        h('button', { class: 'primary', disabled: !emails.length, onclick: () => copyEmails(emails) },
          'Copy ' + emails.length + (emails.length === 1 ? ' email' : ' emails') + ' for BCC'),
        h('button', { disabled: !shown.length, title: 'One row per person, with each day\u2019s role and shift side by side', onclick: () => downloadRoster(shown) }, 'Download roster'),
        h('button', { disabled: !shown.length, title: 'Copies the same roster; paste into cell A1 of a sheet', onclick: () => copyRoster(shown) }, 'Copy for Sheets')),
      remind ? h('div', { class: 'msg' },
        h('strong', {}, 'Reminders. '),
        'Draft email opens one message per person covering everything they still owe: clearance, required training and the consent form, '
          + 'whichever apply. Nothing is sent until you send it. To write to everyone at once, copy the emails for BCC and ',
        h('a', { href: '#', onclick: (e) => {
          e.preventDefault();
          copyText(reminderText(remind === 'todo' ? REMIND_KINDS : [remind], null).body, 'Copied the reminder text.');
        } }, 'copy the general reminder text'), '.',
        (() => {
          const todo = shown.filter((p) => p.email && owed(p).length && !draftedWhen(p));
          const done = shown.filter((p) => draftedWhen(p)).length;
          return h('div', { class: 'bar', style: 'margin:8px 0 0' },
            h('button', { class: 'primary', disabled: !todo.length || state.drafting, onclick: () => draftBatch(todo) },
              state.drafting ? 'Opening drafts…' : !todo.length ? 'All drafted' : todo.length <= DRAFT_BATCH ? 'Draft all ' + todo.length : 'Draft next ' + DRAFT_BATCH + ' of ' + todo.length),
            h('span', {}, 'Opens each person\u2019s draft in a background Gmail tab. Review and send them there.'),
            done ? h('button', { class: 'lnk', title: 'Lets you draft these people again, for a second round of reminders',
              onclick: () => { shown.forEach((p) => REMIND_KINDS.forEach((k) => { if (state.reminded[k]) delete state.reminded[k][p.id]; })); renderMain(); } },
              'Clear drafted marks (' + done + ')') : null);
        })()) : null,
      h('table', { class: 'ptable' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Volunteer'), loaded.map(({ ev }) => h('th', {}, evLabel(ev))), h('th', {}, 'Flags'), remind ? h('th', {}, 'Reminder') : null)),
        h('tbody', {}, shown.map((p) => h('tr', {},
          h('td', {},
            nameLink(p),
            h('div', { class: 'sub' }, p.email + (p.age != null ? ' · age ' + p.age : ''))),
          loaded.map(({ ev }) => evCell(ev, p)),
          h('td', {}, p.flags.map((f) => chip(FLAG_TONE[f], FLAG_LABEL[f], f === 'clearance' ? p.clearance : ''))),
          remind ? h('td', {}, (() => {
            const kinds = owed(p);
            const when = draftedWhen(p);
            return [
              h('button', { disabled: !p.email || !kinds.length, onclick: () => draftReminder(p) }, when ? 'Draft again' : 'Draft email'),
              h('div', { class: 'sub' }, 'Covers ' + kinds.map((k) => REMIND_NAME[k]).join(', ') + (when ? ' · drafted ' + fmtDay(when) : '')),
            ];
          })()) : null)))));
  }

  // ----- Reminders (People tab, when filtered to something a person still owes) -----

  const DASHBOARD_URL = 'https://my.firstinspires.org/Dashboard/';
  function missingTraining(p) {
    const out = [];
    state.loaded.forEach(({ ev }) => {
      const e = p.ev[ev.id];
      owedTraining(e).forEach((t) => {
        const line = (t.role ? t.role + ': ' : '') + t.course;
        if (!out.includes(line)) out.push(line);
      });
    });
    return out;
  }
  // The things a volunteer can still owe, in the order they are written in an email.
  const REMIND_KINDS = ['clearance', 'training', 'consent'];
  const REMIND_NAME = { clearance: 'clearance', training: 'training', consent: 'consent form' };
  const owed = (p) => REMIND_KINDS.filter((k) => p.flags.includes(k));

  // The text of a reminder covering `kinds`. With a person it is addressed to them; without, it is a general
  // version for a BCC email.
  function reminderText(kinds, p) {
    const evs = state.loaded.filter(({ ev }) => !p || (p.ev[ev.id] && (p.ev[ev.id].assign.length || !p.assignedAnywhere))).map(({ ev }) => ev);
    const names = [...new Set(evs.map((ev) => ev.name))];
    const where = names.length ? names.join(' and ') : 'our event';
    const hello = p && p.first ? 'Hi ' + p.first + ',' : 'Hello,';
    const items = [];
    if (kinds.includes('clearance')) {
      items.push({ title: 'Youth Protection screening', lines: ['Your FIRST Youth Protection screening is not complete yet, and you cannot be confirmed in a role until it is. '
        + 'Sign in to your FIRST Dashboard and follow the screening steps shown there.'] });
    }
    if (kinds.includes('training')) {
      const courses = p ? missingTraining(p) : [];
      items.push({ title: 'Required training', lines: ['Please complete the required training for your role' + (courses.length ? ':' : '.'), ...courses.map((c) => '- ' + c)] });
    }
    if (kinds.includes('consent')) {
      items.push({ title: 'Consent and Release form', lines: ['Your FIRST Consent and Release form has not been signed yet. Please sign it before the event.'] });
    }
    const one = items.length === 1;
    const subject = one
      ? { clearance: 'Youth Protection screening for ', training: 'Training to complete before ', consent: 'Consent and Release form for ' }[kinds[0]] + where
      : 'A few things to complete before ' + where;
    const intro = one ? 'There is one thing to take care of before the event.'
      : p ? 'There are ' + items.length + ' things to take care of before the event.'
        : 'One or more of the following may still be outstanding for you. Please check each one before the event.';
    const body = [hello, '', 'Thank you for volunteering at ' + where + '. ' + intro, ''];
    items.forEach((it, i) => { body.push((one ? '' : (i + 1) + '. ') + it.title, ...it.lines, ''); });
    body.push((one ? 'This is' : items.length === 2 ? 'Both of these are' : 'All of these are') + ' in your FIRST Dashboard: ' + DASHBOARD_URL, '', 'Thank you!');
    return { subject, body: body.join('\n') };
  }
  // When this person's current reminder was last drafted (0 = not yet).
  const draftedWhen = (p) => Math.max(0, ...owed(p).map((k) => (state.reminded[k] || {})[p.id] || 0));
  const markDrafted = (p) => owed(p).forEach((k) => {
    state.reminded[k] = state.reminded[k] || {};
    state.reminded[k][p.id] = Date.now();
  });
  const reminderLink = (p) => {
    const t = reminderText(owed(p), p);
    return 'mailto:' + encodeURIComponent(p.email) + '?subject=' + encodeURIComponent(t.subject) + '&body=' + encodeURIComponent(t.body.replace(/\n/g, '\r\n'));
  };
  // The extension's background script opens a draft as a Gmail compose tab behind this one.
  // It is only there in the installed extension, and not in a VMS tab left open from before the extension was reloaded.
  const canBackground = () => { try { return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id; } catch (e) { return false; } };
  const backgroundDraft = (mailto, offset) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'vc-draft', mailto, offset }, (res) => resolve(!chrome.runtime.lastError && !!res && !!res.ok));
    } catch (e) { resolve(false); }
  });

  async function draftReminder(p) {
    const mailto = reminderLink(p);
    markDrafted(p);
    renderMain();
    // If the background route is not available (or fails), fall back to the computer's own mail handler.
    if (canBackground() && await backgroundDraft(mailto, 0)) toast('Draft opened in a background tab.');
    else h('a', { href: mailto }).click();
  }

  // Open the next batch of drafts, each in its own background tab, in list order.
  const DRAFT_BATCH = 10;
  async function draftBatch(todo) {
    if (!canBackground()) {
      toast('Drafting several at once needs the installed extension. Reload this VMS page and try again.');
      return;
    }
    const batch = todo.slice(0, DRAFT_BATCH);
    state.drafting = true; renderMain();
    let opened = 0;
    for (const p of batch) {
      if (!await backgroundDraft(reminderLink(p), opened)) break;
      markDrafted(p);
      opened += 1;
    }
    state.drafting = false;
    const left = todo.length - opened;
    toast(opened ? 'Opened ' + plural(opened, 'draft') + ' in background tabs.' + (left ? ' ' + left + ' still to draft.' : '')
      : 'Could not open drafts. Reload this VMS page and try again.');
  }

  // ----- Roster export (People tab) -----

  function rosterTable(shown) {
    const loaded = state.loaded;
    const head = ['Last name', 'First name', 'Email', 'Phone', 'Age', 'Shirt size', 'Pronouns'];
    loaded.forEach(({ ev }) => head.push(evShort(ev) + ' role', evShort(ev) + ' shift', evShort(ev) + ' notified'));
    head.push('Applied for', 'Flags');
    const rows = shown.map((p) => {
      const row = [p.last, p.first, p.email, p.raw.PhoneNumber || '', p.age != null ? String(p.age) : '', p.raw.ShirtSize || '', p.raw.PersonalPronounText || ''];
      loaded.forEach(({ ev }) => {
        const assign = p.ev[ev.id] ? p.ev[ev.id].assign : [];
        const shifts = assign.flatMap((a) => a.shifts);
        row.push(assign.map((a) => a.role).join('; '),
          [...new Set(shifts.map((x) => x.time).filter(Boolean))].join('; '),
          !shifts.length ? '' : shifts.every((x) => x.notified) ? 'Yes' : 'No');
      });
      row.push([...new Set(Object.values(p.ev).flatMap((e) => e.applied.map((a) => a.role)))].join('; '),
        p.flags.map((f) => FLAG_LABEL[f]).join('; '));
      return row;
    });
    return [head, ...rows];
  }
  function downloadRoster(shown) {
    const quote = (c) => (/[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
    const csv = '\ufeff' + rosterTable(shown).map((r) => r.map((c) => quote(String(c == null ? '' : c))).join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const a = h('a', { href: url, download: 'volunteer-roster-' + stamp + '.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Downloaded a roster of ' + plural(shown.length, 'person').replace('persons', 'people') + '. The file contains personal details.');
  }
  function copyRoster(shown) {
    const flat = (c) => String(c == null ? '' : c).replace(/[\t\r\n]+/g, ' ');
    copyText(rosterTable(shown).map((r) => r.map(flat).join('\t')).join('\n'),
      'Copied a roster of ' + plural(shown.length, 'person').replace('persons', 'people') + '. Paste into cell A1.');
  }
  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); } catch (e) { toast('Could not copy: ' + e.message); }
  }

  // ----- Shared helpers for the tabs that write -----

  const evShort = (ev) => (ev.date ? (ev.wd ? ev.wd + ' ' : '') + ev.date.replace(/\/\d{4}$/, '') : ev.name);
  // The VMS event behind a column id.
  const vmsEventOf = (key) => { const l = state.loaded.find((x) => String(x.ev.id) === String(key)); return l ? l.ev.vmsId : Number(key); };
  const fullName = (v) => ((v.PreferredName || v.FirstName || '') + ' ' + (v.LastName || '')).trim();
  // Staffing tab only: with "Hide last names" on, show the first name, plus a last initial when two people share it.
  const staffName = (peopleId, full) => {
    if (!state.hideLast) return full;
    const person = state.people.find((x) => x.id === peopleId);
    if (!person) return full.split(' ')[0];
    const twin = state.people.some((x) => x !== person && x.first.toLowerCase() === person.first.toLowerCase());
    return person.first + (twin && person.last ? ' ' + person.last[0] + '.' : '');
  };
  const roleIn = (item, name) => item.roles.find((r) => r.name.toLowerCase() === name.toLowerCase() && !r.admin && !r.inactive);
  const realAssign = (person, evId) => (person.ev[evId] ? person.ev[evId].assign.filter((a) => !a.admin) : []);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  // Record which roles of which event a change touched. No role = counts only; null = every role.
  function mark(scope, evId, role) {
    if (!scope.has(evId)) scope.set(evId, new Set());
    if (role === null) scope.set(evId, null);
    else if (role !== undefined && scope.get(evId)) scope.get(evId).add(role.toLowerCase());
  }

  // Refresh after a change. `scope` maps event id to the roles whose people lists need re-reading.
  async function reloadEvents(scope) {
    state.progress = 'Saved in VMS. Refreshing…'; renderHeader();
    try {
      // Several day columns can share one VMS event: combine what each of them needs re-read.
      const groups = new Map();
      state.loaded.forEach((item) => {
        if (!scope.has(item.ev.id)) return;
        const want = scope.get(item.ev.id);
        const cur = groups.get(item.src);
        if (!groups.has(item.src)) groups.set(item.src, want === null ? null : new Set(want));
        else if (cur === null || want === null) groups.set(item.src, null);
        else want.forEach((r) => cur.add(r));
      });
      for (const [src, only] of groups) {
        const fresh = splitDays(await loadEvent(src.ev, () => {}, src, only));
        const at = state.loaded.findIndex((l) => l.src === src);
        state.loaded = state.loaded.filter((l) => l.src !== src);
        state.loaded.splice(at, 0, ...fresh);
      }
      state.people = buildPeople(state.loaded);
    } catch (e) { state.error = e.message; }
    state.progress = ''; renderHeader();
    background();
  }

  // Work left for after the dashboard is usable, done one request at a time:
  // first the quiet roles skipped at load (almost always empty), then the training and last-season reports.
  let working = false;
  let notesShown = true, notesSince = 0;
  async function background() {
    if (working) return;
    working = true;
    const srcOf = (vmsId) => { const l = state.loaded.find((x) => x.ev.vmsId === vmsId); return l ? l.src : null; };
    const rebuild = (raw) => {
      const at = state.loaded.findIndex((l) => l.src === raw);
      if (at < 0) return;
      state.loaded = state.loaded.filter((l) => l.src !== raw);
      state.loaded.splice(at, 0, ...splitDays(raw));
      state.people = buildPeople(state.loaded);
      state.note = ''; render();
    };
    try {
      for (;;) {
        if (state.busy) break;
        const q = state.loaded.find((l) => l.src.roles.some((r) => r.unchecked));
        if (q) {
          const vmsId = q.ev.vmsId, role = q.src.roles.find((r) => r.unchecked);
          const left = [...new Set(state.loaded.map((l) => l.src))].reduce((t, raw) => t + raw.roles.filter((r) => r.unchecked).length, 0);
          state.note = 'Checking ' + left + ' quiet role' + (left === 1 ? '' : 's') + '…'; renderHeader();
          const rows = await svc('GetAssignedVolunteers', { eventID: vmsId, roleID: role.id, isCustom: role.custom, viewType: 'Event', day: 0 });
          const cur = srcOf(vmsId);
          const target = cur && cur.roles.find((r) => r.id === role.id && r.custom === role.custom);
          if (target && target.unchecked) {
            target.unchecked = false;
            if (Array.isArray(rows) && rows.length) { target.assigned = rows; rebuild(cur); }
          }
          continue;
        }
        const x = state.loaded.find((l) => l.src.extrasPending);
        if (x) {
          const vmsId = x.ev.vmsId;
          state.note = 'Loading training and last-season details…'; renderHeader();
          let training = new Map(), lastSeason = new Map();
          // Each is a nice-to-have: if one can't be read, carry on without it.
          try { training = await loadTraining(vmsId); } catch (e) { if (Date.now() < blockedUntil) throw e; }
          try { lastSeason = await loadLastSeason(vmsId); } catch (e) { if (Date.now() < blockedUntil) throw e; }
          const cur = srcOf(vmsId);
          if (cur && cur.extrasPending) {
            cur.extrasPending = false; cur.training = training; cur.lastSeason = lastSeason;
            state.loaded.forEach((l) => { if (l.src === cur) { l.training = training; l.lastSeason = lastSeason; } });
            rebuild(cur);
          }
          continue;
        }
        // Last, coordinator comments for everyone loaded, one person at a time.
        const waiting = state.people.filter((p) => !vcNotes.has(p.id));
        if (waiting.length) {
          state.note = 'Checking coordinator comments (' + waiting.length + ' left)…'; renderHeader();
          const id = waiting[0].id;
          let rows = [];
          try { rows = await svc('GetVCComments', { peopleID: id }); } catch (e) { if (Date.now() < blockedUntil) throw e; }
          vcNotes.set(id, usableNotes(rows));
          if (vcNotes.get(id).length) notesShown = false;
          // Show new marks every so often and at the end, but not while someone is typing.
          if (!notesShown && (waiting.length === 1 || ++notesSince >= 25)) {
            notesSince = 0;
            const typing = shadow.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(shadow.activeElement.tagName);
            if (state.tab === 'staff' && !typing && !state.staffApplying) { notesShown = true; renderMain(); }
          }
          continue;
        }
        break;
      }
    } catch (e) {
      state.error = 'Could not finish loading the remaining details (' + e.message + '). Press Refresh to try again.';
      working = false; state.note = ''; render();
      return;
    }
    working = false;
    state.note = ''; renderHeader();
  }

  // ----- Hiding applicants (Staffing tab) -----
  // Hiding only takes someone out of the applicant lists; VMS tells the volunteer nothing, and it can be undone.

  const hideCall = (vmsId, roleId, people, hide) => svcPost('HideUnhideVolunteer', { eventID: vmsId, peopleRoleID: roleId, people: String(people), hide });
  const readHidden = (raw, role) => svc('GetUnassignedVolunteers', { eventID: raw.ev.id, roleID: role.id, tab: 'Hidden', isCustom: role.custom });
  const readApplicants = (raw, role) => svc('GetUnassignedVolunteers', { eventID: raw.ev.id, roleID: role.id, tab: 'Applicants', isCustom: role.custom });
  // Who is hidden from the whole event: anyone on two different roles' Hidden lists.
  async function readEventHidden(raw) {
    const probes = raw.roles.filter((r) => !r.admin).slice(0, 2);
    if (probes.length < 2) return;
    const lists = await Promise.all(probes.map((r) => readHidden(raw, r)));
    const both = new Set(lists[1].map((v) => v.PeopleID));
    raw.eventHidden = lists[0].filter((v) => both.has(v.PeopleID));
  }
  function redrawAfterHide(raws) {
    raws.forEach((raw) => {
      const at = state.loaded.findIndex((l) => l.src === raw);
      if (at < 0) return;
      state.loaded = state.loaded.filter((l) => l.src !== raw);
      state.loaded.splice(at, 0, ...splitDays(raw));
    });
    state.people = buildPeople(state.loaded);
    state.hiding = false; state.hideAsk = null;
    render();
  }

  // scope: 'role' hides from the named role only, 'all' from every role of the event.
  async function hidePerson(person, roleName, scope) {
    state.hiding = true; renderMain();
    const raws = [...new Set(state.loaded.filter((l) => person.ev[l.ev.id]).map((l) => l.src))];
    const failed = [];
    for (const raw of raws) {
      const role = raw.roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase() && !r.admin);
      try {
        if (scope === 'role') {
          if (!role) continue;
          await hideCall(raw.ev.id, role.id, person.id, true);
          role.applicants = (Array.isArray(role.applicants) ? role.applicants : []).filter((v) => v.PeopleID !== person.id);
          if (role.counts) role.counts.applicants = Math.max(0, role.counts.applicants - 1);
          role.hidden = await readHidden(raw, role);
          const all = new Set((raw.eventHidden || []).map((v) => v.PeopleID));
          role.hidden = role.hidden.filter((v) => !all.has(v.PeopleID));
        } else {
          await hideCall(raw.ev.id, 0, person.id, true);
          raw.roles.forEach((r) => {
            const had = Array.isArray(r.applicants) && r.applicants.some((v) => v.PeopleID === person.id);
            if (had) { r.applicants = r.applicants.filter((v) => v.PeopleID !== person.id); if (r.counts) r.counts.applicants = Math.max(0, r.counts.applicants - 1); }
            r.hidden = (r.hidden || []).filter((v) => v.PeopleID !== person.id);
          });
          await readEventHidden(raw);
        }
      } catch (e) { failed.push(evShort(raw.ev) + ' (' + e.message + ')'); }
    }
    redrawAfterHide(raws);
    toast(failed.length ? 'Could not hide on ' + failed.join('; ') : person.first + ' is hidden from ' + (scope === 'role' ? roleName : 'all roles') + '.');
  }

  // records: [{ raw, row, scope }] as listed under "Hidden" for the role.
  async function unhidePerson(records, roleName) {
    state.hiding = true; renderMain();
    const failed = [];
    const raws = [...new Set(records.map((x) => x.raw))];
    for (const { raw, row, scope } of records) {
      try {
        await hideCall(raw.ev.id, 0, row.HiddenID, false);
        const key = personKey(row.Email, row.LastName, row.FirstName);
        // Back in the applicant list of this role, or of every role they applied for.
        const names = scope === 'role' ? [roleName.toLowerCase()]
          : [...new Set((raw.apps || []).filter((x) => x.open && x.key === key).map((x) => x.role))];
        if (scope === 'all') await readEventHidden(raw);
        const all = new Set((raw.eventHidden || []).map((v) => v.PeopleID));
        for (const role of raw.roles.filter((r) => !r.admin && names.includes(r.name.toLowerCase()))) {
          role.applicants = await readApplicants(raw, role);
          if (role.counts) role.counts.applicants = role.applicants.length;
          if (scope === 'role') role.hidden = (await readHidden(raw, role)).filter((v) => !all.has(v.PeopleID));
        }
      } catch (e) { failed.push(evShort(raw.ev) + ' (' + e.message + ')'); }
    }
    redrawAfterHide(raws);
    toast(failed.length ? 'Could not unhide on ' + failed.join('; ') : 'Unhidden.');
  }

  function resultBox(result, okText, tail) {
    if (!result) return null;
    return h('div', { class: 'msg' + (result.failed.length ? ' err' : '') },
      okText(result.ok) + (result.failed.length ? ' ' + result.failed.length + ' failed: ' + result.failed.join('; ') + '.' : '')
      + (result.ok && tail ? ' ' + tail : ''));
  }

  // ----- Volunteer detail panel -----

  function profileUrl(person) {
    const key = Object.keys(person.ev)[0];
    const evId = vmsEventOf(key);
    const e = person.ev[key];
    const r = e.assign[0] || e.applied[0] || {};
    return '/VMS/Volunteers/VolunteerDetails.aspx?ID=' + evId + '&RoleID=' + (r.roleId || 0)
      + '&IsCustom=' + (r.custom ? 'True' : 'False') + '&PeopleID=' + person.id;
  }
  const nameLink = (person, text) => h('a', {
    class: 'pname', href: '#', title: 'Show details',
    onclick: (e) => { e.preventDefault(); openDetail(person.id); },
  }, text || person.first + ' ' + person.last);

  function openDetail(id) {
    const person = state.people.find((x) => x.id === id);
    if (!person) return;
    state.detail = { id, extra: {} };
    renderPanel();
    const set = (key, value) => {
      if (!state.detail || state.detail.id !== id) return;
      state.detail.extra[key] = value;
      renderPanel();
    };
    const evId = vmsEventOf(Object.keys(person.ev)[0]);
    const want = (key, promise) => promise.then((v) => set(key, v), () => set(key, null));
    want('season', svc('GetVolunteerAssignments', { peopleID: id, isCurrentSeason: true }));
    want('history', svc('GetVolunteerAssignments', { peopleID: id, isCurrentSeason: false }));
    want('others', svc('GetVolunteerApplications', { peopleID: id, eventID: evId, excludeEvent: true }));
    want('comments', svc('GetVCComments', { peopleID: id }).then((rows) => { vcNotes.set(id, usableNotes(rows)); return rows; }));
    want('profile', fetchDoc(profileUrl(person)).then(({ doc }) => {
      const pick = (name) => txt(doc.getElementById('MainContent_' + name));
      // Split an element's text into lines wherever the page breaks it visually.
      const lines = (name) => {
        const out = [];
        let cur = '';
        const flush = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t) out.push(t); cur = ''; };
        const walk = (node) => {
          if (node.nodeType === 3) { cur += node.nodeValue; return; }
          if (node.nodeType !== 1) return;
          const block = /^(BR|LI|DIV|P|TR|UL|OL|TABLE)$/.test(node.tagName);
          if (block) flush();
          node.childNodes.forEach(walk);
          if (block) flush();
        };
        const el = doc.getElementById('MainContent_' + name);
        if (el) { walk(el); flush(); }
        return out;
      };
      return {
        dietary: pick('DietaryRestrictionsLabel'), limits: pick('PhysicalLimitationsLabel'),
        emergency: [pick('EmergencyContactLabel'), pick('EmergencyContactNumberLabel')].filter(Boolean).join(' · '),
        skills: pick('skillsLabel'), teams: lines('team_affiliationLabel'), orgs: pick('person_affiliation'),
        courses: lines('CourseListDiv'),
      };
    }));
  }
  function closeDetail() { state.detail = null; renderPanel(); }
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.detail) closeDetail(); });

  function renderPanel() {
    const person = state.detail && state.people.find((x) => x.id === state.detail.id);
    panelEl.hidden = !person;
    panelEl.replaceChildren();
    if (!person) { state.detail = null; return; }
    const v = person.raw || {};
    const x = state.detail.extra;
    const blank = (t) => !t || /^(none|n\/a|not specified|no|-)$/i.test(String(t).trim());
    const kv = (pairs) => {
      const shown = pairs.filter(([, val]) => val != null && val !== '' && val !== false);
      return shown.length ? h('dl', { class: 'kv' }, shown.map(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])) : h('div', { class: 'sub' }, 'Nothing recorded.');
    };
    const list = (items, limit) => (items.length
      ? h('ul', {}, items.slice(0, limit).map((t) => h('li', {}, t)), items.length > limit ? h('li', { class: 'muted' }, 'and ' + (items.length - limit) + ' more') : null)
      : h('div', { class: 'sub' }, 'None.'));
    // undefined = still loading, null = the request failed.
    const lazy = (value, build) => (value === undefined ? h('div', { class: 'sub' }, 'Loading…')
      : value === null ? h('div', { class: 'sub' }, 'Could not load this from VMS.') : build(value));
    const loadedIds = new Set(state.loaded.map((l) => l.ev.vmsId));

    const perEvent = state.loaded.filter((l) => person.ev[l.ev.id]).map(({ ev }) => {
      const e = person.ev[ev.id];
      const rec = (e.recs[0] || {}).v || {};
      const comments = [...new Set(e.recs.map((r) => r.v.Comments).filter((t) => !blank(t)))];
      return [h('h3', {}, evLabel(ev)), kv([
        ['Assigned', e.assign.length ? e.assign.map((a) => h('div', {}, a.role,
          a.shifts.map((sh) => [' ', sh.time, ' ', sh.notified ? chip('ok', 'Notified') : chip('warn', 'Not notified')]),
          !a.shifts.length && !a.admin ? [' ', chip('warn', 'No shift set')] : null)) : 'Not assigned'],
        ['Applied for', e.applied.length ? e.applied.slice().sort((a, b) => String(a.pref).localeCompare(String(b.pref), undefined, { numeric: true }))
          .map((a) => h('div', {}, (a.pref ? '#' + a.pref + ' ' : '') + a.role + (a.times ? ' (done ' + a.times + (a.times === 1 ? ' time' : ' times') + ')' : ''))) : null],
        ['Applied on', e.appliedOn ? new Date(e.appliedOn).toLocaleDateString() : null],
        ['Days available', rec.DaysAvailable],
        ['Last season here', e.lastSeason || null],
        ['Training', e.training && e.training.length ? e.training.map((t) => h('div', {}, t.course, ' ',
          t.done ? chip('ok', 'Done') : t.required ? chip('warn', 'Required, not done') : chip('info', 'Optional, not done'))) : null],
        ['Their comment', comments.length ? comments.map((t) => h('div', {}, t)) : null],
      ])];
    });

    panelEl.append(
      h('div', { class: 'bar' },
        h('h2', { class: 'grow' }, person.first + ' ' + person.last),
        h('button', { onclick: closeDetail, title: 'Close (Esc)' }, 'Close')),
      h('div', {}, person.flags.map((f) => chip(FLAG_TONE[f], FLAG_LABEL[f], f === 'clearance' ? person.clearance : ''))),
      h('h3', {}, 'Contact'),
      kv([
        ['Email', person.email ? h('a', { href: 'mailto:' + person.email }, person.email) : null],
        ['Phone', /^\d{10}$/.test(v.PhoneNumber || '') ? v.PhoneNumber.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3') : v.PhoneNumber],
        ['Location', [v.City, v.State].filter(Boolean).join(', ')],
        ['Age', person.age != null ? person.age + (person.age < 18 ? ' (minor)' : '') : null],
        ['Pronouns', blank(v.PersonalPronounText) ? null : v.PersonalPronounText],
        ['Languages', blank(v.LanguagesSpoken) ? null : v.LanguagesSpoken],
      ]),
      h('h3', {}, 'Clearance and paperwork'),
      kv([
        ['Youth protection', person.clearance || (person.cleared ? 'Meets requirements' : 'Not cleared')],
        ['Pennsylvania', blank(v.YPPStatusPA) || /no known roles/i.test(v.YPPStatusPA) ? null : v.YPPStatusPA],
        ['California', blank(v.YPPStatusCA) || /no known roles/i.test(v.YPPStatusCA) ? null : v.YPPStatusCA],
        ['Consent and release', v.SignedConsentReleaseStatus],
        ['Role training', v.IsCertified ? 'Certified for a role they applied to' : null],
      ]),
      h('div', {}, perEvent),
      h('h3', {}, 'About'),
      kv([
        ['Years with FIRST', v.InFIRST ? String(v.InFIRST) : null],
        ['FIRST alumni', v.FlagIsAlumni ? 'Yes' : null],
        ['Shirt size', blank(v.ShirtSize) ? null : v.ShirtSize],
        ['Organization', blank(v.Organization) ? null : v.Organization],
        ['Accommodations', blank(v.PhysicalLimitations) ? null : v.PhysicalLimitations],
      ]),
      h('h3', {}, 'From their VMS profile'),
      lazy(x.profile, (pr) => kv([
        ['Dietary', blank(pr.dietary) ? null : pr.dietary],
        ['Accommodations', blank(pr.limits) || !blank(v.PhysicalLimitations) ? null : pr.limits],
        ['Emergency contact', pr.emergency],
        ['Team affiliations', (() => {
          const teams = pr.teams.filter((n) => !blank(n) && !/no affiliation/i.test(n));
          return teams.length ? teams.map((n) => h('div', {}, n)) : null;
        })()],
        ['Affiliations', blank(pr.orgs) || /no affiliation/i.test(pr.orgs) ? null : pr.orgs],
        ['Skills', blank(pr.skills) ? null : pr.skills],
        ['Training completed', pr.courses.length ? pr.courses.map((t) => h('div', {}, t)) : null],
      ])),
      h('h3', {}, 'All assignments this season'),
      lazy(x.season, (rows) => list(rows.map((r) => [r.EventDateDisplay, r.EventName, r.RoleName, r.AssignmentStatus].filter(Boolean).join(' · ')), 20)),
      h('h3', {}, 'Applied to other events'),
      lazy(x.others, (rows) => list([...new Set(rows.filter((r) => !loadedIds.has(r.EventID))
        .map((r) => [r.EventStartDateDisplay, r.EventName].filter(Boolean).join(' · ')))], 12)),
      h('h3', {}, 'Previous seasons'),
      lazy(x.history, (rows) => list(rows.map((r) => [r.EventDateDisplay, r.EventName, r.RoleName].filter(Boolean).join(' · ')), 12)),
      h('h3', {}, 'Coordinator comments'),
      lazy(x.comments, (rows) => list(rows.map((r) => (r.postedDate ? r.postedDate + ': ' : '') + r.note), 20)),
      h('div', { style: 'margin-top:18px' },
        h('a', { href: profileUrl(person), target: '_blank' }, 'Open full profile in VMS')));
  }

  // ----- Staffing tab -----

  function staffView() {
    const loaded = state.loaded;
    let names = [...new Map(loaded.flatMap((l) => l.roles.filter((r) => !r.admin && !r.inactive)
      .map((r) => [r.name.toLowerCase(), { name: r.name, key: r.key }]))).values()]
      .sort((a, b) => (b.key - a.key) || a.name.localeCompare(b.name));
    const allRoleCount = names.length;
    if (state.hideZero) {
      names = names.filter((n) => loaded.some((l) => {
        const r = roleIn(l, n.name);
        return r && ((r.counts && r.counts.target > 0) || r.assigned.length > 0 || r.applicants.some((v) => !v.otherDay)
          || state.staged.some((x) => x.evId === l.ev.id && x.role === n.name));
      }));
    }
    if (!names.some((n) => n.name === state.staffRole)) state.staffRole = names.length ? names[0].name : '';
    const cur = state.staffRole;
    const busy = state.staffApplying;
    const stagedFor = (evId, role) => state.staged.filter((x) => !x.remove && x.evId === evId && x.role === role);
    const removalOf = (evId, role, peopleId) => state.staged.find((x) => x.remove && x.evId === evId && x.role === role && x.peopleId === peopleId);
    const sameRole = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
    const fill = (l, name) => {
      const r = roleIn(l, name);
      if (!r) return null;
      const leaving = state.staged.filter((x) => x.remove && x.evId === l.ev.id && x.role === name).length;
      return { r, have: r.assigned.length - leaving + stagedFor(l.ev.id, name).length, target: r.counts ? r.counts.target : null };
    };

    // A small badge with the role's minimum age. Its colour shows the age band; it turns red when
    // someone assigned or staged is younger than the minimum on that day.
    const placedIds = (l, name) => {
      const r = roleIn(l, name);
      return [...(r ? r.assigned.filter((v) => !removalOf(l.ev.id, name, v.PeopleID)).map((v) => v.PeopleID) : []),
        ...stagedFor(l.ev.id, name).map((x) => x.peopleId)];
    };
    const ageBadge = (name) => {
      const per = loaded.filter((l) => roleIn(l, name)).map((l) => ({ l, rule: ageRule(name, l.ev) })).filter((x) => x.rule);
      if (!per.length) return null;
      const mins = [...new Set(per.map((x) => x.rule.min))].sort((a, b) => a - b);
      const young = per.flatMap((x) => placedIds(x.l, name).map((id) => state.people.find((p) => p.id === id))
        .filter((p) => ageIssue(p, x.rule) === 'under').map((p) => staffName(p.id, p.first + ' ' + p.last) + ' (' + p.age + ', ' + evShort(x.l.ev) + ')'));
      const tone = young.length ? 'bad' : mins[mins.length - 1] >= 21 ? 'warn' : mins[mins.length - 1] >= 18 ? 'info' : 'ok';
      const tip = 'FIRST recommended minimum age: ' + [...new Set(per.map((x) => (per.length > 1 ? evShort(x.l.ev) + ' ' : '') + ageText(x.rule)))].join('; ')
        + (young.length ? '. Under the minimum: ' + [...new Set(young)].join(', ') : '');
      return h('span', { class: 'chip ' + tone + ' agechip', title: tip }, (young.length ? '! ' : '') + mins.join('/') + '+');
    };
    const roleList = h('div', { class: 'card rolelist' },
      h('label', { class: 'rrow', style: 'justify-content:flex-start' }, h('input', {
        type: 'checkbox', checked: state.hideZero,
        onchange: (e) => { state.hideZero = e.target.checked; state.staffConfirm = false; renderMain(); },
      }), 'Hide roles with no target' + (allRoleCount > names.length ? ' (' + (allRoleCount - names.length) + ')' : '')),
      h('label', { class: 'rrow', style: 'justify-content:flex-start', title: 'FIRST\'s recommended minimum age for each role. Red means someone placed is younger.' }, h('input', {
        type: 'checkbox', checked: state.showAges,
        onchange: (e) => { state.showAges = e.target.checked; renderMain(); },
      }), 'Show minimum ages'),
      h('div', { class: 'rrow muted', style: 'cursor:default' }, h('span', {}, 'Role'), h('span', {}, loaded.map((l) => evShort(l.ev)).join(' · '))),
      names.map((n) => h('div', {
        class: 'rrow' + (n.name === cur ? ' on' : ''),
        onclick: () => { state.staffRole = n.name; state.staffConfirm = false; renderMain(); },
      }, h('span', { class: 'rname' }, state.showAges ? ageBadge(n.name) || h('span', { class: 'agechip none' }) : null, h('span', {}, n.name)),
      h('span', { class: 'cnt' }, loaded.map((l, i) => {
        const f = fill(l, n.name);
        const text = f ? f.have + '/' + (f.target == null ? '?' : f.target) : '—';
        // Each count keeps its separator, so a long row only breaks between events.
        return [i ? ' ' : '', h('span', {}, h('span', { class: f && f.target > 0 ? (f.have < f.target ? 'lo' : 'hi') : '' }, text), i < loaded.length - 1 ? ' ·' : '')];
      })))));

    const withRole = loaded.filter((l) => roleIn(l, cur));
    // "Filling" narrows the people list to one day, started by clicking an open slot.
    if (state.fill && (state.fill.role !== cur || !withRole.some((l) => l.ev.id === state.fill.evId))) state.fill = null;

    // One entry per person in this role on any loaded day, holding what they have on each day.
    const entries = new Map();
    const entryFor = (id, last, first) => {
      if (!entries.has(id)) entries.set(id, { id, last, first, cells: withRole.map(() => null), back: false, untrained: false, age: null });
      return entries.get(id);
    };
    // Only the events that have this role get a column.
    const cols = withRole.map((l, i) => {
      const f = fill(l, cur);
      if (!f) return { l, f: null, open: 0 };
      const times = new Map();
      f.r.assigned.forEach((v) => {
        const shifts = v.Assignments || [];
        const person = state.people.find((x) => x.id === v.PeopleID);
        const e = person && person.ev[l.ev.id];
        const en = entryFor(v.PeopleID, v.LastName || '', v.PreferredName || v.FirstName || '');
        if (e && e.lastSeason && e.lastSeason.toLowerCase().includes(cur.toLowerCase())) en.back = true;
        if (e && (e.training || []).some((t) => t.required && !t.done && sameRole(t.role, cur))) en.untrained = true;
        const time = [...new Set(shifts.map((a) => a.ScheduleDisplayTime))].join(', ');
        const gone = removalOf(l.ev.id, cur, v.PeopleID);
        if (time && !gone) times.set(time, (times.get(time) || 0) + 1);
        en.cells[i] = { v, time, count: shifts.length, notified: shifts.some((a) => a.IsNotified), gone };
      });
      stagedFor(l.ev.id, cur).forEach((x) => {
        const person = state.people.find((y) => y.id === x.peopleId);
        const en = entryFor(x.peopleId, person ? person.last : '', person ? person.first : x.name);
        if (!en.cells[i]) en.cells[i] = { staged: x };
      });
      // Anyone placed on this day who is younger than FIRST's recommended age for the role here.
      const rule = ageRule(cur, l.ev);
      entries.forEach((en) => {
        if (!en.cells[i]) return;
        const issue = ageIssue(state.people.find((x) => x.id === en.id), rule);
        if (issue && (!en.age || issue === 'under')) en.age = { issue, rule, age: state.people.find((x) => x.id === en.id).age };
      });
      // The header shows the shift time set for this day and role (what new assignments get). Where none is set,
      // it shows the time most people already have. A cell only shows a time when it differs from the header.
      const top = [...times.entries()].sort((a, b) => b[1] - a[1])[0];
      const want = effectiveTime(l.ev.id, cur);
      const common = want ? vmsRange(want) : (top ? top[0] : '');
      const differ = [...times.entries()].reduce((n, [time, count]) => n + (time !== common ? count : 0), 0);
      return { l, f, common, set: !!want, differ, want, open: f.target != null ? Math.max(0, f.target - f.have) : 0 };
    });
    if (state.fill && !cols.some((c) => c.l.ev.id === state.fill.evId && c.open > 0)) state.fill = null;
    const fillDay = state.fill ? state.fill.evId : null;
    const list = [...entries.values()].sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first));
    const showName = (en) => (state.hideLast ? staffName(en.id, (en.first + ' ' + en.last).trim()) : (en.last ? en.last + ', ' + en.first : en.first));
    const startFill = (l) => { state.fill = { evId: l.ev.id, role: cur }; state.staffConfirm = false; renderMain(); };
    const stopFill = (e) => { if (e) e.stopPropagation(); state.fill = null; renderMain(); };

    const nameCell = (en) => [
      h('a', { class: 'pname', href: '#', title: 'Show details', onclick: (e) => { e.preventDefault(); openDetail(en.id); } }, showName(en)),
      noteMark(en.id),
      en.back ? h('span', { class: 'inf', title: 'Did this role here last season' }, '↺') : null,
      en.untrained ? h('span', { class: 'bd', title: 'Required training not complete' }, '⚠') : null,
      en.age ? h('span', { class: en.age.issue === 'under' ? 'agemark bd' : 'agemark lo',
        title: 'Age ' + en.age.age + '. FIRST recommends ' + ageText(en.age.rule) + ' for this role'
          + (en.age.issue === 'under' ? '. Exceptions need approval from your Program Delivery Partner.' : '') }, String(en.age.age)) : null,
    ];
    // The status, any unusual time, and the remove or undo button for one person on one day. The button is last.
    const cellBits = (en, i) => {
      const c = en.cells[i], col = cols[i];
      if (c.staged) {
        return [h('span', { class: 'inf', title: 'Staged, not saved yet' }, '+'),
          h('button', { class: 'xbtn', title: 'Undo', disabled: busy, onclick: () => {
            state.staged.splice(state.staged.indexOf(c.staged), 1); state.staffConfirm = false; renderMain();
          } }, '×')];
      }
      const odd = c.time && c.time !== col.common ? c.time : '';
      const tip = !c.time ? 'No shift set' : c.time + (c.count > 1 ? ' (' + c.count + ' shifts)' : '') + (c.notified ? ', notified' : ', not notified yet');
      return [
        c.gone ? h('span', { class: 'sub', title: 'Staged for removal' }, 'removing')
          : h('span', { class: c.notified ? 'hi' : 'lo', title: tip }, c.notified ? '✓' : '•'),
        !c.gone && !c.time ? h('span', { class: 'sub lo' }, 'No shift set') : null,
        !c.gone && odd ? h('span', { class: 'sub' + (col.set ? ' lo' : ''), title: col.set ? 'Differs from the shift time set for this role. The Shift times tab can change it.' : '' }, odd) : null,
        h('button', {
          class: 'xbtn', disabled: busy, title: c.gone ? 'Keep in this role' : 'Remove from this role on ' + evShort(col.l.ev),
          onclick: () => {
            if (c.gone) state.staged.splice(state.staged.indexOf(c.gone), 1);
            else state.staged.push({ remove: true, evId: col.l.ev.id, role: cur, peopleId: c.v.PeopleID, name: fullName(c.v), notified: c.notified });
            state.staffConfirm = false; state.staffResult = null; renderMain();
          },
        }, c.gone ? 'undo' : '×'),
      ];
    };
    const headTip = (col) => evLabel(col.l.ev) + (col.f ? '. ' + (col.want ? 'New assignments get ' + vmsRange(col.want) : 'No shift time set: new assignments get 6am–10pm') : '');
    const dayHead = (col) => {
      if (!col.f) return [evShort(col.l.ev), h('small', {}, 'Not at this event')];
      const f = col.f;
      return [evShort(col.l.ev) + ' · ',
        h('span', { class: f.target > 0 ? (f.have < f.target ? 'lo' : 'hi') : '' }, f.have + ' of ' + (f.target == null ? '?' : f.target)),
        h('small', {}, col.set ? ['Shift ' + col.common, col.differ ? h('span', { class: 'lo' }, ' · ' + col.differ + (col.differ === 1 ? ' differs' : ' differ')) : null]
          : col.common === ALL_DAY ? chip('warn', '6am–10pm', 'Still the all-day default')
            : col.common ? 'Most have ' + col.common : 'no shift time set')];
    };
    const openChip = (col, label) => (fillDay === col.l.ev.id
      ? h('div', { class: 'slot pick' }, 'Filling', h('span', { class: 'sp' }), h('button', { class: 'xbtn', title: 'Stop filling', onclick: stopFill }, '×'))
      : h('button', { class: 'slot open', disabled: busy, title: 'Show the people who can fill ' + evShort(col.l.ev), onclick: () => startFill(col.l) }, label));

    // Each day column keeps its width; with many events the table scrolls sideways instead of squeezing out the names.
    const personTable = () => h('div', { class: 'hscroll' }, h('table', { class: 'rt', style: 'min-width:' + (220 + cols.length * 170) + 'px' },
      h('thead', {}, h('tr', {},
        h('th', {}, plural(list.length, 'person').replace('persons', 'people')),
        cols.map((col) => h('th', { class: 'd', title: headTip(col) }, dayHead(col))))),
      h('tbody', {},
        list.map((en) => h('tr', { class: en.cells.every((c) => !c || c.staged) ? 'stagedrow' : '' },
          h('td', {}, nameCell(en)),
          cols.map((col, i) => {
            if (!en.cells[i]) return h('td', { class: 'd muted' }, '—');
            const bits = cellBits(en, i);
            return h('td', { class: 'd' }, h('div', { class: 'cell' }, bits.slice(0, -1), h('span', { class: 'sp' }), bits[bits.length - 1]));
          }))),
        h('tr', { class: 'openrow' },
          h('td', { class: 'muted', style: 'text-align:right' }, 'Open slots'),
          cols.map((col) => h('td', { class: 'd' }, !col.f ? null
            : col.open > 0 ? openChip(col, col.open + ' open')
              : h('span', { class: 'muted' }, col.f.target == null ? '' : col.f.have > col.f.target ? (col.f.have - col.f.target) + ' over' : 'Full')))))));

    // One row per slot. Someone on every day gets one chip across all of them; the rest sit in their own day's column.
    const slotGrid = () => {
      const active = cols.map((col, i) => i).filter((i) => cols[i].f);
      const isWide = (en) => active.length > 1 && active.every((i) => en.cells[i]);
      const wide = list.filter(isWide);
      const singles = cols.map((col, i) => (col.f ? list.filter((en) => en.cells[i] && !isWide(en)) : []));
      const depth = cols.map((col, i) => (col.f ? singles[i].length + col.open : 0));
      const kids = [h('div', {}), cols.map((col) => h('div', { class: 'slothead', title: headTip(col) }, dayHead(col)))];
      wide.forEach((en, n) => {
        kids.push(h('div', { class: 'slotn' }, n + 1),
          h('div', { class: 'slot' + (active.every((i) => en.cells[i].staged) ? ' new' : ''), style: 'grid-column: ' + (active[0] + 2) + ' / ' + (active[active.length - 1] + 3) },
            nameCell(en), h('span', { class: 'sp' }),
            active.map((i) => h('span', { class: 'daymark' }, h('span', { class: 'sub' }, evShort(cols[i].l.ev)), cellBits(en, i)))));
      });
      for (let r = 0; r < Math.max(0, ...depth); r++) {
        kids.push(h('div', { class: 'slotn' }, wide.length + r + 1));
        cols.forEach((col, i) => {
          const en = singles[i][r];
          if (en) kids.push(h('div', { class: 'slot' + (en.cells[i].staged ? ' new' : '') }, nameCell(en), h('span', { class: 'sp' }), cellBits(en, i)));
          else if (col.f && r < depth[i]) kids.push(r === singles[i].length ? openChip(col, 'Open') : h('button', { class: 'slot open', disabled: busy, onclick: () => startFill(col.l) }, 'Open'));
          else kids.push(h('div', {}));
        });
      }
      return h('div', { class: 'hscroll' }, h('div', { class: 'slots', style: 'grid-template-columns: 26px repeat(' + cols.length + ', minmax(160px, 1fr))' }, kids));
    };

    const setMode = (m) => { state.staffMode = m; renderMain(); };
    const ageLine = () => {
      const per = withRole.map((l) => ({ l, rule: ageRule(cur, l.ev) }));
      const known = per.filter((x) => x.rule);
      if (!known.length) {
        return h('div', { class: 'sub', style: 'margin:-2px 0 8px' }, 'FIRST gives no minimum age for this role'
          + (withRole.some((l) => roleIn(l, cur).custom) ? ' (custom role).' : '.'));
      }
      // One line per program, so two days of the same event read as one.
      const lines = new Map();
      known.forEach(({ l, rule }) => {
        const k = rule.prog + '|' + ageText(rule);
        if (!lines.has(k)) lines.set(k, { rule, days: [] });
        lines.get(k).days.push(evShort(l.ev));
      });
      const r0 = known[0].rule;
      return h('div', { class: 'sub', style: 'margin:-2px 0 8px' },
        'Minimum age ',
        [...lines.values()].map(({ rule, days }, i) => [i ? '; ' : '', h('strong', {}, ageText(rule)),
          lines.size > 1 || rule.other ? ' (' + (lines.size > 1 ? days.join(', ') + ', ' : '') + (PROGRAM_NAME[rule.prog] || 'this program') + ')' : '',
          rule.other ? ' — FIRST lists this role for ' + rule.where.replace(/ only$/, '') + ' only' : '']),
        ' · ',
        h('a', { href: r0.url, target: '_blank', rel: 'noopener', title: 'FIRST role description: ' + r0.title }, 'FIRST role page'));
    };
    const roleCard = h('div', { class: 'card' },
      h('div', { class: 'bar' },
        h('h2', { class: 'grow', style: 'margin:0' }, cur),
        h('button', { class: 'seg' + (state.staffMode === 'person' ? ' on' : ''), onclick: () => setMode('person') }, 'By person'),
        h('button', { class: 'seg' + (state.staffMode === 'slot' ? ' on' : ''), onclick: () => setMode('slot') }, 'By slot')),
      ageLine(),
      state.staffMode === 'slot' ? slotGrid() : personTable(),
      h('div', { class: 'sub', style: 'margin-top:8px' },
        h('span', { class: 'hi' }, '✓'), ' notified · ', h('span', { class: 'lo' }, '•'), ' not notified · ', h('span', { class: 'inf' }, '↺'), ' did this role last season · ',
        h('span', { class: 'bd' }, '⚠'), ' training incomplete · ', h('span', { class: 'agemark bd' }, '16'), ' under minimum age · ',
        h('span', { class: 'agemark lo' }, '17'), ' under preferred age · ', h('span', { class: 'inf' }, '+'), ' staged · × remove'));

    const q = state.poolSearch.toLowerCase();
    const buildPool = (withAssigned) => state.people.map((p) => {
      const opts = withRole.map((l) => {
        if (!p.ev[l.ev.id]) return null;
        const real = realAssign(p, l.ev.id);
        if (real.some((a) => a.role === cur)) return null;
        // Roles the person is staged to leave no longer count against them.
        const mine = real.filter((a) => !removalOf(l.ev.id, a.role, p.id));
        if (mine.length && !withAssigned) return null;
        return {
          elsewhere: mine.map((a) => a.role),
          moving: real.filter((a) => removalOf(l.ev.id, a.role, p.id)).map((a) => a.role),
          lastSeason: p.ev[l.ev.id].lastSeason || '',
        };
      });
      if (!opts.some(Boolean)) return null;
      if (q && !(p.first + ' ' + p.last).toLowerCase().includes(q)) return null;
      const applied = withRole.flatMap((l) => (p.ev[l.ev.id] ? p.ev[l.ev.id].applied : []));
      const here = applied.filter((a) => a.role === cur).map((a) => Number(a.pref) || 99);
      const others = [...new Set(applied.map((a) => a.role).filter((r) => r !== cur))];
      let rank = 2, why = others.length ? 'Applied for ' + others.join(', ') : 'No application for this role';
      if (applied.some((a) => a.role === cur && a.otherDay)) { rank = 0; why = 'In this role on another day'; }
      else if (here.length) { rank = 0; const best = Math.min(...here); why = 'Applied for this role' + (best < 99 ? ', choice ' + best : ''); }
      else if (others.some((r) => /assign me as needed/i.test(r))) { rank = 1; why = 'Assign as needed'; }
      const kind = rank === 0 ? 'here' : rank === 1 ? 'needed' : 'other';
      if (opts.every((o) => !o || o.elsewhere.length)) rank = 3;
      const whens = withRole.map((l, i) => (opts[i] && p.ev[l.ev.id] ? p.ev[l.ev.id].appliedOn : null)).filter(Boolean);
      return { p, opts, rank, kind, why, best: here.length ? Math.min(...here) : 99, when: whens.length ? Math.min(...whens) : null };
    }).filter(Boolean).sort((a, b) => a.rank - b.rank || a.best - b.best
      || (a.when || Infinity) - (b.when || Infinity) || a.p.last.localeCompare(b.p.last));
    const poolAll = buildPool(state.showAssigned);
    // By default only people who applied for this role are listed; the other two groups are opt-in.
    const nNeeded = poolAll.filter((x) => x.kind === 'needed').length, nOther = poolAll.filter((x) => x.kind === 'other').length;
    const pool = poolAll.filter((x) => x.kind === 'here' || (x.kind === 'needed' && state.showNeeded) || (x.kind === 'other' && state.showOther));

    const isStaged = (p, l) => state.staged.some((x) => !x.remove && x.peopleId === p.id && x.evId === l.ev.id);
    const fillIdx = withRole.findIndex((l) => l.ev.id === fillDay);
    const poolTotal = pool.length;
    const forDay = (list) => (fillIdx < 0 ? list : list.filter(({ p, opts }) => !!opts[fillIdx] && !isStaged(p, withRole[fillIdx])));
    let shownPool = forDay(pool);
    // A search that finds nobody in the list looks past the checkboxes, so a filter never hides a name you typed.
    let widened = false;
    if (q && !shownPool.length) {
      const wide = forDay(buildPool(true));
      if (wide.length) { shownPool = wide; widened = true; }
    }
    const stage = (p, items) => {
      items.forEach((l) => state.staged.push({ evId: l.ev.id, role: cur, peopleId: p.id, name: p.first + ' ' + p.last }));
      state.staffConfirm = false; state.staffResult = null; renderMain();
    };
    const curCustom = withRole.some((l) => roleIn(l, cur).custom);
    const poolRows = shownPool.map(({ p, opts, kind, why, when }) => {
      const can = (i) => !!opts[i] && p.cleared && !isStaged(p, withRole[i]) && !busy;
      const all = withRole.map((l, i) => i).filter((i) => !!opts[i]);
      return h('div', { class: 'prow' },
        h('div', {},
          nameLink(p, staffName(p.id, p.first + ' ' + p.last)), noteMark(p.id),
          (() => {
            // With many events, count the days instead of listing them all; the full list is in the tooltip.
            const days = withRole.filter((l, i) => !!opts[i]).map((l) => evShort(l.ev));
            const list = days.length > 2 && days.length === withRole.length ? 'every day'
              : days.length > 3 ? days.length + ' of ' + withRole.length + ' days'
                : days.length > 2 ? days.slice(0, -1).join(', ') + ' and ' + days[days.length - 1] : days.join(' and ');
            return h('div', { class: 'sub', title: days.length > 2 ? days.join(', ') : '' }, why + ' · signed up for ' + list + (when ? ' · applied ' + fmtDay(when) : ''));
          })()),
        h('div', { class: 'pflags' },
          (() => {
            const rule = strictestRule(cur, withRole.filter((l, i) => !!opts[i]));
            const issue = ageIssue(p, rule);
            if (issue === 'under') return chip('bad', 'Age ' + p.age + ': under ' + rule.min, 'FIRST recommends ' + ageText(rule) + ' for this role. Exceptions need approval from your Program Delivery Partner.');
            if (issue === 'pref') return chip('warn', 'Age ' + p.age + ': ' + rule.pref + '+ preferred', 'FIRST recommends ' + ageText(rule) + ' for this role.');
            return p.flags.includes('minor') ? chip('info', 'Minor', 'Age ' + p.age) : null;
          })(),
          !p.cleared ? chip('bad', 'Needs clearance', p.clearance) : null,
          (() => {
            const seasons = opts.map((o) => (o ? o.lastSeason : '')).filter(Boolean);
            if (!seasons.length) return null;
            return seasons.some((t) => t.toLowerCase().includes(cur.toLowerCase()))
              ? chip('ok', 'Did this role last season', seasons.join(' / '))
              : chip('info', 'Last season: ' + (seasons[0].length > 34 ? seasons[0].slice(0, 32) + '…' : seasons[0]), seasons.join(' / '));
          })(),
          opts.map((o, i) => (o && o.moving.length ? chip('info', evShort(withRole[i].ev) + ': moving from ' + o.moving.join(', ')) : null)),
          opts.map((o, i) => (o && o.elsewhere.length ? chip('warn', evShort(withRole[i].ev) + ': already ' + o.elsewhere.join(', ')) : null))),
        h('div', { class: 'pacts' },
          !p.cleared ? h('span', { class: 'sub' }, 'Cannot be assigned yet') : [
            fillIdx >= 0
              ? h('button', { class: 'primary', disabled: !can(fillIdx), onclick: () => stage(p, [withRole[fillIdx]]) }, 'Assign ' + evShort(withRole[fillIdx].ev))
              : withRole.map((l, i) => h('button', { disabled: !can(i), onclick: () => stage(p, [l]) }, evShort(l.ev))),
            withRole.length > 1 ? h('button', { disabled: all.length < 2 || !all.every(can), onclick: () => stage(p, all.map((i) => withRole[i])) }, all.length > 2 ? 'All' : 'Both') : null,
          ],
          // Hiding is for people who are not placed anywhere: it takes them out of the applicant lists.
          opts.some((o) => o && o.elsewhere.length) || state.staged.some((x) => x.peopleId === p.id) ? null : h('div', {},
            state.hideAsk !== p.id
              ? h('button', { class: 'lnk', style: 'margin-right:0', title: 'Take this person out of the applicant list. They are not told.', onclick: () => { state.hideAsk = p.id; renderMain(); } }, 'Hide')
              : [kind === 'here' && !curCustom ? h('button', { class: 'lnk', disabled: state.hiding, onclick: () => hidePerson(p, cur, 'role') }, 'Hide from this role') : null,
                h('button', { class: 'lnk', disabled: state.hiding, onclick: () => hidePerson(p, cur, 'all') }, 'Hide from all roles'),
                h('button', { class: 'lnk', style: 'margin-right:0', disabled: state.hiding, onclick: () => { state.hideAsk = null; renderMain(); } }, 'Cancel')])));
    });

    // People hidden from this role, or from every role, on the loaded events.
    const hiddenMap = new Map();
    [...new Set(withRole.map((l) => l.src))].forEach((raw) => {
      const role = raw.roles.find((r) => r.name.toLowerCase() === cur.toLowerCase() && !r.admin);
      const add = (row, scope) => {
        if (!hiddenMap.has(row.PeopleID)) hiddenMap.set(row.PeopleID, { row, records: [] });
        hiddenMap.get(row.PeopleID).records.push({ raw, row, scope });
      };
      (role && role.hidden ? role.hidden : []).forEach((row) => add(row, 'role'));
      (raw.eventHidden || []).forEach((row) => add(row, 'all'));
    });
    const hiddenList = [...hiddenMap.values()].sort((a, b) => (a.row.LastName || '').localeCompare(b.row.LastName || ''));
    const hiddenBox = hiddenList.length ? h('details', { style: 'margin:10px 0 0' },
      h('summary', {}, 'Hidden (' + hiddenList.length + ')'),
      hiddenList.map(({ row, records }) => h('div', { class: 'prow', style: 'grid-template-columns: minmax(0, 1fr) auto' },
        h('div', {},
          h('strong', {}, staffName(row.PeopleID, fullName(row))),
          h('div', { class: 'sub' }, records.map((x) => (x.scope === 'all' ? 'From all roles' : 'From this role') + ' on ' + evShort(x.raw.ev)).join(' · '))),
        h('div', {}, h('button', { disabled: state.hiding, onclick: () => unhidePerson(records, cur) }, 'Unhide'))))) : null;

    const n = state.staged.length;
    const adds = state.staged.filter((x) => !x.remove).length;
    const told = state.staged.filter((x) => x.remove && x.notified).length;
    const summary = [adds ? plural(adds, 'assignment') : '', n - adds ? plural(n - adds, 'removal') : ''].filter(Boolean).join(' and ');
    const footer = h('div', { class: 'card bar', style: 'margin-bottom:0' },
      h('span', { class: 'muted grow' }, n ? 'Staged: ' + summary + ', kept in this browser until you apply or discard' : 'Nothing staged'),
      state.staffConfirm
        ? [h('strong', {}, 'Apply ' + summary + ' to VMS? No email is sent.'
            + (told ? ' VMS will not tell the ' + (told === 1 ? 'one person' : told + ' people') + ' already notified that they were removed.' : '')),
          h('button', { class: 'primary', disabled: busy, onclick: applyStaged }, busy ? 'Applying…' : 'Yes, apply'),
          h('button', { disabled: busy, onclick: () => { state.staffConfirm = false; renderMain(); } }, 'Cancel')]
        : [h('button', { disabled: !n, onclick: () => { state.staged = []; state.restoreNote = ''; render(); } }, 'Discard'),
          h('button', { class: 'primary', disabled: !n, onclick: () => { state.staffConfirm = true; renderMain(); } }, 'Apply ' + n + ' to VMS…')]);

    return h('div', { class: 'board' },
      roleList,
      h('div', {},
        state.restoreNote ? h('div', { class: 'msg' }, state.restoreNote) : null,
        resultBox(state.staffResult, (ok) => plural(ok, 'change') + ' made in VMS.', 'New assignments are not notified yet; use the Notify tab when ready.'),
        roleCard,
        h('div', { class: 'card' },
          h('div', { class: 'bar' },
            h('strong', {}, 'Available people'),
            fillIdx >= 0 ? h('span', { class: 'filltag' }, 'For ' + evShort(withRole[fillIdx].ev) + ' only',
              h('button', { class: 'xbtn', title: 'Show everyone again', onclick: stopFill }, '×')) : null,
            h('input', { type: 'search', placeholder: 'Search name', value: state.poolSearch,
              oninput: (e) => { state.poolSearch = e.target.value; refreshPeople(); } }),
            h('label', { title: 'People who ticked "Assign me as needed" but did not apply for this role' },
              h('input', { type: 'checkbox', checked: state.showNeeded,
                onchange: (e) => { state.showNeeded = e.target.checked; renderMain(); } }), ' Include assign as needed (' + nNeeded + ')'),
            h('label', { title: 'People who applied only for other roles' },
              h('input', { type: 'checkbox', checked: state.showOther,
                onchange: (e) => { state.showOther = e.target.checked; renderMain(); } }), ' Include other applicants (' + nOther + ')'),
            h('label', {}, h('input', { type: 'checkbox', checked: state.showAssigned,
              onchange: (e) => { state.showAssigned = e.target.checked; renderMain(); } }), ' Include people already assigned another role'),
            h('label', { title: 'For screenshots. Applies to the Staffing tab only; the details panel still shows everything.' },
              h('input', { type: 'checkbox', checked: state.hideLast,
                onchange: (e) => { state.hideLast = e.target.checked; renderMain(); } }), ' Hide last names'),
            h('span', { class: 'muted grow', style: 'text-align:right' }, fillIdx >= 0 ? shownPool.length + ' of ' + plural(poolTotal, 'person').replace('persons', 'people')
              : plural(poolTotal, 'person').replace('persons', 'people'))),
          widened ? h('div', { class: 'msg' }, 'Nobody in the current list matches "' + state.poolSearch + '". Showing '
            + plural(shownPool.length, 'other person').replace('persons', 'people') + ' the boxes above would normally hide.') : null,
          poolRows.length ? poolRows : h('div', { class: 'sub' }, q ? 'Nobody matches "' + state.poolSearch + '"' + (fillIdx >= 0 ? ' for this day.' : '.')
            : fillIdx >= 0 ? 'Nobody listed signed up for this day.'
            : nNeeded + nOther ? 'Nobody else applied for this role. Tick a box above to see other people.' : 'Nobody left to assign for this role.'),
          hiddenBox),
        footer));
  }

  async function applyStaged() {
    state.staffApplying = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    const placedNow = new Set();
    // Removals go first so that someone being moved is free before they are placed again.
    const ordered = [...state.staged.filter((x) => x.remove), ...state.staged.filter((x) => !x.remove)];
    for (const x of ordered) {
      const item = state.loaded.find((l) => l.ev.id === x.evId);
      const role = roleIn(item, x.role);
      if (x.remove) {
        // Someone removed goes back into the applicant lists of every role they applied for, which is not known here.
        mark(touched, x.evId, null);
      } else {
        mark(touched, x.evId, x.role);
        const person = state.people.find((y) => y.id === x.peopleId);
        (person && person.ev[x.evId] ? person.ev[x.evId].applied : []).forEach((a) => mark(touched, x.evId, a.role));
      }
      const vmsId = item.ev.vmsId;
      try {
        if (x.remove) {
          const row = role.assigned.find((v) => v.PeopleID === x.peopleId);
          if (!row) throw new Error('no longer in this role');
          if (item.ev.multi) {
            const live = await liveRow(item, role, x.peopleId);
            if (!live) throw new Error('no longer in this role');
            const shifts = live.Assignments || [];
            const a = shifts.find((sh) => covers(sh, item.ev.pos));
            if (!shifts.length || (a && shifts.length === 1 && (a.PositionsSpanned || 1) === 1)) {
              // Nothing left on any other day: take them out of the role.
              await svcPost('Remove', { eventID: vmsId, idList: String(live.ID) });
            } else if (a) {
              // Still working other days: take away only this day.
              await carveDay(item, live.ID, a, item.ev.pos, null);
            }
          } else {
            await svcPost('Remove', { eventID: vmsId, idList: String(row.ID) });
          }
          ok += 1;
          continue;
        }
        // On a multi-day event the person may already be in the role for another day.
        const srcRole = item.src.roles.find((r) => r.id === role.id && r.custom === role.custom);
        // Staging several days at once places them on the first day and only adds a shift on the others: VMS refuses to
        // place someone twice ("is already placed for this role"), and the loaded lists aren't re-read mid-batch.
        const placedKey = vmsId + ':' + role.id + ':' + (role.custom ? 1 : 0) + ':' + x.peopleId;
        const already = placedNow.has(placedKey)
          || (item.ev.multi && srcRole && (Array.isArray(srcRole.assigned) ? srcRole.assigned : []).some((v) => v.PeopleID === x.peopleId));
        if (!already) {
          try {
            await svcPost('PlaceCandidates', { eventID: vmsId, roleID: role.id, isCustom: role.custom, people: String(x.peopleId) });
          } catch (e) {
            if (!(item.ev.multi && /already placed/i.test(e.message))) throw e;
          }
        }
        placedNow.add(placedKey);
        const day = vmsDate(item.ev.date);
        if (item.ev.days === 1 && day) {
          const rows = await svc('GetAssignedVolunteers', { eventID: vmsId, roleID: role.id, isCustom: role.custom, viewType: 'Event', day: 0 });
          const row = rows.find((v) => v.PeopleID === x.peopleId);
          if (!row) throw new Error('placed, but not found on the schedule');
          const has = item.ev.multi ? (row.Assignments || []).some((a) => covers(a, item.ev.pos)) : (row.Assignments || []).length > 0;
          if (!has) {
            const want = effectiveTime(x.evId, x.role);
            await svcPost('SaveAssignment', {
              eventID: vmsId, peopleRoleID: String(row.ID), assignmentID: '0', assignmentType: 'Tentative',
              startDate: day, endDate: day, startTime: want ? want.start : '', endTime: want ? want.end : '',
              duplicateVolunteerIDs: [],
            });
          }
        }
        ok += 1;
      } catch (e) {
        failed.push(staffName(x.peopleId, x.name) + (x.remove ? ' from ' : ' as ') + x.role + ' (' + e.message + ')');
      }
    }
    await reloadEvents(touched);
    state.staged = []; state.staffApplying = false; state.staffConfirm = false;
    state.staffResult = { ok, failed };
    render();
  }

  // ----- Notify tab -----

  // Everyone with a shift that VMS has not emailed them about yet.
  function pendingNotifications() {
    const out = [];
    state.loaded.forEach(({ ev, roles }) => roles.forEach((role) => {
      if (role.admin) return;
      (Array.isArray(role.assigned) ? role.assigned : []).forEach((v) => {
        const shifts = v.Assignments || [];
        if (!shifts.length || shifts.every((a) => a.IsNotified)) return;
        const key = ev.vmsId + ':' + role.id + ':' + v.ID;
        const time = (ev.multi ? evShort(ev) + ' ' : '') + shifts.map((a) => a.ScheduleDisplayTime).join(', ');
        const prior = out.find((x) => x.key === key);
        if (prior) { prior.time += '; ' + time; return; }
        out.push({ key, ev, role, rowId: v.ID, peopleId: v.PeopleID, name: fullName(v), time });
      });
    }));
    return out;
  }

  function notifyView() {
    const nt = state.notify;
    const pending = pendingNotifications();
    const live = new Set(pending.map((x) => x.key));
    [...nt.picks.keys()].forEach((k) => { if (!live.has(k)) nt.picks.delete(k); });
    pending.forEach((x) => { if (!nt.picks.has(x.key)) nt.picks.set(x.key, true); });
    const picked = pending.filter((x) => nt.picks.get(x.key));
    const perPerson = new Map();
    picked.forEach((x) => perPerson.set(x.peopleId, (perPerson.get(x.peopleId) || 0) + 1));
    const multi = [...perPerson.values()].filter((c) => c > 1).length;
    const summary = plural(picked.length, 'email') + ' to ' + plural(perPerson.size, 'person').replace('persons', 'people')
      + (multi ? ' · ' + multi + ' will get more than one (VMS sends one per event and role)' : '');
    const repick = () => { nt.confirming = false; renderMain(); };

    return h('div', {},
      h('div', { class: 'msg' }, 'Sends the standard VMS assignment email to everyone ticked below, one email per person per event and role. '
        + 'The same subject and message go to all of them. VMS sends from a no-reply address, so put your contact details in the message.'),
      resultBox(nt.result, (ok) => plural(ok, 'email') + ' sent by VMS.', ''),
      nt.error ? h('div', { class: 'msg err' }, nt.error) : null,
      !pending.length ? h('div', { class: 'msg' }, 'Everyone with a shift has been notified.') : [
        h('label', { class: 'field' }, h('span', {}, 'Subject'),
          h('input', { type: 'text', value: nt.subject, disabled: nt.sending, oninput: (e) => { nt.subject = e.target.value; nt.error = ''; saveDrafts(); } })),
        h('label', { class: 'field' }, h('span', {}, 'Message'),
          h('textarea', { rows: 5, value: nt.message, disabled: nt.sending, oninput: (e) => { nt.message = e.target.value; saveDrafts(); } })),
        h('label', { class: 'field' }, h('input', { type: 'checkbox', checked: nt.bcc, disabled: nt.sending,
          onchange: (e) => { nt.bcc = e.target.checked; repick(); } }),
          ' BCC me on every email' + (nt.bcc ? ' (' + plural(picked.length, 'copy').replace('copys', 'copies') + ' to your inbox)' : '')),
        h('label', { class: 'field', title: 'The same option as in VMS\'s own Notify form' },
          h('input', { type: 'checkbox', checked: nt.other, disabled: nt.sending, onchange: (e) => {
            nt.other = e.target.checked;
            nt.error = '';
            if (nt.other && !nt.otherEmail && vmsExtraEmail) nt.otherEmail = vmsExtraEmail;
            // VMS fills this box with the extra email on your VMS profile; read it from a role page the first time.
            if (nt.other && !nt.otherEmail && picked.length) {
              loadExtraEmail(picked[0]).then(() => { if (nt.other && !nt.otherEmail && vmsExtraEmail) { nt.otherEmail = vmsExtraEmail; renderMain(); } });
            }
            repick();
          } }),
          ' Include this email address in the message: ',
          h('input', { type: 'email', class: 'otheremail', value: nt.otherEmail, disabled: nt.sending, placeholder: 'name@example.org',
            oninput: (e) => { nt.otherEmail = e.target.value; nt.error = ''; if (e.target.value.trim() && !nt.other) { nt.other = true; e.target.previousSibling.previousSibling.checked = true; } } })),
        h('div', { class: 'bar' },
          h('span', { class: 'muted grow' }, summary),
          nt.confirming
            ? [h('strong', {}, 'Send ' + plural(picked.length, 'email') + (nt.other ? ' that include ' + nt.otherEmail.trim() : '') + ' now? This cannot be undone.'),
              h('button', { class: 'primary', disabled: nt.sending, onclick: () => sendNotifications(picked) }, nt.sending ? 'Sending…' : 'Yes, send'),
              h('button', { disabled: nt.sending, onclick: repick }, 'Cancel')]
            : h('button', { class: 'primary', disabled: !picked.length, onclick: () => {
                if (!nt.subject.trim()) { nt.error = 'Enter a subject first.'; renderMain(); return; }
              if (nt.other && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(nt.otherEmail.trim())) { nt.error = 'Enter one email address to include, or untick that box.'; renderMain(); return; }
                nt.confirming = true; renderMain();
              } }, 'Send ' + plural(picked.length, 'email') + '…')),
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, h('input', { type: 'checkbox', checked: picked.length === pending.length, disabled: nt.sending, title: 'Select all',
              onchange: (e) => { pending.forEach((x) => nt.picks.set(x.key, e.target.checked)); repick(); } })),
            ['Volunteer', 'Event', 'Role', 'Shift'].map((t) => h('th', {}, t)))),
          h('tbody', {}, pending.map((x) => h('tr', {},
            h('td', {}, h('input', { type: 'checkbox', checked: nt.picks.get(x.key), disabled: nt.sending,
              onchange: (e) => { nt.picks.set(x.key, e.target.checked); repick(); } })),
            h('td', {}, x.name), h('td', {}, x.ev.multi ? x.ev.name : evLabel(x.ev)), h('td', {}, x.role.name), h('td', {}, x.time))))),
      ]);
  }

  async function sendNotifications(picked) {
    const nt = state.notify;
    nt.sending = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    // One call per person: the only form of this call that has been verified against VMS.
    for (const x of picked) {
      mark(touched, x.ev.id, x.role.name);
      try {
        await svcPost('NotifyVolunteers', {
          eventID: x.ev.vmsId, idList: String(x.rowId), subject: nt.subject.trim(), ccMe: nt.bcc, ccVC: false,
          customMessage: nt.message, emailEA: '', emailEEA: nt.other ? nt.otherEmail.trim() : '', roleID: x.role.id,
        });
        ok += 1;
      } catch (e) {
        failed.push(x.name + ' as ' + x.role.name + ' (' + e.message + ')');
      }
    }
    await reloadEvents(touched);
    nt.sending = false; nt.confirming = false; nt.picks.clear();
    nt.result = { ok, failed };
    render();
  }

  // ----- Message tab -----

  // People VMS will email for an event, set of roles and audience, as far as the loaded data shows.
  function messageAudience() {
    const m = state.msg;
    const evIds = m.evs || new Set(state.loaded.map((l) => l.ev.id));
    const ids = new Set();
    const perEvent = [];
    state.loaded.forEach((l) => {
      if (!evIds.has(l.ev.id)) return;
      const roles = l.roles.filter((r) => !r.admin && (m.allRoles || m.roles.has(r.name)));
      if (!roles.length) return;
      roles.forEach((r) => {
        const told = (v) => (v.Assignments || []).some((a) => a.IsNotified);
        const add = (list) => list.forEach((v) => ids.add(v.PeopleID));
        const assigned = Array.isArray(r.assigned) ? r.assigned : [], applicants = Array.isArray(r.applicants) ? r.applicants : [];
        if (m.aud === '0' || m.aud === '3') add(assigned.filter(told));
        if (m.aud === '1' || m.aud === '3') add(assigned.filter((v) => !told(v)));
        if (m.aud === '2' || m.aud === '3') add(applicants);
      });
      if (!perEvent.some((x) => x.ev.vmsId === l.ev.vmsId)) perEvent.push({ ev: l.ev, roles });
    });
    return { count: ids.size, perEvent };
  }

  function messageView() {
    const m = state.msg;
    const loaded = state.loaded;
    const evIds = m.evs || new Set(loaded.map((l) => l.ev.id));
    const roleNames = [...new Set(loaded.flatMap((l) => l.roles.filter((r) => !r.admin).map((r) => r.name)))].sort();
    const aud = messageAudience();
    const reset = () => { m.confirming = false; m.result = null; renderMain(); };
    const AUDIENCES = [['0', 'Assigned and notified'], ['1', 'Tentatively scheduled (not notified yet)'], ['2', 'Applicants not assigned'], ['3', 'Everyone']];

    return h('div', {},
      h('div', { class: 'msg' }, 'Sends a VMS message to everyone in the chosen roles with the chosen status. VMS sends it from a no-reply address, '
        + 'so include your name and contact details. To write from your own email instead, use "Copy emails for BCC" on the People tab.'),
      resultBox(m.result, (ok) => 'Message sent for ' + plural(ok, 'event') + '.', ''),
      m.error ? h('div', { class: 'msg err' }, m.error) : null,
      h('div', { class: 'field' }, h('span', {}, 'Events'),
        loaded.map((l) => h('label', { style: 'margin-right:16px' }, h('input', { type: 'checkbox', checked: evIds.has(l.ev.id), disabled: m.sending,
          onchange: (e) => { const next = new Set(evIds); e.target.checked ? next.add(l.ev.id) : next.delete(l.ev.id); m.evs = next; reset(); } }), ' ' + evLabel(l.ev)))),
      h('label', { class: 'field' }, h('span', {}, 'Send to'),
        h('select', { disabled: m.sending, onchange: (e) => { m.aud = e.target.value; reset(); } },
          AUDIENCES.map(([v, label]) => h('option', { value: v, selected: m.aud === v }, label)))),
      h('div', { class: 'field' }, h('span', {}, 'Roles'),
        h('label', {}, h('input', { type: 'checkbox', checked: m.allRoles, disabled: m.sending,
          onchange: (e) => { m.allRoles = e.target.checked; reset(); } }), ' All roles'),
        m.allRoles ? null : h('div', { class: 'checks' }, roleNames.map((name) => h('label', {}, h('input', { type: 'checkbox', checked: m.roles.has(name), disabled: m.sending,
          onchange: (e) => { e.target.checked ? m.roles.add(name) : m.roles.delete(name); reset(); } }), ' ' + name)))),
      h('label', { class: 'field' }, h('span', {}, 'Subject'),
        h('input', { type: 'text', value: m.subject, disabled: m.sending, oninput: (e) => { m.subject = e.target.value; m.error = ''; } })),
      h('label', { class: 'field' }, h('span', {}, 'Message'),
        h('textarea', { rows: 6, value: m.message, disabled: m.sending, oninput: (e) => { m.message = e.target.value; m.error = ''; } })),
      h('label', { class: 'field' }, h('input', { type: 'checkbox', checked: m.bcc, disabled: m.sending,
        onchange: (e) => { m.bcc = e.target.checked; reset(); } }), ' BCC me (one copy per event)'),
      h('div', { class: 'bar' },
        h('span', { class: 'muted grow' }, aud.count
          ? 'About ' + plural(aud.count, 'person').replace('persons', 'people') + ' across ' + plural(aud.perEvent.length, 'event') + '. VMS decides the exact list when it sends.'
          : 'Nobody matches this choice.'),
        m.confirming
          ? [h('strong', {}, 'Email about ' + plural(aud.count, 'person').replace('persons', 'people') + ' now? This cannot be undone.'),
            h('button', { class: 'primary', disabled: m.sending, onclick: () => sendMessage(aud) }, m.sending ? 'Sending…' : 'Yes, send'),
            h('button', { disabled: m.sending, onclick: () => { m.confirming = false; renderMain(); } }, 'Cancel')]
          : h('button', { class: 'primary', disabled: !aud.count, onclick: () => {
              if (!m.subject.trim() || !m.message.trim()) { m.error = 'Enter a subject and a message first.'; renderMain(); return; }
              m.confirming = true; renderMain();
            } }, 'Send message…')));
  }

  async function sendMessage(aud) {
    const m = state.msg;
    m.sending = true; renderMain();
    const failed = [];
    let ok = 0;
    for (const { ev, roles } of aud.perEvent) {
      try {
        await postJson('/VMS/Services/EventsService.asmx/SendMessage', {
          eventID: ev.vmsId, roleIDList: roles.map((r) => r.id + '|' + r.custom).join(','), subject: m.subject.trim(),
          ccMe: m.bcc, ccVC: false, customMessage: m.message, sendMessageTo: m.aud,
        });
        ok += 1;
      } catch (e) {
        failed.push(evShort(ev) + ' (' + e.message + ')');
      }
    }
    m.sending = false; m.confirming = false;
    m.result = { ok, failed };
    renderMain();
  }

  // ----- Shift times tab -----

  // Chrome reports a time box as changed as soon as its time is complete, while the cursor is still in it. Redrawing the
  // tab then would throw the cursor out of the form, so the value is saved at once and the tab is redrawn after the
  // cursor leaves the box, with focus kept on wherever it went.
  function redrawTimesLater() {
    setTimeout(() => {
      if (!timesDirty) return;
      const now = shadow.activeElement;
      // Focus moved to a button or other control: let its click happen first, then redraw.
      if (now && mainEl.contains(now) && !(now.dataset && now.dataset.fk)) {
        const after = () => { now.removeEventListener('click', after); setTimeout(() => { if (timesDirty) renderMain(); }, 0); };
        now.addEventListener('click', after);
        now.addEventListener('blur', after, { once: true });
        return;
      }
      renderMain();
    }, 0);
  }
  function timeInputs(target, key) {
    const mk = (field) => h('input', {
      type: 'time', min: MIN_TIME, max: MAX_TIME, value: target[field] || '', disabled: state.applying, 'data-fk': key + ':' + field,
      onchange: (e) => { target[field] = e.target.value; saveTimes(); state.confirming = false; state.applyResult = null; timesDirty = true; },
      onblur: () => { if (timesDirty) redrawTimesLater(); },
    });
    return [mk('start'), ' to ', mk('end')];
  }

  function timesView() {
    const changed = () => { saveTimes(); state.confirming = false; state.applyResult = null; renderMain(); };
    const sections = state.loaded.map(({ ev, roles }) => {
      const cfg = cfgFor(ev.id);
      if (ev.days > 1 || !vmsDate(ev.date)) {
        return h('section', {}, h('h2', {}, evLabel(ev)),
          h('div', { class: 'msg' }, 'Shift times are only supported for one-day events. Set this one in VMS.'));
      }
      const usable = roles.filter((r) => !r.admin && !r.inactive).sort((a, b) => a.name.localeCompare(b.name));
      const setCount = usable.filter((r) => validTime(cfg.roles[r.name.toLowerCase()])).length;
      // On a multi-day event, the first day's times can be copied to every other day in one click.
      const sameEvent = state.loaded.filter((l) => l.ev.vmsId === ev.vmsId && l.ev.id !== ev.id);
      const isFirstDay = ev.multi && state.loaded.find((l) => l.ev.vmsId === ev.vmsId).ev.id === ev.id;
      const copyToOtherDays = () => {
        sameEvent.forEach((l) => {
          const to = cfgFor(l.ev.id);
          to.start = cfg.start; to.end = cfg.end;
          to.roles = JSON.parse(JSON.stringify(cfg.roles));
        });
        state.toast = 'Copied to ' + plural(sameEvent.length, 'other day') + '. Nothing changes in VMS until you apply.';
        changed();
        setTimeout(() => { state.toast = ''; render(); }, 2500);
      };
      const bad = (t) => !!t && (t.start || t.end) && !validTime(t);
      return h('section', {},
        h('h2', {}, evLabel(ev)),
        h('div', { class: 'bar' }, h('strong', {}, 'Default shift'), timeInputs(cfg, ev.id + '|*'),
          bad(cfg) ? chip('bad', 'Needs a start before the end, between 6am and 10pm') : null,
          !cfg.start && !cfg.end ? h('span', { class: 'muted' }, 'Not set. Roles without their own time are left alone.') : null,
          isFirstDay && sameEvent.length ? h('button', { title: 'Copy this day’s default and role times to the other days of this event', onclick: copyToOtherDays },
            'Use these times on all ' + (sameEvent.length + 1) + ' days') : null),
        h('details', { open: setCount > 0 },
          h('summary', {}, 'Role-specific times (' + setCount + ' set)'),
          h('table', { class: 'narrow' }, h('tbody', {}, usable.map((r) => {
            const k = r.name.toLowerCase();
            const own = (cfg.roles[k] = cfg.roles[k] || { start: '', end: '' });
            const eff = effectiveTime(ev.id, r.name);
            return h('tr', {},
              h('td', {}, r.name),
              h('td', {}, timeInputs(own, ev.id + '|' + k),
                own.start || own.end ? [' ', h('button', { onclick: () => { own.start = ''; own.end = ''; changed(); } }, 'Clear')] : null,
                bad(own) ? [' ', chip('bad', 'Invalid, ignored')] : null),
              h('td', { class: 'muted' }, eff ? (validTime(own) ? 'Uses ' : 'Default ') + vmsRange(eff) : 'No time set'));
          })))));
    });

    const changes = plannedChanges();
    const live = new Set(changes.map((c) => c.key));
    [...state.picks.keys()].forEach((k) => { if (!live.has(k)) state.picks.delete(k); });
    changes.forEach((c) => { if (!state.picks.has(c.key)) state.picks.set(c.key, !c.notified); });
    const picked = changes.filter((c) => state.picks.get(c.key));
    const pickedNotified = picked.filter((c) => c.notified).length;

    const result = state.applyResult;
    const preview = h('section', {},
      h('h2', {}, 'Shifts that differ from these times'),
      result ? h('div', { class: 'msg' + (result.failed.length ? ' err' : '') },
        result.ok + ' shift' + (result.ok === 1 ? '' : 's') + ' updated in VMS.'
        + (result.failed.length ? ' ' + result.failed.length + ' failed: ' + result.failed.join('; ') : '')
        + (result.ok ? ' Updated shifts are marked not notified; send notifications from VMS when ready.' : '')) : null,
      !changes.length ? h('div', { class: 'msg' }, 'Nothing to change. Every assigned shift already matches, or no times are set.') : [
        h('div', { class: 'bar' },
          h('span', { class: 'muted grow' }, picked.length + ' of ' + changes.length + ' selected'
            + (pickedNotified ? ' · ' + pickedNotified + ' already notified' : '')),
          state.confirming
            ? [h('strong', {}, 'Change ' + picked.length + ' shift' + (picked.length === 1 ? '' : 's') + ' in VMS?'
                + (pickedNotified ? ' ' + pickedNotified + ' will go back to not notified.' : '')),
              h('button', { class: 'primary', disabled: state.applying, onclick: () => applyChanges(picked) }, state.applying ? 'Applying…' : 'Yes, apply'),
              h('button', { disabled: state.applying, onclick: () => { state.confirming = false; renderMain(); } }, 'Cancel')]
            : h('button', { class: 'primary', disabled: !picked.length, onclick: () => { state.confirming = true; renderMain(); } },
                'Apply ' + picked.length + ' change' + (picked.length === 1 ? '' : 's') + '…')),
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, h('input', {
              type: 'checkbox', checked: picked.length === changes.length, disabled: state.applying, title: 'Select all',
              onchange: (e) => { changes.forEach((c) => state.picks.set(c.key, e.target.checked)); state.confirming = false; renderMain(); },
            })),
            ['Volunteer', 'Event', 'Role', 'Now', 'Change to', 'Status'].map((t) => h('th', {}, t)))),
          h('tbody', {}, changes.map((c) => h('tr', {},
            h('td', {}, h('input', {
              type: 'checkbox', checked: state.picks.get(c.key), disabled: state.applying,
              onchange: (e) => { state.picks.set(c.key, e.target.checked); state.confirming = false; renderMain(); },
            })),
            h('td', {}, c.name), h('td', {}, evLabel(c.ev)), h('td', {}, c.role),
            h('td', {}, c.from || 'No shift set'), h('td', {}, h('strong', {}, vmsRange(c.want))),
            h('td', {}, c.notified ? chip('warn', 'Notified: will need re-notifying') : chip('info', 'Not notified yet')))))),
      ]);

    return h('div', {},
      h('div', { class: 'msg' }, 'Set one shift time per event, and a different time for any role that needs it. '
        + 'Applying replaces the 6am–10pm default on assigned shifts. It never sends email: a shift that was already notified goes back to '
        + '"not notified", so those are left unticked until you choose them.'),
      sections, preview);
  }

  async function applyChanges(picked) {
    state.applying = true; renderMain();
    const failed = [];
    let ok = 0;
    const touched = new Map();
    for (const c of picked) {
      const day = vmsDate(c.ev.date);
      try {
        if (c.ev.multi) {
          const item = state.loaded.find((l) => l.ev.id === c.ev.id);
          const role = roleIn(item, c.role);
          const live = await liveRow(item, role, c.peopleId);
          if (!live) throw new Error('no longer in this role');
          const a = (live.Assignments || []).find((sh) => covers(sh, c.ev.pos));
          if (a) await carveDay(item, live.ID, a, c.ev.pos, c.want);
          else await saveShift(c.ev.vmsId, live.ID, 0, day, day, c.want);
        } else {
          await svcPost('SaveAssignment', {
            eventID: c.ev.vmsId, peopleRoleID: String(c.rowId), assignmentID: String(c.asgId),
            assignmentType: 'Tentative', startDate: day, endDate: day,
            startTime: c.want.start, endTime: c.want.end, duplicateVolunteerIDs: [],
          });
        }
        ok += 1;
      } catch (e) {
        failed.push(c.name.trim() + ' (' + e.message + ')');
      }
      mark(touched, c.ev.id, c.role);
    }
    // Re-read the roles that changed so the view shows what VMS now holds.
    await reloadEvents(touched);
    state.applying = false; state.confirming = false; state.picks.clear();
    state.applyResult = { ok, failed };
    render();
  }

  // Re-render the table without losing focus in the search box.
  function refreshPeople() {
    const old = mainEl.querySelector('input[type=search]');
    const pos = old ? old.selectionStart : null;
    renderMain();
    const box = mainEl.querySelector('input[type=search]');
    if (box && pos != null) { box.focus(); box.setSelectionRange(pos, pos); }
  }

  async function copyEmails(emails) {
    try {
      await navigator.clipboard.writeText(emails.join('; '));
      toast('Copied ' + emails.length + (emails.length === 1 ? ' email' : ' emails') + '. Paste into BCC.');
    } catch (e) {
      toast('Could not copy: ' + e.message);
    }
  }
  function toast(message) {
    state.toast = message; render();
    setTimeout(() => { state.toast = ''; render(); }, 2500);
  }
})();
