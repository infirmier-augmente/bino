// Bino — le binôme des infirmiers. Démo hackathon IA santé (Hôpital Foch), données fictives.
// Parcours des maquettes papier : Patients → popup patient → Valider → « Compte rendu fait » → Patients.
// Onglet Transmissions : les comptes rendus de l'équipe, « Mes CR » ou « Tous », filtre par soignant.
import { findStaff, staffName } from './auth.js';
import { ApiError, transcribe } from './bino-api.js';
import { EXAMPLES, seed } from './data.js';
import { buildModel, DOC_CSS, docFile, docHtml, docText } from './document.js';
import type { DocModel, Patient, SortKey, Tab, TrScope, Ui, Vitals } from './model.js';
import { news2 } from './news2.js';
import * as Voice from './services/voice.js';
import { saveSettings, settings } from './settings.js';
import * as Store from './store.js';
import { canonLevel } from './triage.js';
import { esc, hhmm } from './util.js';
import {
  byPriority,
  ic,
  levelOf,
  PRIO,
  room,
  V,
  vDone,
  vHeader,
  vLogged,
  vLogin,
  vPatientPopup,
  vPatients,
  vShiftAsk,
  vShiftSuccess,
  vTransmissions,
} from './views.js';

const S = seed(); // rempli par l'API dès qu'elle répond
const U: Ui = {
  tab: 'patients',
  pid: null, // patient ouvert dans la popup
  sub: null, // feuille secondaire ouverte depuis la popup (constantes, profil)
  draft: '',
  foldOpen: false,
  listening: null,
  capture: null,
  saving: false,
  syncing: false,
  trScope: 'mine',
  lvlOpen: null, // patient dont la rangée de priorité 1 à 3 est dépliée (Transmissions › Tous)
  docBusy: '',
  sumBusy: '',
  triBusy: false,
  sortBy: settings.sortBy === 'nom' ? 'nom' : 'chambre',
  trSort:
    settings.trSort === 'chambre' || settings.trSort === 'nom' || settings.trSort === 'prio'
      ? settings.trSort
      : 'prio',
  trQuery: '',
  loginError: '',
  loginId: '',
  justIn: false,
};
let docModel: DocModel | null = null;
let shiftSaving = false;
const P = (id: string): Patient | undefined => S.patients.find((p) => p.id === id);
const signedIn = (): boolean => !!settings.matricule;

function must(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} absent`);
  return found;
}
function control(id: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
  const found = document.getElementById(id);
  if (
    found instanceof HTMLInputElement ||
    found instanceof HTMLTextAreaElement ||
    found instanceof HTMLSelectElement
  )
    return found;
  return null;
}
function textField(id: string): HTMLInputElement | HTMLTextAreaElement | null {
  const found = control(id);
  if (found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement) return found;
  return null;
}

function alignSession() {
  const name = staffName(settings.matricule);
  if (name && name !== settings.name) saveSettings({ name });
}

function loginError(msg: string): void {
  U.loginError = msg;
  let el = document.querySelector('.login-err');
  if (!(el instanceof HTMLElement)) {
    el = document.createElement('p');
    el.className = 'login-err';
    el.setAttribute('role', 'alert');
    document.querySelector('.login-card .btn')?.before(el);
  }
  el.textContent = msg;
}

/* ---------- rendu ---------- */
let shownView = '';
function markView(name: string): void {
  const app = document.getElementById('app');
  if (!app || shownView === name) return;
  shownView = name;
  app.classList.remove('view-in');
  void app.offsetWidth;
  app.classList.add('view-in');
}

function render(): void {
  if (signedIn()) alignSession();
  const gate = !signedIn() || U.justIn;
  document.body.classList.toggle('locked', gate);
  must('shift').hidden = gate || U.tab !== 'transmissions';
  if (gate) {
    const top = must('top');
    top.hidden = true;
    top.innerHTML = '';
    must('tabs').innerHTML = '';
    must('app').innerHTML = signedIn() ? vLogged(settings.name) : vLogin(U.loginError, U.loginId);
    markView(signedIn() ? 'hello' : 'login');
    return;
  }
  const top = must('top');
  top.hidden = U.tab !== 'patients';
  top.innerHTML = U.tab === 'patients' ? vHeader() : '';
  must('app').innerHTML = U.tab === 'transmissions' ? vTransmissions(S, U) : vPatients(S, U);
  const tabs = [
    ['patients', 'Patients', 'users'],
    ['transmissions', 'Transmissions', 'doc'],
  ] as const;
  must('tabs').innerHTML = tabs
    .map(
      ([k, l, i]) =>
        `<button type="button" class="${U.tab === k ? 'on' : ''}" data-act="tab" data-arg="${k}" ${U.tab === k ? 'aria-current="page"' : ''}>${ic(i, 22)}<span>${l}</span></button>`,
    )
    .join('');
  markView(U.tab);
}

// Les mises à jour venues des autres soignants ne coupent ni une saisie ni la popup ouverte.
function softRender(): void {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
  if (document.querySelector('details.menu[open]')) return;
  render();
}

/* ---------- feuilles et popups ---------- */
let lastFocus: HTMLElement | null = null;
function sheet(html: string, full = false): void {
  const el = must('sheet');
  if (!html) {
    el.innerHTML = '';
    lastFocus?.focus({ preventScroll: true });
    return;
  }
  const opening = !el.innerHTML;
  if (opening && document.activeElement instanceof HTMLElement) lastFocus = document.activeElement;
  el.innerHTML = `<div class="sheet-wrap ${full ? 'full' : ''}${opening ? ' is-opening' : ''}" data-act="closeSheetBg"><div class="sheet" role="dialog" aria-modal="true"><div class="between sheet-top"><span></span><button type="button" class="icon-btn" data-act="closeSheet" aria-label="Fermer">${ic('x', 24)}</button></div>${html}</div></div>`;
  const h = el.querySelector('h1');
  if (h instanceof HTMLElement) {
    h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }
}

let listScroll = 0;
let scrollToken = 0;
function keepListPlace(): void {
  const y = listScroll;
  const token = ++scrollToken;
  const apply = () => {
    if (token === scrollToken) window.scrollTo(0, y);
  };
  apply();
  requestAnimationFrame(apply);
  setTimeout(apply, 350);
}

function showPatient(): void {
  U.sub = null;
  sheet(vPatientPopup(S, U, EXAMPLES), true);
}

function closePatient(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (U.listening) Voice.stop();
  U.listening = null;
  U.capture = null;
  U.pid = null;
  U.sub = null;
  sheet('');
  render();
  keepListPlace();
}

let doneTimer: ReturnType<typeof setTimeout> | undefined;
const DONE_MASCOT: Readonly<Record<string, string>> = {
  content: 'assets/mascot/mascot-report-encouraging.png',
};
function hideDone(): void {
  clearTimeout(doneTimer);
  const el = document.getElementById('done');
  if (el) el.innerHTML = '';
}
function showDone(title: string, status: string): void {
  must('done').innerHTML = vDone(title, status);
  clearTimeout(doneTimer);
}
function setDoneStatus(status: string, mood?: string): void {
  const el = document.getElementById('save-status');
  if (el) el.textContent = status;
  const face = document.getElementById('done-bino');
  const mascot = mood ? DONE_MASCOT[mood] : undefined;
  if (face instanceof HTMLImageElement && mascot) face.src = mascot;
}
function scheduleDoneClose(ms: number): void {
  clearTimeout(doneTimer);
  doneTimer = setTimeout(hideDone, ms);
}

function vitalsForm(id: string): void {
  U.sub = 'vitals';
  const p = P(id);
  if (!p) return;
  const v = V(p);
  const inp = (
    k: 'fr' | 'spo2' | 'pas' | 'pad' | 'fc' | 'temp',
    l: string,
    step: number | string = 1,
  ): string =>
    `<div><label class="l" for="v-${k}">${l}</label><input class="f" type="number" inputmode="decimal" step="${step}" id="v-${k}" data-vit="${k}" value="${v[k]}"></div>`;
  sheet(`<h1 style="margin-top:0">Constantes</h1><p class="sub">${esc(p.nom)} · ${room(p)} · le score se recalcule en direct</p>
  <div class="card"><div class="grid2">${inp('fr', 'FR (/min)')}${inp('spo2', 'SpO2 (%)')}${inp('pas', 'TA systolique')}${inp('pad', 'TA diastolique')}${inp('fc', 'FC (/min)')}${inp('temp', 'Température (°C)', '0.1')}
    <div><label class="l" for="v-o2">Oxygène</label><select class="f" id="v-o2" data-vit="o2"><option value="0" ${!v.o2 ? 'selected' : ''}>Air ambiant</option><option value="1" ${v.o2 ? 'selected' : ''}>Sous O2</option></select></div>
    <div><label class="l" for="v-cons">Conscience</label><select class="f" id="v-cons" data-vit="cons"><option value="A" ${v.cons === 'A' ? 'selected' : ''}>Alerte</option><option value="C" ${v.cons !== 'A' ? 'selected' : ''}>Confusion / altérée</option></select></div></div></div>
  <div class="card" id="vprev"></div>
  <button type="button" class="btn" data-act="saveVitals" data-arg="${id}">Enregistrer</button>`);
  vprev();
}
function readVitals(): Vitals {
  const raw = (k: string): string => control(`v-${k}`)?.value ?? '';
  return {
    fr: Number(raw('fr')),
    spo2: Number(raw('spo2')),
    pas: Number(raw('pas')),
    pad: Number(raw('pad')),
    fc: Number(raw('fc')),
    temp: Number.parseFloat(raw('temp').replace(',', '.')),
    o2: raw('o2') === '1',
    cons: raw('cons'),
  };
}
function vprev(): void {
  const el = document.getElementById('vprev');
  if (!el) return;
  const n = news2(readVitals());
  el.innerHTML = `<div class="between"><span class="small muted">Nouveau score NEWS2</span><span class="row" style="gap:8px"><b style="font-size:22px">${n.total}</b></span></div>`;
}

/* ---------- document de transmission global ---------- */
function synthFor(p: Patient) {
  return Store.synthFor(p.id);
}

async function genDoc(): Promise<void> {
  const ps = byPriority(S.patients);
  const todo = ps.filter((p) => Store.crFor(p.id).length);
  let done = 0;
  U.docBusy = `Synthèse 0/${todo.length}`;
  render();
  const syns = new Map<string, ReturnType<typeof synthFor>>();
  const queue = [...todo];
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const p = queue.shift();
      if (!p) continue;
      syns.set(p.id, synthFor(p));
      done++;
      U.docBusy = `Synthèse ${done}/${todo.length}`;
      const b = document.querySelector('[data-act="genDoc"]');
      if (b instanceof HTMLElement) b.innerHTML = `<span class="spin"></span> ${esc(U.docBusy)}`;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  docModel = buildModel(
    ps.map((p) => ({
      p,
      v: V(p),
      level: levelOf(p),
      crs: Store.crFor(p.id),
      syn: syns.get(p.id) || null,
    })),
    {
      date: new Date().toLocaleDateString('fr-FR'),
      time: hhmm(),
      author: Store.myName(),
      service: 'Réanimation',
      authorOf: Store.authorOf,
    },
  );
  U.docBusy = '';
  render();
  showDoc();
}

function showDoc(): void {
  if (!docModel) return;
  sheet(
    `<div class="doc-actions"><button type="button" class="btn sec sm" data-act="copyDoc">${ic('copy', 16)} Copier</button><button type="button" class="btn sm" data-act="downloadDoc">${ic('dl', 16)} Télécharger</button></div>${docHtml(docModel)}`,
    true,
  );
}

async function downloadDoc(): Promise<void> {
  if (!docModel) return;
  const filename = `transmission-${docModel.date.replace(/\//g, '-')}.html`;
  const data = docFile(docModel);
  const url = URL.createObjectURL(new Blob([data], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Document téléchargé.', 'content');
}

/* ---------- comptes rendus ---------- */
async function saveCr(): Promise<void> {
  if (U.saving) return;
  if (U.capture === 'server' && U.listening) {
    const target = U.listening;
    U.listening = null;
    U.capture = null;
    const heard = await finishServerMic(target);
    if (!heard) return;
  } else if (U.listening) {
    Voice.stop();
    U.listening = null;
  }
  const el = textField('draft');
  const text = (el ? el.value : U.draft).trim();
  if (!text) {
    toast("Dicte ou écris d'abord le compte rendu.");
    return;
  }
  const pid = U.pid;
  if (!pid) return;
  U.saving = true;
  U.draft = '';
  closePatient();
  showDone('Compte rendu fait', 'Rangement en cours.');
  try {
    await Store.addCr(pid, text);
    setDoneStatus('Il est dans Mes CR.', 'content');
    scheduleDoneClose(2200);
  } catch (e) {
    const done = document.getElementById('done');
    if (done) done.innerHTML = '';
    U.draft = text;
    U.pid = pid;
    showPatient();
    toast(
      e instanceof ApiError && e.code === 'invalid_argument'
        ? "Ton accès est en lecture seule : demande à l'équipe de te passer en Contributeur."
        : "L'enregistrement a échoué. Le texte est toujours là, réessaie.",
      'alerte',
    );
  } finally {
    U.saving = false;
  }
}

/* ---------- dictée ---------- */
function micUnavailable(): void {
  textField('draft')?.focus();
  toast('Dictée indisponible ici : utilise le micro du clavier.', 'alerte');
}

async function finishServerMic(target: string): Promise<boolean> {
  const live = document.getElementById('live');
  if (live) live.textContent = 'Transcription…';
  try {
    const blob = await Voice.stopRecording();
    if (!blob || blob.size < 800) {
      toast('Rien entendu. Réessaie, ou tape le texte.', 'alerte');
      return false;
    }
    const text = await transcribe(blob);
    if (!text) {
      toast('Rien entendu. Réessaie, ou tape le texte.', 'alerte');
      return false;
    }
    const box = textField(target);
    if (box) box.value = `${box.value.trim()} ${text}`.trim();
    if (target === 'draft') U.draft = box ? box.value : `${U.draft} ${text}`.trim();
    return true;
  } catch {
    toast('La transcription a échoué. Tu peux taper le texte.', 'alerte');
    return false;
  } finally {
    if (live) live.textContent = '';
    refreshMic();
  }
}

function beginServerMic(target: string): void {
  const el = textField(target);
  if (target === 'draft' && el) U.draft = el.value;
  U.listening = target;
  U.capture = 'server';
  const live = document.getElementById('live');
  if (live) live.textContent = 'Écoute…';
  refreshMic();
  Voice.startRecording().catch((e) => {
    if (U.capture !== 'server') return;
    U.listening = null;
    U.capture = null;
    refreshMic();
    if (live) live.textContent = '';
    const name = e instanceof Error ? e.name : '';
    const denied = name === 'NotAllowedError' || name === 'SecurityError';
    toast(
      denied
        ? 'Micro refusé : tu peux taper le texte.'
        : 'Aucun micro détecté. Tu peux taper le texte.',
      'alerte',
    );
  });
}

function startMic(target: string): void {
  if (U.listening) {
    const was = U.listening;
    const server = U.capture === 'server';
    U.listening = null;
    U.capture = null;
    if (server) {
      refreshMic();
      void finishServerMic(was);
      return;
    }
    Voice.stop();
    refreshMic();
    if (was === target) return;
  }
  if (Voice.canDictate() && Voice.useBrowserDictation()) {
    beginBrowserMic(target);
    return;
  }
  if (Voice.canRecord()) {
    beginServerMic(target);
    return;
  }
  micUnavailable();
}

function beginBrowserMic(target: string): void {
  const el = textField(target);
  if (target === 'draft' && el) U.draft = el.value;
  U.listening = target;
  const live = document.getElementById('live');
  if (live) live.textContent = 'Écoute…';
  Voice.start({
    onPartial: (t: string) => {
      const l = document.getElementById('live');
      if (l) l.textContent = t || 'Écoute…';
    },
    onFinal: (t: string) => {
      const box = textField(target);
      if (box) box.value = `${box.value.trim()} ${t}`.trim();
      if (target === 'draft') U.draft = box ? box.value : `${U.draft} ${t}`.trim();
      const l = document.getElementById('live');
      if (l) l.textContent = U.listening === target ? 'Écoute…' : '';
    },
    onEnd: () => {
      if (U.listening === target) {
        U.listening = null;
        refreshMic();
      }
      const l = document.getElementById('live');
      if (l && l.textContent === 'Écoute…') l.textContent = '';
    },
    onError: (e) => {
      U.listening = null;
      refreshMic();
      const l = document.getElementById('live');
      if (l) l.textContent = '';
      const messages: Record<string, string> = {
        not_granted: 'Micro refusé : tu peux taper le texte.',
        network: 'La dictée ne joint pas le service vocal. Tu peux taper le texte.',
        'service-not-allowed': 'Ce navigateur ne dicte pas. Tu peux taper le texte.',
        'audio-capture': 'Aucun micro détecté. Tu peux taper le texte.',
      };
      const code = e.code ?? '';
      toast(messages[code] ?? 'Dictée indisponible ici : utilise le micro du clavier.', 'alerte');
    },
  });
  refreshMic();
}
function refreshMic(): void {
  for (const b of document.querySelectorAll('[data-act="mic"]')) {
    if (!(b instanceof HTMLElement)) continue;
    const on = b.dataset.arg === U.listening;
    b.classList.toggle('on', on);
    b.innerHTML = ic(on ? 'stop' : 'mic', 28);
    b.setAttribute('aria-label', on ? 'Arrêter la dictée' : 'Dicter');
  }
}

/* ---------- actions ---------- */
let tt: ReturnType<typeof setTimeout> | undefined;
const TOAST_FACE = {
  content: 'mascot-report-encouraging.png',
  alerte: 'mascot-surprised.png',
  neutre: 'mascot-login-wink.png',
} as const;
function toast(m: string, mood: keyof typeof TOAST_FACE = 'neutre'): void {
  const t = must('toast');
  const face = TOAST_FACE[mood];
  t.innerHTML = `<div class="toast"><img class="toast-bino" src="assets/mascot/${face}" alt="">${esc(m)}</div>`;
  clearTimeout(tt);
  tt = setTimeout(() => {
    t.innerHTML = '';
  }, 4000);
}

type Act = (arg?: string, el?: HTMLElement, ev?: Event) => void | Promise<void>;
function isSort(value: string | undefined): value is SortKey {
  return value === 'chambre' || value === 'nom' || value === 'prio';
}
function isTab(value: string | undefined): value is Tab {
  return value === 'patients' || value === 'transmissions';
}
function isScope(value: string | undefined): value is TrScope {
  return value === 'mine' || value === 'all';
}

const A: Record<string, Act> = {
  login: () => {
    const idEl = textField('login-id');
    const pwEl = textField('login-pw');
    const id = idEl?.value || '';
    const pw = pwEl?.value || '';
    if (!id.trim() || !pw.trim()) {
      loginError('Indique le matricule et le mot de passe.');
      (id.trim() ? pwEl : idEl)?.focus();
      return;
    }
    const staff = findStaff(id, pw);
    if (!staff) {
      loginError('Matricule ou mot de passe incorrect.');
      pwEl?.focus();
      return;
    }
    saveSettings({ matricule: staff.matricule, name: staff.name });
    U.loginError = '';
    U.loginId = '';
    U.justIn = true;
    render();
  },
  togglePassword: () => {
    const password = document.getElementById('login-pw');
    const toggle = document.querySelector('[data-act="togglePassword"]');
    if (!(password instanceof HTMLInputElement) || !(toggle instanceof HTMLButtonElement)) return;
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    toggle.setAttribute(
      'aria-label',
      visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe',
    );
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.innerHTML = ic(visible ? 'eyeOff' : 'eye', 20);
    password.focus({ preventScroll: true });
  },
  enter: () => {
    U.justIn = false;
    render();
    Store.refresh().catch(() => {});
  },
  logout: () => {
    shiftSaving = false;
    if (U.listening) Voice.stop();
    U.listening = null;
    U.capture = null;
    U.pid = null;
    U.sub = null;
    U.justIn = false;
    U.loginError = '';
    U.loginId = '';
    saveSettings({ matricule: '', name: '' });
    sheet('');
    must('done').innerHTML = '';
    render();
  },
  tab: (a) => {
    if (!isTab(a)) return;
    hideDone();
    U.tab = a;
    render();
    window.scrollTo(0, 0);
  },
  seeTransmissions: () => {
    hideDone();
    U.tab = 'transmissions';
    U.trScope = 'mine';
    render();
    window.scrollTo(0, 0);
  },
  openPatient: (a) => {
    if (!a) return;
    hideDone();
    listScroll = window.scrollY;
    U.pid = a;
    U.draft = '';
    U.foldOpen = false;
    showPatient();
  },
  toggleDossier: () => {
    const el = textField('draft');
    if (el) U.draft = el.value;
    U.foldOpen = !U.foldOpen;
    const sc = document.querySelector('.sheet')?.scrollTop || 0;
    showPatient();
    const sh = document.querySelector('.sheet');
    if (sh) sh.scrollTop = sc;
  },
  genDoc: () => genDoc(),
  copyDoc: () => {
    if (!docModel) return;
    const t = docText(docModel);
    if (navigator.clipboard)
      navigator.clipboard
        .writeText(t)
        .then(() => toast('Document copié.', 'content'))
        .catch(() => toast('Copie impossible ici.', 'alerte'));
    else toast('Copie impossible ici.', 'alerte');
  },
  downloadDoc: () => downloadDoc(),
  useEx: (a) => {
    const example = EXAMPLES[Number(a)];
    if (!example) return;
    U.draft = example.text;
    const el = textField('draft');
    if (el) el.value = U.draft;
  },
  mic: (a) => {
    if (a) startMic(a);
  },
  saveCr: () => saveCr(),
  askShift: () => {
    shiftSaving = false;
    must('done').innerHTML = vShiftAsk();
  },
  cancelShift: (_a, el, e) => {
    if (shiftSaving) return;
    if (!el || !e) return;
    if (el.classList.contains('done-wrap') && e.target !== el) return;
    must('done').innerHTML = '';
  },
  confirmShift: async () => {
    if (shiftSaving) return;
    shiftSaving = true;
    must('done').innerHTML = vShiftAsk(true);
    try {
      const reviewed = await Store.reviewMine();
      if (!reviewed) {
        shiftSaving = false;
        must('done').innerHTML = vShiftAsk(false, 'Aucun compte rendu en attente de validation.');
        return;
      }
      shiftSaving = false;
      must('done').innerHTML = vShiftSuccess();
      document.querySelector<HTMLButtonElement>('[data-act="closeShiftSuccess"]')?.focus({
        preventScroll: true,
      });
    } catch {
      shiftSaving = false;
      must('done').innerHTML = vShiftAsk(false, 'Validation impossible pour le moment.');
    }
  },
  closeShiftSuccess: () => {
    must('done').innerHTML = '';
  },

  trScope: (a) => {
    if (!isScope(a)) return;
    U.trScope = a;
    render();
  },
  sortBy: (a) => {
    if (a !== 'chambre' && a !== 'nom') return;
    U.sortBy = a;
    saveSettings({ sortBy: a });
    render();
  },
  trSort: (a) => {
    if (!isSort(a)) return;
    U.trSort = a;
    saveSettings({ trSort: a });
    render();
  },
  pickLevel: (a) => {
    U.lvlOpen = U.lvlOpen === a ? null : (a ?? null);
    render();
  },
  setLevel: async (a = '') => {
    const [pid, raw] = a.split(':');
    if (!pid) return;
    const lv = canonLevel(raw ?? null);
    try {
      await Store.setManualLevel(pid, lv);
    } catch {
      toast('Modification impossible pour le moment.', 'alerte');
    }
    U.lvlOpen = null;
    render();
    toast(lv ? `Priorité ${PRIO[lv]} enregistrée.` : 'Priorité proposée rétablie.', 'content');
  },
  editVitals: (a) => {
    if (a) vitalsForm(a);
  },

  saveVitals: async (a) => {
    if (!a) return;
    const v = readVitals();
    if ([v.fr, v.spo2, v.pas, v.pad, v.fc, v.temp].some((x) => !Number.isFinite(x) || x <= 0)) {
      toast('Vérifie les valeurs saisies.', 'alerte');
      return;
    }
    await Store.saveVitals(a, { ...v, at: hhmm(), src: 'saisie' });
    const n = news2(v);
    U.foldOpen = true;
    showPatient();
    render();
    toast(`Constantes enregistrées · NEWS2 ${n.total}.`, 'content');
  },
  closeSheet: () => {
    // Une feuille ouverte depuis la popup patient (constantes, profil) ramène à la popup.
    if (U.pid && U.sub) showPatient();
    else if (U.pid) closePatient();
    else sheet('');
  },
  closeSheetBg: (_a, el, e) => {
    if (!el || !e) return;
    if (e.target === el) {
      const close = A.closeSheet;
      if (close) close();
    }
  },
  closeDone: (_a, el, e) => {
    if (!el || !e) return;
    if (e.target === el || el.classList.contains('done-x')) must('done').innerHTML = '';
  },
};

document.addEventListener('click', (e) => {
  const raw = e.target;
  if (!(raw instanceof Element)) return;
  const el = raw.closest('[data-act]');
  if (!(el instanceof HTMLElement)) {
    for (const d of document.querySelectorAll('details.menu[open]')) {
      if (d instanceof HTMLDetailsElement && !d.contains(raw)) d.open = false;
    }
    return;
  }
  const menu = el.closest('details.menu');
  if (menu instanceof HTMLDetailsElement) menu.open = false;
  const act = el.dataset.act;
  if (!act) return;
  if (act !== 'closeSheetBg' && act !== 'closeDone') e.preventDefault();
  const run = A[act];
  if (run) void run(el.dataset.arg, el, e);
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) && !(t instanceof HTMLTextAreaElement)) return;
  if (t.dataset.model === 'draft' || t.dataset.model === 'trQuery') U[t.dataset.model] = t.value;
  if (t.id === 'tr-q' && t instanceof HTMLInputElement) {
    const pos = t.selectionStart;
    render();
    const el = textField('tr-q');
    if (el instanceof HTMLInputElement) {
      el.focus();
      if (pos !== null) el.setSelectionRange(pos, pos);
    }
    return;
  }
  if (t.dataset.vit !== undefined) vprev();
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLElement && t.dataset.vit !== undefined) vprev();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('login-id')) {
    e.preventDefault();
    if (document.activeElement?.id === 'login-id') {
      textField('login-pw')?.focus();
      return;
    }
    const login = A.login;
    if (login) login();
    return;
  }
  if (e.key !== 'Escape') return;
  const done = document.getElementById('done');
  const sheetEl = document.getElementById('sheet');
  if (done?.innerHTML) {
    if (!shiftSaving) done.innerHTML = '';
  } else if (document.querySelector('details.menu[open]')) {
    for (const d of document.querySelectorAll('details.menu[open]')) {
      if (d instanceof HTMLDetailsElement) d.open = false;
    }
  } else if (sheetEl?.innerHTML) {
    const close = A.closeSheet;
    if (close) close();
  }
});

const style = document.createElement('style');
style.textContent = DOC_CSS;
document.head.append(style);

Store.onChange(() => {
  const rows = Store.patientRows();
  if (rows?.length) S.patients.splice(0, S.patients.length, ...rows);
  softRender();
});
render();
Voice.init().then(softRender);
Store.init().then(() => {
  softRender();
});
