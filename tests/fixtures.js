// Fictional data only. Never place real patient information in tests.
export const ND = 'Not documented in this encounter.';
export const TRANSCRIPT = 'Fictional sample. I have had a headache for three days. I take paracetamol 500 mg.';
export const NOTE = Object.freeze({
  chief_complaint: [{ text: 'Headache for three days.', evidence: ['headache for three days'] }],
  subjective: [{ text: 'Takes paracetamol 500 mg.', evidence: ['paracetamol 500 mg'] }],
  objective: [{ text: ND, evidence: [] }],
  assessment: [{ text: ND, evidence: [] }],
  plan: [{ text: ND, evidence: [] }],
  review_flags: [],
});

export function openaiReply(value) {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
}

export function sseResponse(lines) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const line of lines) controller.enqueue(encoder.encode(line)); controller.close(); } }));
}
