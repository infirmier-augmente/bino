// Rendu des écrans (HTML en chaînes), d'après les maquettes papier de l'équipe :
// 1. Patients (Bonjour + date, liste organisée par sévérité, auto par l'IA ou manuelle) ;
// 2. Fiche « Nouveau compte rendu » (dossier médical, micro, Valider) ;
// 3. Transmissions (Mes CR / Tous en puces résumées). Aucune écriture ici : les actions sont dans app.ts.
import type { Cr, Example, Level, Patient, Point, Ui, Vitals, Ward } from './model.js';
import { LV, news2 } from './news2.js';
import * as Store from './store.js';
import { canonLevel, LEVELS, rank } from './triage.js';
import { esc, num } from './util.js';

/* ---------- briques ---------- */
const I = {
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 7M21 20a6 6 0 0 0-4-5.6"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  chevr: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  sync: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13l2 2 4-4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  spark:
    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A11.6 11.6 0 0 1 12 5c6.4 0 10 7 10 7a13.8 13.8 0 0 1-3 3.8M6.2 6.2C3.5 8.1 2 12 2 12s3.6 7 10 7c1 0 1.9-.2 2.8-.5"/>',
};
export const ic = (n: keyof typeof I, s = 20): string =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

export const badge = (lv: Level): string =>
  `<span class="badge" style="background:${LV[lv].bg};color:${LV[lv].fg}">${LV[lv].l}</span>`;

export const V = (p: Patient): Vitals => Store.vitalsFor(p.id) || p.v;

// Priorité 1 (la plus urgente) à 4. Proposée par le service, modifiable à la main :
// le choix de l'infirmière prime toujours.
export const PRIO: Record<Level, number> = { critique: 1, eleve: 2, moyen: 3, stable: 4 };
export const prioTag = (lv: Level): string => `Priorité ${PRIO[lv]}`;
export function levelOf(p: Patient): Level {
  const manual = canonLevel(Store.manualLevels()[p.id]);
  if (manual) return manual;
  const ai = Store.prioAI()?.order.find((x) => x.id === p.id);
  return (
    canonLevel(ai?.niveau) || canonLevel(ai?.level) || canonLevel(news2(V(p)).level) || 'moyen'
  );
}
const aiPos = (p: Patient): number => {
  const i = (Store.prioAI()?.order ?? []).findIndex((x) => x.id === p.id);
  return i < 0 ? 999 : i;
};
const byPrio = (a: Patient, b: Patient): number =>
  rank(levelOf(a)) - rank(levelOf(b)) ||
  aiPos(a) - aiPos(b) ||
  news2(V(b)).total - news2(V(a)).total;
const lastName = (p: Patient): string =>
  p.nom
    .replace(/^(M\.|Mme|Mlle)\s+/, '')
    .split(/\s+/)
    .slice(-1)[0] ?? '';
// Tri du dashboard : par chambre ou par nom (la priorité ne s'affiche plus sur le dashboard).
export const SORTS = {
  chambre: { l: 'Chambre', f: (a: Patient, b: Patient) => Number(a.ch) - Number(b.ch) },
  nom: { l: 'Nom', f: (a: Patient, b: Patient) => lastName(a).localeCompare(lastName(b), 'fr') },
};
const TR_SORTS = {
  chambre: SORTS.chambre,
  nom: SORTS.nom,
  prio: { l: 'Priorité' },
};
// Ordre par priorité (IA ou choix manuel), utilisé dans Transmissions › Tous et le document.
export const byPriority = (patients: Patient[]): Patient[] => [...patients].sort(byPrio);
export const sorted = (patients: Patient[], by = 'chambre'): Patient[] => {
  if (by === 'prio') return byPriority(patients);
  const spec = by === 'nom' ? SORTS.nom : SORTS.chambre;
  return [...patients].sort(spec.f);
};
export const room = (p: Patient | undefined): string => `CHAMB ${esc(p?.ch ?? '')}`;

// Menu « Trier » partagé par le dashboard et Transmissions › Tous.
function sortMenu(
  opts: Record<string, { l: string }>,
  cur: string,
  act: string,
  pop = 'right',
): string {
  const buttons = Object.keys(opts)
    .map((k) => {
      const o = opts[k];
      if (!o) return '';
      return `<button type="button" data-act="${act}" data-arg="${k}" aria-pressed="${cur === k}"><span><b>${o.l}</b></span>${cur === k ? ic('check', 18) : ''}</button>`;
    })
    .join('');
  return `<details class="menu sort-menu"><summary class="btn sec sm" role="button">Trier : ${opts[cur]?.l || ''} ${ic('chev', 16)}</summary>
      <div class="menu-pop ${pop}">${buttons}</div></details>`;
}

const firstName = (s: string): string => s.split(/[·,]/)[0]?.trim().split(/\s+/)[0] || '';

export function vLogin(error: string, matricule: string): string {
  return `<div class="login">
    <img class="login-mark" src="assets/mascot/mascot-login-hero.png" width="338" height="270" alt="">
    <h1>Connexion</h1>
    <p class="sub">Entre ton matricule et ton mot de passe.</p>
    <div class="card login-card">
      <label class="l" for="login-id">Matricule</label>
      <input class="f" id="login-id" inputmode="numeric" autocomplete="username" placeholder="10482" value="${esc(matricule || '')}">
      <label class="l" for="login-pw">Mot de passe</label>
      <div class="password-field"><input class="f" id="login-pw" type="password" autocomplete="current-password" placeholder="bino"><button type="button" class="password-toggle" data-act="togglePassword" aria-label="Afficher le mot de passe" aria-pressed="false">${ic('eye', 20)}</button></div>
      ${error ? `<p class="login-err" role="alert">${esc(error)}</p>` : ''}
      <button type="button" class="btn" data-act="login">Se connecter</button>
    </div>
    <p class="small muted login-hint">Démo</p>
  </div>`;
}

export function vLogged(name: string): string {
  return `<div class="login logged">
    <img class="login-mark" src="assets/mascot/mascot-success-celebrating.png" width="116" height="128" alt="">
    <h1>${esc(name)}</h1>
    <p class="sub">Connexion réussie</p>
    <button type="button" class="btn" data-act="enter">Continuer</button>
  </div>`;
}

export const micBtn = (U: Ui, target: string): string =>
  `<button type="button" class="mic ${U.listening === target ? 'on' : ''}" data-act="mic" data-arg="${target}" aria-label="${U.listening === target ? 'Arrêter la dictée' : 'Dicter le compte rendu'}">${ic(U.listening === target ? 'stop' : 'mic', 28)}</button>`;

/* ---------- en-tête : mascotte + Bonjour + date, page Patients seulement ---------- */
export function vHeader(): string {
  const date = new Date().toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const who = esc(firstName(Store.displayName()));
  return `<div class="hello">
    <img class="hello-mascot" src="assets/mascot/mascot-patient-avatar.png" width="52" height="52" alt="">
    <div><div class="hello-t">${who}</div><div class="hello-d">Date : ${date}</div></div>
    <button type="button" class="hello-out" data-act="logout">Déconnexion</button>
  </div>`;
}

/* ---------- onglet 1 : patients ---------- */
// Rouge, orange, jaune, vert. Chaque couleur est un niveau, avec son libellé.
const TRAFFIC: Record<Level, { bg: string; fg: string; ink: string; bar: string }> = {
  critique: { bg: '#DC0000', fg: '#fff', ink: '#DC0000', bar: '#DC0000' },
  eleve: { bg: '#F57C00', fg: '#fff', ink: '#C45C00', bar: '#F57C00' },
  moyen: { bg: '#F5B700', fg: '#1A1A1A', ink: '#8A6500', bar: '#F5B700' },
  stable: { bg: '#14804a', fg: '#fff', ink: '#14804a', bar: '#14804a' },
};
const trafficStyle = (lv: Level): string =>
  `--c:${TRAFFIC[lv].bg};--f:${TRAFFIC[lv].fg};--ink:${TRAFFIC[lv].ink}`;

// Bouton « Priorité n » : un toucher déplie, dans la carte, la rangée 1 2 3 4.
export const prioBtn = (p: Patient, open = false): string => {
  const lv = levelOf(p);
  const why = Store.manualLevels()[p.id]
    ? 'choisie par un soignant'
    : Store.prioAI()?.order?.find((x) => x.id === p.id)?.raison || `NEWS2 ${news2(V(p)).total}`;
  return `<button type="button" class="lvl sm ${open ? 'open' : ''}" style="${trafficStyle(lv)}" data-act="pickLevel" data-arg="${p.id}" aria-expanded="${open}" title="${esc(why)}" aria-label="${esc(p.nom)} : ${prioTag(lv)} (${esc(why)}). Changer la priorité">${prioTag(lv)} ${ic('chev', 14)}</button>`;
};

export function vPatients(S: Ward, U: Ui): string {
  if (Store.isLoading()) {
    return `<div class="list-head between"><h2 class="list-t">Patients</h2></div>
  <p class="note">Chargement…</p>`;
  }
  const ps = sorted(S.patients, U.sortBy);
  return `<div class="list-head between"><div><h2 class="list-t">Patients <span class="count">${ps.length}</span></h2><p class="list-ward">Réanimation</p></div>

    ${sortMenu(SORTS, U.sortBy, 'sortBy')}</div>
  ${Store.isStale() ? '<p class="note">Les comptes rendus de l\'équipe ne sont pas encore joignables.</p>' : ''}
  ${ps
    .map((p) => {
      return `<div class="card prow">
        <button type="button" class="prow-open" data-act="openPatient" data-arg="${p.id}"><span class="prow-main"><span class="prow-name">${esc(p.nom)}</span><span class="prow-sub">${p.age} ans · ${esc(p.motif)}</span></span><span class="room-chip">${room(p)}</span></button>
      </div>`;
    })
    .join('')}`;
}

// Petite rangée de cercles 1 à 4, dépliée dans la carte sous le bouton Priorité.
// Le choix de l'infirmière prime sur la proposition (IA ou NEWS2).
function levelRow(p: Patient): string {
  const cur = levelOf(p);
  return `<div class="lvl-pick">
    <div class="lvl-row" role="group" aria-label="Priorité de ${esc(p.nom)}">${LEVELS.map(
      (l) =>
        `<button type="button" class="lvl-n ${cur === l ? 'on' : ''}" style="${trafficStyle(l)}" data-act="setLevel" data-arg="${p.id}:${l}" aria-pressed="${cur === l}" aria-label="${prioTag(l)}">${PRIO[l]}</button>`,
    ).join('')}</div>
  </div>`;
}

/* ---------- fiche : nouveau compte rendu ---------- */
function vtable(v: Vitals): string {
  const n = news2(v);
  const rows = [
    ['Fréquence respiratoire', `${v.fr} /min`, n.p.fr],
    ['SpO2', `${v.spo2} %`, n.p.spo2],
    ['Oxygène', v.o2 ? 'Oui' : 'Air ambiant', n.p.o2],
    ['Tension artérielle', `${v.pas}/${v.pad} mmHg`, n.p.pas],
    ['Fréquence cardiaque', `${v.fc} /min`, n.p.fc],
    ['Température', `${num(v.temp)} °C`, n.p.temp],
    ['Conscience', v.cons === 'A' ? 'Alerte' : 'Altérée', n.p.cons],
  ];
  return `<table class="vtable"><tbody>${rows
    .map((r) => {
      const label = r[0] ?? '';
      const value = r[1] ?? '';
      const pts = r[2] ?? 0;
      return `<tr><td>${label}</td><td class="v">${value}</td><td class="p p${pts}">${pts ? `+${pts}` : '0'}</td></tr>`;
    })
    .join(
      '',
    )}<tr><td><b>Total NEWS2</b></td><td></td><td class="p p${n.total >= 7 ? 3 : n.total >= 5 ? 2 : n.total ? 1 : 0}">${n.total}</td></tr></tbody></table>`;
}

const info = (k: string, v: string): string =>
  `<div class="info"><span>${k}</span><b>${esc(v)}</b></div>`;

export function vPatientPopup(S: Ward, U: Ui, examples: Example[]): string {
  const p = S.patients.find((x) => x.id === U.pid);
  if (!p) return '';
  const v = V(p);
  const ex = examples.find(
    (e) => e.pid === p.id && !Store.crFor(p.id).some((c) => c.text === e.text),
  );
  return `<div class="pp">
  <h1 class="pp-title">Nouveau compte rendu</h1>
  <div class="pp-name">${esc(p.nom)}</div>
  <div class="pp-sub">Chambre ${esc(p.ch)} · ${p.age} ans</div>
  <img class="pp-mascot" src="assets/mascot/mascot-login-hero.png" width="338" height="270" alt="">
  <p class="pp-steps"><span><i>« Dicte ou écris, puis valide. Tu retrouveras ton compte-rendu soigneusement rangé dans <b>Mes CR</b>. »</i></span></p>

  <div class="pp-actions">
    <button type="button" class="pill ${U.foldOpen ? 'on' : ''}" data-act="toggleDossier" aria-expanded="${U.foldOpen}">${ic('folder', 18)} Dossier médical ${ic('chev', 16)}</button>
  </div>
  ${
    U.foldOpen
      ? `<div class="dossier-body card">
      ${
        v.src === 'absent'
          ? '<p class="small muted">Constantes non fournies par le service.</p>'
          : `${vtable(v)}
      <div class="small muted" style="margin-top:6px">Constantes de ${esc(v.at)}${v.src === 'DPI' ? ' · importées du DPI' : ''}</div>
      <button type="button" class="btn sec sm" data-act="editVitals" data-arg="${p.id}" style="margin:10px 0 6px">${ic('pen', 16)} Modifier les constantes</button>`
      }
      ${info('Motif', p.motif)}${info('Antécédents', p.atcd)}${info('Allergies', p.allergies)}
      ${p.precautions ? info('Précautions', p.precautions) : ''}
      ${p.disp.length ? info('Dispositifs', p.disp.map((d) => `${d.l} (J${d.j})`).join(', ')) : ''}
      ${p.rx ? info('Nouvelle prescription', `${p.rx.t} (${p.rx.at})`) : ''}
      ${p.famille ? info('Famille', p.famille) : ''}
    </div>`
      : ''
  }

  <div class="cr-zone">
    <label class="sr" for="draft">Compte rendu</label>
    <textarea id="draft" class="draft cr-box" data-model="draft" placeholder="Ce que tu as vu et fait, comme à la relève.">${esc(U.draft)}</textarea>
    <div class="live" id="live" aria-live="polite"></div>
    <div class="pp-mic">${micBtn(U, 'draft')}</div>
    ${ex ? `<div class="pp-ex"><button type="button" class="chip ex" data-act="useEx" data-arg="${examples.indexOf(ex)}">${ic('play', 14)} Exemple : ${esc(ex.label)}</button></div>` : ''}
  </div>
  <div class="pp-foot"><button type="button" class="btn valider" data-act="saveCr" ${U.saving ? 'disabled' : ''}>${U.saving ? '<span class="spin"></span>' : ''} Valider</button></div>
  </div>`;
}

const waitingDots =
  '<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>';

export const vDone = (title = 'Compte rendu fait', status = ''): string => {
  const line = status === 'Rangement en cours.' ? `Rangement en cours${waitingDots}` : esc(status);
  return `<div class="done-wrap done-note"><button type="button" class="done-backdrop" data-act="closeDone" aria-label="Fermer"></button><div class="done-card" role="dialog" aria-modal="true" aria-labelledby="done-t"><button type="button" class="icon-btn done-x" data-act="closeDone" aria-label="Fermer">${ic('x', 22)}</button><img class="done-bino" id="done-bino" src="assets/mascot/mascot-report-encouraging.png" width="120" height="108" alt=""><div class="done-t" id="done-t">${esc(title)}</div><p class="done-status" id="save-status">${line}</p><button type="button" class="btn sec sm done-go" data-act="seeTransmissions">Voir Mes CR</button></div></div>`;
};

export const vShiftAsk = (busy = false, error = ''): string =>
  `<div class="done-wrap" data-act="cancelShift"><div class="done-card shift-ask" role="dialog" aria-modal="true" aria-labelledby="shift-t" aria-busy="${busy}"><img class="shift-mascot" src="assets/mascot/mascot-confirm-gentle.png" width="153" height="128" alt=""><div class="done-t" id="shift-t">Valider la transmission ?</div>${error ? `<p class="shift-error" role="alert">${esc(error)}</p>` : ''}<div class="shift-actions"><button type="button" class="btn sec" data-act="cancelShift" ${busy ? 'disabled' : ''}>Annuler</button><button type="button" class="btn" data-act="confirmShift" ${busy ? 'disabled' : ''}>${busy ? '<span class="spin"></span> Validation…' : 'Confirmer'}</button></div></div></div>`;

export const vShiftSuccess = (): string =>
  `<div class="done-wrap shift-success-wrap"><div class="done-card shift-success" role="dialog" aria-modal="true" aria-labelledby="shift-success-title"><img class="shift-success-mascot" src="assets/mascot/mascot-success-celebrating.png" width="189" height="130" alt=""><div class="done-t" id="shift-success-title">Transmission validée !</div><p class="done-status">Le compte-rendu a été transmis.</p><button type="button" class="btn" data-act="closeShiftSuccess">OK</button></div></div>`;

/* ---------- onglet 2 : transmissions ---------- */
function crItem(c: Cr, S: Ward): string {
  const p = S.patients.find((x) => x.id === c.pid);
  return `<div class="cr-item">
    <div class="between"><span class="cr-who">${esc(p?.nom || '')} <span class="room-chip sm">${room(p)}</span></span><span class="small muted">${esc(c.t || '')}</span></div>
    <p class="cr-text">${esc(c.text)}</p>
  </div>`;
}

function srcLine(field: Point | undefined, crs: Cr[]): string {
  if (!field?.src.length) return '';
  const byId = new Map(crs.map((c) => [c.id, c]));
  const found: Cr[] = [];
  for (const s of field.src) {
    const c = byId.get(s.cr);
    if (c) found.push(c);
  }
  found.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const who = [
    ...new Set(found.map((c) => `${Store.authorOf(c).split(' ')[0] ?? ''} ${c.t || ''}`.trim())),
  ];
  return who.length ? `<span class="pt-src">${esc(who.join(' · '))}</span>` : '';
}

// Une puce est datée par le compte rendu le plus récent qu'elle cite : la plus récente en premier.
function chrono(points: Point[], crs: Cr[]): Point[] {
  const at = new Map(crs.map((c) => [c.id, Date.parse(c.at)]));
  const t = (pt: Point): number => {
    const times = pt.src.map((x) => at.get(x.cr) ?? Number.NEGATIVE_INFINITY);
    return times.length ? Math.max(...times) : Number.NEGATIVE_INFINITY;
  };
  return [...points].sort((a, b) => t(b) - t(a));
}

function foldPoint(s: string): string {
  return String(s)
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[.,;:…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// On garde la phrase la plus complète quand le même fait est répété.
function tighten(points: Point[]): Point[] {
  return points.filter((p, i) => {
    const n = foldPoint(p.t);
    if (!n) return false;
    const label = n.split(' : ')[0] ?? '';
    return !points.some((other, j) => {
      if (j === i) return false;
      const o = foldPoint(other.t);
      const sameLabel = label.length > 3 && label === (o.split(' : ')[0] ?? '');
      if (sameLabel) return o.length > n.length || (o.length === n.length && j < i);
      return o.length > n.length && o.includes(n);
    });
  });
}

// Un patient stable tient en peu de lignes. Un patient plus lourd garde le détail.
const EXTRA_LINES: Record<Level, number> = { critique: 4, eleve: 4, moyen: 2, stable: 1 };
function forCard(points: Point[], lv: Level): Point[] {
  const kept = tighten(points);
  const lead = [];
  const rest = [];
  for (const p of kept) {
    if (p.t.includes(' : ') || p.t.length > 90) lead.push(p);
    else rest.push(p);
  }
  return [...lead, ...rest.slice(0, EXTRA_LINES[lv] ?? 2)];
}

function summaryCard(p: Patient, open: boolean): string {
  const crs = Store.crFor(p.id);
  const lv = levelOf(p);
  const s = Store.synthFor(p.id);
  const fresh = s && !Store.needsSynth();
  let body: string;
  if (!crs.length) body = '<p class="small muted">Aucun compte rendu aujourd\'hui.</p>';
  else if (!fresh)
    body = '<p class="small muted"><span class="spin dark"></span> Résumé en cours…</p>';
  else
    body = `<p class="sum-dx">${esc(p.motif)}</p><ul class="pts">${forCard(
      chrono(s.points || [], crs),
      lv,
    )
      .map((pt) => `<li>${esc(pt.t)} ${srcLine(pt, crs)}</li>`)
      .join('')}</ul>`;
  return `<div class="card sum" style="--bar:${TRAFFIC[lv].bar}">
    <div class="between"><span class="cr-who">${esc(p.nom)} <span class="room-chip sm">${room(p)}</span></span>${prioBtn(p, open)}</div>
    ${open ? levelRow(p) : ''}
    ${body}
  </div>`;
}

export function vTransmissions(S: Ward, U: Ui): string {
  const seg = (k: Ui['trScope'], l: string): string =>
    `<button type="button" class="seg-b ${U.trScope === k ? 'on' : ''}" data-act="trScope" data-arg="${k}" aria-pressed="${U.trScope === k}">${l}</button>`;
  const out = `<button type="button" class="hello-out" data-act="logout">Déconnexion</button>`;
  const head =
    `<div class="tr-top"><h1 class="tr-title">Transmissions</h1>${out}</div>` +
    `<div class="seg" role="group" aria-label="Quels comptes rendus">${seg('mine', 'Mes CR')}${seg('all', 'Tous')}</div>`;
  if (U.trScope === 'mine') {
    const mine = Store.allCr()
      .filter((c) => Store.isMine(c))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return `${head}
    ${mine.length ? `<div class="card cr-list">${mine.map((c) => crItem(c, S)).join('')}</div>` : '<div class="card empty bino-empty"><img src="assets/mascot/mascot-wave.png" width="84" height="84" alt=""><p>Pas encore de compte rendu. Touche un patient dans l\'onglet Patients.</p></div>'}`;
  }
  if (Store.isLoading()) return `${head}<p class="note">Chargement…</p>`;
  const q = (U.trQuery || '').trim();
  const fold = (s: string): string =>
    s.toLocaleLowerCase('fr').normalize('NFD').replace(/\p{M}/gu, '');
  const needle = fold(q);
  const ps = sorted(S.patients, U.trSort).filter((p) =>
    needle ? fold(`${p.nom} ${p.ch} ${p.motif}`).includes(needle) : true,
  );
  return `${head}
  <div class="tr-sort">${sortMenu(TR_SORTS, U.trSort || 'prio', 'trSort', '')}<input id="tr-q" class="tr-q" type="search" placeholder="Patient, chambre" value="${esc(q)}" data-model="trQuery" aria-label="Rechercher un patient"></div>
  ${U.sumBusy ? `<p class="small muted"><span class="spin dark"></span> Mise à jour des résumés ${esc(U.sumBusy)}</p>` : ''}
  ${ps.length ? ps.map((p) => summaryCard(p, U.lvlOpen === p.id)).join('') : '<div class="card empty">Aucun patient pour cette recherche.</div>'}
  <p class="foot">Puces de la plus récente à la plus ancienne ; chacune vient d'un compte rendu (auteur et heure dessous). À relire avant la relève.</p>`;
}
