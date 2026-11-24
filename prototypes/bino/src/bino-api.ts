// Le navigateur ne parle qu'au Worker (/api/bino). Le Worker relaie vers l'API du mini.
import { STAFF } from './auth.js';
import type { Cr, Level, Patient, PrioItem, Snapshot, Synth, Vitals } from './model.js';

const ROOT = '/api/bino';
const LEVEL: Record<string, Level> = {
  rouge: 'critique',
  orange: 'eleve',
  jaune: 'moyen',
  vert: 'stable',
};
const API_LEVEL: Record<Level, string> = {
  critique: 'rouge',
  eleve: 'orange',
  moyen: 'jaune',
  stable: 'vert',
};

const blankVitals: Vitals = {
  fr: 16,
  spo2: 98,
  o2: false,
  pas: 120,
  pad: 70,
  fc: 75,
  temp: 37,
  cons: 'A',
  at: '',
  src: 'absent',
};

type ApiNurse = { id: string; firstName: string; lastName: string; unitId: string };
type ApiSession = { nurses: ApiNurse[]; units: { id: string }[] };
type ApiSummary = {
  id: string;
  room: string;
  displayName: string;
  age: number;
  admissionReason: string;
};
type ApiRow = {
  patient: ApiSummary;
  level: string;
  origin: string;
  reason: string;
};
type ApiTransmission = {
  id: string;
  patientId: string;
  nurseId: string;
  createdAt: string;
  transcript: string;
  review: string;
};
type ApiDetail = {
  history: string;
  allergyStatus: string;
  allergyItems: { text: string }[];
  precautionItems: { text: string }[];
  famille: { text: string }[];
  prescriptions: { text: string }[];
  transmissions: ApiTransmission[];
};
type Sourced = {
  text: string;
  sources: { kind: string; transmissionId: string; quote: string }[];
};
type Sheet = {
  headline: Sourced[];
  targets: { label: string; data: Sourced[]; actions: Sourced[]; results: Sourced[] }[];
  todos: Sourced[];
  sections: { items: Sourced[] }[];
};

export class ApiError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

let session: ApiSession | null = null;
let nurseId: string | null = null;
let patients: Patient[] = [];

export const currentNurseId = (): string | null => nurseId;
export const patientRows = (): Patient[] => patients;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function textOf(v: unknown): string {
  return isRecord(v) && typeof v.text === 'string' ? v.text : '';
}

function texts(items: unknown): string {
  if (!Array.isArray(items)) return '';
  return items.map(textOf).filter(Boolean).join(', ');
}

function messageOf(j: unknown): string {
  if (!isRecord(j)) return '';
  if (typeof j.error === 'string') return j.error;
  if (isRecord(j.error) && typeof j.error.message === 'string') return j.error.message;
  return '';
}

function codeOf(j: unknown): string {
  if (!isRecord(j) || !isRecord(j.error) || typeof j.error.code !== 'string') return '';
  return j.error.code;
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; timeout?: number } = {},
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 8000);
  try {
    const r = await fetch(`${ROOT}${path}`, {
      method: opts.method ?? 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const j: unknown = await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(messageOf(j) || `HTTP ${r.status}`, codeOf(j) || 'api_error');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribe(blob: Blob): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const body = new FormData();
    body.append('audio', blob, 'dictee');
    const r = await fetch(`${ROOT}/transcriptions`, {
      method: 'POST',
      body,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const j: unknown = await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(messageOf(j) || `HTTP ${r.status}`, codeOf(j) || 'api_error');
    return isRecord(j) && typeof j.text === 'string' ? j.text.trim() : '';
  } finally {
    clearTimeout(timer);
  }
}

export async function reachable(): Promise<boolean> {
  try {
    const j = await call('/health');
    return isRecord(j) && j.ok === true;
  } catch {
    return false;
  }
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours()}h${String(d.getMinutes()).padStart(2, '0')}`;
}

function nurseName(id: string): string {
  const n = session?.nurses.find((x) => x.id === id);
  return n ? `${n.firstName} ${n.lastName}` : 'Un soignant';
}

function readSession(v: unknown): ApiSession {
  if (!isRecord(v) || !Array.isArray(v.nurses)) throw new Error('Session illisible');
  const nurses: ApiNurse[] = [];
  for (const item of v.nurses) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.firstName !== 'string')
      continue;
    nurses.push({
      id: item.id,
      firstName: item.firstName,
      lastName: typeof item.lastName === 'string' ? item.lastName : '',
      unitId: typeof item.unitId === 'string' ? item.unitId : '',
    });
  }
  const units: { id: string }[] = [];
  if (Array.isArray(v.units)) {
    for (const item of v.units) {
      if (isRecord(item) && typeof item.id === 'string') units.push({ id: item.id });
    }
  }
  return { nurses, units };
}

function readRows(v: unknown): ApiRow[] {
  if (!Array.isArray(v)) throw new Error('Liste de patients illisible');
  const rows: ApiRow[] = [];
  for (const item of v) {
    if (!isRecord(item) || !isRecord(item.patient)) continue;
    const patient = item.patient;
    const id = patient.id;
    if (typeof id !== 'string') continue;
    const priority = isRecord(item.priority) ? item.priority : {};
    const suggestion = isRecord(priority.suggestion) ? priority.suggestion : {};
    const reasons = Array.isArray(suggestion.reasons) ? suggestion.reasons : [];
    const first = reasons[0];
    rows.push({
      patient: {
        id,
        room: typeof patient.room === 'string' ? patient.room : '',
        displayName: typeof patient.displayName === 'string' ? patient.displayName : '',
        age: typeof patient.age === 'number' ? patient.age : 0,
        admissionReason: typeof patient.admissionReason === 'string' ? patient.admissionReason : '',
      },
      level: typeof priority.level === 'string' ? priority.level : '',
      origin: typeof priority.origin === 'string' ? priority.origin : '',
      reason: isRecord(first) && typeof first.label === 'string' ? first.label : '',
    });
  }
  return rows;
}

function readTransmission(v: unknown): ApiTransmission | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null;
  const dictation = isRecord(v.dictation) ? v.dictation : {};
  const review = isRecord(v.review) ? v.review : {};
  return {
    id: v.id,
    patientId: typeof v.patientId === 'string' ? v.patientId : '',
    nurseId: typeof v.nurseId === 'string' ? v.nurseId : '',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
    transcript: typeof dictation.transcript === 'string' ? dictation.transcript : '',
    review: typeof review.status === 'string' ? review.status : 'draft',
  };
}

function readDetail(v: unknown): ApiDetail | null {
  if (!isRecord(v)) return null;
  const patient = isRecord(v.patient) ? v.patient : {};
  const tr = isRecord(patient.transverse) ? patient.transverse : {};
  const allergies = isRecord(tr.allergies) ? tr.allergies : {};
  const precautions = isRecord(tr.precautions) ? tr.precautions : {};
  const transmissions = Array.isArray(v.transmissions)
    ? v.transmissions.flatMap((item) => {
        const t = readTransmission(item);
        return t ? [t] : [];
      })
    : [];
  return {
    history: typeof patient.history === 'string' ? patient.history : '',
    allergyStatus: typeof allergies.status === 'string' ? allergies.status : '',
    allergyItems: Array.isArray(allergies.items) ? allergies.items.flatMap(textItem) : [],
    precautionItems: Array.isArray(precautions.items) ? precautions.items.flatMap(textItem) : [],
    famille: Array.isArray(tr.famille) ? tr.famille.flatMap(textItem) : [],
    prescriptions: Array.isArray(tr.prescriptions) ? tr.prescriptions.flatMap(textItem) : [],
    transmissions,
  };
}

function textItem(v: unknown): { text: string }[] {
  const text = textOf(v);
  return text ? [{ text }] : [];
}

function readSourced(v: unknown): Sourced | null {
  if (!isRecord(v) || typeof v.text !== 'string' || !v.text) return null;
  const sources: Sourced['sources'] = [];
  if (Array.isArray(v.sources)) {
    for (const s of v.sources) {
      if (!isRecord(s) || s.kind !== 'dictation' || typeof s.transmissionId !== 'string') continue;
      sources.push({
        kind: 'dictation',
        transmissionId: s.transmissionId,
        quote: typeof s.quote === 'string' ? s.quote : '',
      });
    }
  }
  return { text: v.text, sources };
}

function readSourcedList(v: unknown): Sourced[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((item) => {
    const sourced = readSourced(item);
    return sourced ? [sourced] : [];
  });
}

function readSheet(v: unknown): Sheet | null {
  if (!isRecord(v)) return null;
  const targets = Array.isArray(v.targets) ? v.targets : [];
  const sections = Array.isArray(v.sections) ? v.sections : [];
  return {
    headline: readSourcedList(v.headline),
    targets: targets.flatMap((item) => {
      if (!isRecord(item)) return [];
      return [
        {
          label: typeof item.label === 'string' ? item.label : '',
          data: readSourcedList(item.data),
          actions: readSourcedList(item.actions),
          results: readSourcedList(item.results),
        },
      ];
    }),
    todos: readSourcedList(v.todos),
    sections: sections.flatMap((item) => {
      if (!isRecord(item)) return [];
      return [{ items: readSourcedList(item.items) }];
    }),
  };
}

export function nurseForMatricule(matricule: string): ApiNurse | null {
  const staff = STAFF.find((s) => s.matricule === String(matricule || '').replace(/\s/g, ''));
  const first = staff?.name.split(' ')[0]?.toLowerCase();
  if (!first || !session) return null;
  return session.nurses.find((n) => n.firstName.toLowerCase() === first) || null;
}

function pointsFrom(sheet: Sheet | null, crs: Cr[]): Synth['points'] {
  if (!sheet) return crs.map((c) => ({ t: c.text, src: [{ cr: c.id, q: c.text }] }));
  const fromItem = (item: Sourced) => ({
    t: item.text,
    src: item.sources.map((s) => ({ cr: s.transmissionId, q: s.quote })),
  });
  const points = sheet.headline.map(fromItem);
  for (const target of sheet.targets) {
    const bits = [...target.data, ...target.actions, ...target.results];
    if (!bits.length) continue;
    points.push({
      t: `${target.label} : ${bits.map((b) => b.text).join(' ')}`,
      src: bits.flatMap((b) => fromItem(b).src),
    });
  }
  for (const todo of sheet.todos) points.push(fromItem(todo));
  for (const section of sheet.sections) {
    for (const item of section.items) points.push(fromItem(item));
  }
  const seen = new Set<string>();
  const unique = points.filter((p) => {
    const key = p.t.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length ? unique : crs.map((c) => ({ t: c.text, src: [{ cr: c.id, q: c.text }] }));
}

function toPatient(detail: ApiDetail | null, row: ApiRow): Patient {
  const allergies =
    detail?.allergyStatus === 'aucune'
      ? 'Aucune connue'
      : texts(detail?.allergyItems) || 'Non renseigné';
  const rx = detail?.prescriptions[0];
  return {
    id: row.patient.id,
    ch: row.patient.room,
    nom: row.patient.displayName,
    age: row.patient.age,
    motif: row.patient.admissionReason,
    atcd: detail?.history || 'Aucun',
    allergies,
    precautions: texts(detail?.precautionItems),
    famille: texts(detail?.famille),
    taches: [],
    disp: [],
    rx: rx ? { t: rx.text, at: '' } : null,
    v: blankVitals,
  };
}

function toCr(t: ApiTransmission): Cr {
  return {
    id: t.id,
    pid: t.patientId,
    text: t.transcript,
    at: t.createdAt,
    t: hhmm(t.createdAt),
    byName: nurseName(t.nurseId),
    nurseId: t.nurseId,
    review: t.review || 'draft',
  };
}

export async function refresh(matricule: string): Promise<Snapshot> {
  session = readSession(await call('/session'));
  const nurse = nurseForMatricule(matricule);
  nurseId = nurse?.id || null;
  const unitId = nurse?.unitId || session.units[0]?.id;
  if (!unitId) throw new Error('Aucun service');
  const rows = readRows(await call(`/units/${unitId}/patients`));
  const details = await Promise.all(
    rows.map((row) => call(`/patients/${row.patient.id}`).catch(() => null)),
  );
  const sheets = await Promise.all(
    rows.map((row) => call(`/patients/${row.patient.id}/handover`).catch(() => null)),
  );
  const cr: Cr[] = [];
  const syn: Record<string, Synth> = {};
  const manual: Record<string, string> = {};
  const order: PrioItem[] = [];
  patients = rows.map((row, i) => {
    const detail = readDetail(details[i]);
    for (const t of detail?.transmissions || []) {
      if (t.patientId) cr.push(toCr(t));
    }
    const mine = cr.filter((c) => c.pid === row.patient.id);
    const level = LEVEL[row.level] || 'moyen';
    if (row.origin === 'manuelle') manual[row.patient.id] = level;
    order.push({ id: row.patient.id, level, raison: row.reason });
    syn[row.patient.id] = {
      points: pointsFrom(readSheet(sheets[i]), mine),
      resume: null,
      cibles: [],
      todo: [],
      soins: [],
      engine: 'ai',
      ver: 2,
      crIds: mine.map((c) => c.id),
      at: new Date().toISOString(),
      t: hhmm(new Date().toISOString()),
    };
    return toPatient(detail, row);
  });
  return { cr, syn, prio: { ai: { order, engine: 'ai', sig: 'api' }, manual } };
}

export async function addCr(patientId: string, text: string, matricule: string): Promise<void> {
  const nurse = nurseForMatricule(matricule);
  if (!nurse) throw new Error('Soignant inconnu de l’API');
  await call('/transmissions', {
    method: 'POST',
    timeout: 60000,
    body: {
      unitId: nurse.unitId,
      nurseId: nurse.id,
      patientId,
      transcript: text,
      mode: 'transmission',
      inputMethod: 'keyboard',
    },
  });
}

export async function setLevel(
  patientId: string,
  level: Level | null,
  matricule: string,
): Promise<void> {
  const nurse = nurseForMatricule(matricule);
  if (!nurse) throw new Error('Soignant inconnu de l’API');
  await call(`/patients/${patientId}/priority`, {
    method: 'PATCH',
    body: { nurseId: nurse.id, manualLevel: level ? API_LEVEL[level] : null },
  });
}

export async function reviewMine(crs: Cr[], matricule: string): Promise<number> {
  const nurse = nurseForMatricule(matricule);
  if (!nurse) return 0;
  const mine = crs.filter((c) => !c.pending && c.nurseId === nurse.id && c.review === 'draft');
  for (const c of mine) {
    await call(`/transmissions/${c.id}/review`, {
      method: 'POST',
      body: { nurseId: nurse.id, decision: 'validate' },
    });
  }
  return mine.length;
}
