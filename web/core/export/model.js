import { invalidInput } from '../errors.js';
import { SECTIONS, validateNote } from '../soap/schema.js';
import { TEMPLATES, LANGUAGES } from '../soap/prompt.js';

const LABELS = {
  en: {
    title: 'SOAP note (draft)', flags: 'Items for clinician review', provenance: 'Provenance', noFlags: 'None reported.',
    sections: { chief_complaint: 'Chief complaint', subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan' },
    draft: 'DRAFT - requires clinician review before use. This is not a diagnosis or a treatment recommendation.',
    fictional: 'FICTIONAL SAMPLE - not real patient data.',
    changed: 'WARNING: the transcript was edited after this draft was generated. Regenerate or re-check the note before use.',
    unverified: count => `${count} statement(s) could not be matched to the transcript and are marked [UNVERIFIED].`,
    approximate: count => `${count} statement(s) only closely match the transcript and are marked [CLOSE MATCH - CHECK WORDING]. Check their wording against the transcript.`,
    edited: count => `${count} statement(s) were edited after verification and are marked [EDITED - RE-CHECK AGAINST TRANSCRIPT].`,
    notVerified: 'Evidence has not been verified against the transcript.',
    fields: ['Provider', 'Model', 'Template', 'Output language', 'Generated'],
    unverifiedMark: '[UNVERIFIED]', approximateMark: '[CLOSE MATCH - CHECK WORDING]', editedMark: '[EDITED - RE-CHECK AGAINST TRANSCRIPT]',
    clinicianMark: '[CLINICIAN-ENTERED]', numberMark: 'CHECK NUMBER',
  },
  id: {
    title: 'Catatan SOAP (draf)', flags: 'Hal yang perlu ditinjau klinisi', provenance: 'Asal-usul', noFlags: 'Tidak ada.',
    sections: { chief_complaint: 'Keluhan utama', subjective: 'Subjektif', objective: 'Objektif', assessment: 'Asesmen', plan: 'Rencana' },
    draft: 'DRAF - wajib ditinjau klinisi sebelum digunakan. Ini bukan diagnosis atau rekomendasi terapi.',
    fictional: 'CONTOH FIKTIF - bukan data pasien nyata.',
    changed: 'PERINGATAN: transkrip diubah setelah draf ini dibuat. Buat ulang atau periksa kembali catatan sebelum digunakan.',
    unverified: count => `${count} pernyataan tidak dapat dicocokkan dengan transkrip dan ditandai [TIDAK TERVERIFIKASI].`,
    approximate: count => `${count} pernyataan hanya mirip dengan transkrip dan ditandai [MIRIP - PERIKSA KATA-KATA]. Periksa kata-katanya terhadap transkrip.`,
    edited: count => `${count} pernyataan diedit setelah verifikasi dan ditandai [DIEDIT - PERIKSA ULANG DENGAN TRANSKRIP].`,
    notVerified: 'Bukti belum diverifikasi terhadap transkrip.',
    fields: ['Penyedia', 'Model', 'Templat', 'Bahasa keluaran', 'Dibuat'],
    unverifiedMark: '[TIDAK TERVERIFIKASI]', approximateMark: '[MIRIP - PERIKSA KATA-KATA]', editedMark: '[DIEDIT - PERIKSA ULANG DENGAN TRANSKRIP]',
    clinicianMark: '[DITULIS KLINISI]', numberMark: 'PERIKSA ANGKA',
  },
};

// Every status other than grounded and not_documented gets a visible marker. "clinician" is not a
// failed check: it says who wrote the line (the export renders it like the other markers).
const STATUS_MARKS = { unverified: 'unverifiedMark', approximate: 'approximateMark', edited: 'editedMark', clinician: 'clinicianMark' };

function marks(result, labels) {
  if (!result) return [];
  const list = STATUS_MARKS[result.status] ? [labels[STATUS_MARKS[result.status]]] : [];
  for (const number of result.numbers ?? []) if (!number.found) list.push(`[${labels.numberMark}: ${number.text}]`);
  return list;
}

/**
 * Normalises export input into a renderer-neutral model so every format carries the same labels.
 * @param {{ note: object, meta: object, verification?: object, transcriptChanged?: boolean, fictional?: boolean }} input
 */
export function buildExportModel({ note, meta, verification, transcriptChanged = false, fictional = false }) {
  const valid = validateNote(note);
  if (!meta || typeof meta !== 'object') throw invalidInput('Export needs the generation metadata (meta).');
  const labels = LABELS[meta.language] ?? LABELS.en;
  const banners = [labels.draft];
  if (fictional) banners.push(labels.fictional);
  if (transcriptChanged) banners.push(labels.changed);
  if (!verification) banners.push(labels.notVerified);
  else {
    // Counted from the per-statement results, so statuses assigned after verifyNote (edited,
    // clinician) are always reflected.
    const all = SECTIONS.flatMap(key => verification.sections?.[key] ?? []);
    for (const status of ['unverified', 'approximate', 'edited']) {
      const count = all.filter(item => item?.status === status).length;
      if (count) banners.push(labels[status](count));
    }
  }
  const sections = SECTIONS.map(key => ({
    title: labels.sections[key],
    items: valid[key].map((item, i) => ({ text: item.text, marks: marks(verification?.sections?.[key]?.[i], labels) })),
  }));
  const flags = valid.review_flags.map((item, i) => ({ text: item.text, type: item.type, evidence: item.evidence, marks: marks(verification?.review_flags?.[i], labels) }));
  const values = [meta.provider, meta.model, TEMPLATES[meta.template]?.label ?? meta.template, LANGUAGES[meta.language]?.label ?? meta.language, meta.generatedAt];
  return {
    title: labels.title, banners, sections, flags, flagsTitle: labels.flags, noFlags: labels.noFlags, provenanceTitle: labels.provenance,
    provenance: labels.fields.map((label, i) => [label, String(values[i] ?? '')]),
  };
}

export const itemLine = item => [item.text, ...item.marks].join(' ');
export const flagLine = item => [`(${item.type.replace(/_/g, ' ')})`, item.text, ...item.evidence.map(q => `"${q}"`), ...item.marks].join(' ');
