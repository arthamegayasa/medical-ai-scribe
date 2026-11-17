// The fictional example: a written consultation and a prepared draft, in English and Bahasa
// Indonesia. No real patient is involved and loading it makes no network request.
// Every evidence quote is copied verbatim from the transcript, except the deliberately
// unsupported "no history of diabetes" line, which shows how unverified statements look.
import { buildSource } from './transcript.js';
import { hashText } from '../../../core/text.js';

const EN = {
  turns: [
    ['t1', 'doctor', 4, 'Good morning. What brings you in today?'],
    ['t2', 'patient', 9, 'For about six weeks my right hand goes numb and tingly at night. Mostly the thumb and the next two fingers.'],
    ['t3', 'patient', 21, 'It is worse after a long day of typing. Shaking the hand helps.'],
    ['t4', 'doctor', 32, 'Any neck pain, or dropping things?'],
    ['t5', 'patient', 37, 'No neck pain. I have not dropped anything.'],
    ['t6', 'doctor', 45, 'Are you taking any regular medicines?'],
    ['t7', 'patient', 50, 'Just vitamin D, once a day.'],
    ['t8', 'doctor', 80, 'Tapping over the wrist brings on the tingling, and holding the wrist flexed brings it on in under a minute. Grip strength is normal, and sensation is a little reduced over the index finger.'],
    ['t9', 'doctor', 118, 'This looks most like carpal tunnel syndrome. Let us try a splint at night and arrange a nerve conduction study. Come back in four weeks, or sooner if the hand gets weak.'],
    ['t10', 'patient', 134, 'Okay, thank you.'],
  ],
  note: {
    chief_complaint: [['Night-time numbness and tingling in the right hand for about six weeks.', ['For about six weeks my right hand goes numb and tingly at night']]],
    subjective: [
      ['Symptoms mostly in the thumb and the next two fingers.', ['Mostly the thumb and the next two fingers']],
      ['Worse after prolonged typing; eased by shaking the hand.', ['It is worse after a long day of typing', 'Shaking the hand helps']],
      ['Denies neck pain and dropping objects.', ['No neck pain', 'I have not dropped anything']],
      ['Medication: vitamin D once daily.', ['Just vitamin D, once a day']],
      ['No history of diabetes.', ['I do not have diabetes']],
    ],
    objective: [
      ["Tinel's sign positive at the wrist: tapping brings on the tingling.", ['Tapping over the wrist brings on the tingling']],
      ["Phalen's test positive in under a minute.", ['holding the wrist flexed brings it on in under a minute']],
      ['Grip strength normal.', ['Grip strength is normal']],
      ['Mildly reduced sensation over the index finger.', ['sensation is a little reduced over the index finger']],
    ],
    assessment: [["Clinician's impression: most likely carpal tunnel syndrome.", ['This looks most like carpal tunnel syndrome']]],
    plan: [
      ['Splint at night.', ['try a splint at night']],
      ['Nerve conduction study to be arranged.', ['arrange a nerve conduction study']],
      ['Review in four weeks, or sooner if the hand becomes weak.', ['Come back in four weeks, or sooner if the hand gets weak']],
    ],
    review_flags: [
      ['other', 'Hand dominance was not discussed.', ['my right hand goes numb']],
      ['uncertain_medication', 'The vitamin D dose is not stated.', ['Just vitamin D, once a day']],
      ['unclear', '"No history of diabetes" has no source in the transcript. Confirm it or remove it.', []],
    ],
  },
};

const ID = {
  turns: [
    ['t1', 'doctor', 4, 'Selamat pagi. Ada keluhan apa hari ini?'],
    ['t2', 'patient', 9, 'Sudah sekitar enam minggu tangan kanan saya kesemutan dan baal kalau malam. Terutama jempol dan dua jari sebelahnya.'],
    ['t3', 'patient', 21, 'Lebih parah setelah seharian mengetik. Kalau tangannya dikibaskan, membaik.'],
    ['t4', 'doctor', 32, 'Ada nyeri leher, atau sering menjatuhkan barang?'],
    ['t5', 'patient', 37, 'Leher tidak nyeri. Saya tidak pernah menjatuhkan barang.'],
    ['t6', 'doctor', 45, 'Apakah rutin minum obat?'],
    ['t7', 'patient', 50, 'Hanya vitamin D, sekali sehari.'],
    ['t8', 'doctor', 80, 'Ketukan di pergelangan tangan memicu kesemutan, dan menahan pergelangan dalam posisi tertekuk memicunya dalam waktu kurang dari satu menit. Kekuatan genggaman normal, dan rasa raba sedikit berkurang di jari telunjuk.'],
    ['t9', 'doctor', 118, 'Ini paling mungkin sindrom terowongan karpal. Kita coba bidai saat malam dan jadwalkan pemeriksaan konduksi saraf. Kontrol lagi empat minggu, atau lebih cepat kalau tangannya terasa lemah.'],
    ['t10', 'patient', 134, 'Baik, terima kasih.'],
  ],
  note: {
    chief_complaint: [['Baal dan kesemutan pada tangan kanan saat malam sejak sekitar enam minggu.', ['Sudah sekitar enam minggu tangan kanan saya kesemutan dan baal kalau malam']]],
    subjective: [
      ['Keluhan terutama pada ibu jari dan dua jari di sebelahnya.', ['Terutama jempol dan dua jari sebelahnya']],
      ['Memberat setelah mengetik lama; membaik bila tangan dikibaskan.', ['Lebih parah setelah seharian mengetik', 'Kalau tangannya dikibaskan, membaik']],
      ['Menyangkal nyeri leher dan menjatuhkan barang.', ['Leher tidak nyeri', 'Saya tidak pernah menjatuhkan barang']],
      ['Obat: vitamin D sekali sehari.', ['Hanya vitamin D, sekali sehari']],
      ['Tidak ada riwayat diabetes.', ['Saya tidak punya diabetes']],
    ],
    objective: [
      ['Tanda Tinel positif di pergelangan tangan: ketukan memicu kesemutan.', ['Ketukan di pergelangan tangan memicu kesemutan']],
      ['Tes Phalen positif dalam waktu kurang dari satu menit.', ['menahan pergelangan dalam posisi tertekuk memicunya dalam waktu kurang dari satu menit']],
      ['Kekuatan genggaman normal.', ['Kekuatan genggaman normal']],
      ['Rasa raba sedikit menurun di jari telunjuk.', ['rasa raba sedikit berkurang di jari telunjuk']],
    ],
    assessment: [['Kesan klinisi: paling mungkin sindrom terowongan karpal.', ['Ini paling mungkin sindrom terowongan karpal']]],
    plan: [
      ['Bidai saat malam.', ['Kita coba bidai saat malam']],
      ['Pemeriksaan konduksi saraf akan dijadwalkan.', ['jadwalkan pemeriksaan konduksi saraf']],
      ['Kontrol empat minggu lagi, atau lebih cepat bila tangan terasa lemah.', ['Kontrol lagi empat minggu, atau lebih cepat kalau tangannya terasa lemah']],
    ],
    review_flags: [
      ['other', 'Tangan dominan tidak dibahas.', ['tangan kanan saya kesemutan']],
      ['uncertain_medication', 'Dosis vitamin D tidak disebutkan.', ['Hanya vitamin D, sekali sehari']],
      ['unclear', '"Tidak ada riwayat diabetes" tidak punya sumber di transkrip. Pastikan atau hapus.', []],
    ],
  },
};

export const EXAMPLE_LANGUAGES = Object.freeze(['en', 'id']);
export const EXAMPLE_DURATION_SEC = 134;
export const EXAMPLE_TEMPLATE = 'neurology';
// The deliberately unsupported statement (index into the subjective section).
export const EXAMPLE_UNVERIFIED = Object.freeze({ section: 'subjective', index: 4 });

/** Engine-shaped transcript turns and note for the example in `language`. */
export function exampleData(language = 'en') {
  const data = language === 'id' ? ID : EN;
  const turns = data.turns.map(([id, speaker, start, text]) => ({ id, speaker, text, start, end: null }));
  const note = {};
  for (const [key, rows] of Object.entries(data.note)) {
    note[key] = key === 'review_flags'
      ? rows.map(([type, text, evidence]) => ({ type, text, evidence: [...evidence] }))
      : rows.map(([text, evidence]) => ({ text, evidence: [...evidence] }));
  }
  const source = buildSource(turns, { speakers: true }).text;
  const meta = {
    provider: 'example', model: 'prepared', template: EXAMPLE_TEMPLATE, language: language === 'id' ? 'id' : 'en',
    structuredMode: 'prepared', generatedAt: '2026-11-17T09:00:00.000Z', transcriptHash: hashText(source), draft: true,
  };
  return { turns, note, meta, durationSec: EXAMPLE_DURATION_SEC };
}
