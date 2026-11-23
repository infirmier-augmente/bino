// Le site public et le site local partagent le scénario de réanimation (/api/bino).
import * as Bino from './bino-api.js';
import type { Cr, Level, Patient, PrioState, Synth, Vitals } from './model.js';
import { settings } from './settings.js';

const cache: {
  cr: Cr[];
  syn: Record<string, Synth>;
  vit: Record<string, Vitals>;
  prio: PrioState;
} = {
  cr: [],
  syn: {},
  vit: {},
  prio: { ai: null, manual: {} },
};
const listeners: Array<() => void> = [];
let loading = true;
let stale = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let apiPatients: Patient[] | null = null;

export const onChange = (fn: () => void): void => {
  listeners.push(fn);
};
const emit = (): void => {
  for (const fn of listeners) fn();
};

function sameNote(a: Cr, b: Cr): boolean {
  return a.pid === b.pid && a.text === b.text;
}

async function refreshBino(): Promise<void> {
  const snap = await Bino.refresh(settings.matricule);
  // Une note validée reste affichée tant que l'API ne la renvoie pas.
  const pending = cache.cr.filter((c) => c.pending && !snap.cr.some((saved) => sameNote(saved, c)));
  cache.cr = snap.cr.concat(pending);
  cache.syn = snap.syn;
  cache.vit = {};
  cache.prio = snap.prio;
  apiPatients = Bino.patientRows();
  stale = false;
  loading = false;
  emit();
}

export const refresh = (): Promise<void> => refreshBino();

export async function init(): Promise<void> {
  loading = true;
  emit();
  if (!(await Bino.reachable())) {
    loading = false;
    stale = true;
    emit();
    return;
  }
  try {
    await refreshBino();
  } catch {
    stale = true;
    loading = false;
    emit();
  }
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden) refreshBino().catch(() => undefined);
  }, 15000);
}

export const storeMode = (): string => 'api';
export const isLoading = (): boolean => loading;
export const isStale = (): boolean => stale;
const byTime = (a: Cr, b: Cr): number => Date.parse(a.at) - Date.parse(b.at);
export const crFor = (pid: string): Cr[] => cache.cr.filter((c) => c.pid === pid).sort(byTime);
export const allCr = (): Cr[] => cache.cr;
export const synthFor = (pid: string): Synth | null => cache.syn[pid] ?? null;
export const vitalsFor = (pid: string): Vitals | null => cache.vit[pid] ?? null;
export const needsSynth = (): boolean => false;
function firstOf(name: string): string {
  return name.trim().split(/\s+/)[0]?.toLocaleLowerCase('fr') || '';
}
// Le prénom suffit : « Martine Dubois » à l'écran, « Martine Roux » dans l'API.
export const isMine = (c: Cr): boolean => {
  const mine = firstOf(settings.name);
  return mine !== '' && firstOf(c.byName) === mine;
};
export const myName = (): string => settings.name.trim();
export const displayName = (): string => myName();
export const authorOf = (c: Cr): string => c.byName || 'Un soignant';
export const patientRows = (): Patient[] | null => apiPatients;

export async function addCr(pid: string, text: string): Promise<void> {
  const pending: Cr = {
    id: `pending-${Date.now()}`,
    pid,
    text,
    at: new Date().toISOString(),
    t: '',
    byName: myName(),
    nurseId: Bino.currentNurseId() ?? '',
    review: 'draft',
    pending: true,
  };
  cache.cr = [...cache.cr, pending];
  emit();
  try {
    await Bino.addCr(pid, text, settings.matricule);
  } catch (error) {
    cache.cr = cache.cr.filter((c) => c.id !== pending.id);
    emit();
    throw error;
  }
  try {
    await refreshBino();
  } catch {
    stale = true;
    emit();
  }
}

export async function reviewMine(): Promise<number> {
  const reviewed = await Bino.reviewMine(cache.cr, settings.matricule);
  try {
    await refreshBino();
  } catch {
    stale = true;
    loading = false;
    emit();
  }
  return reviewed;
}

export async function setManualLevel(pid: string, level: Level | null): Promise<void> {
  await Bino.setLevel(pid, level, settings.matricule);
  await refreshBino();
}

export async function saveVitals(pid: string, v: Vitals): Promise<void> {
  cache.vit[pid] = v;
  emit();
}

export const prioAI = (): PrioState['ai'] => cache.prio.ai;
export const manualLevels = (): Record<string, string> => cache.prio.manual;
