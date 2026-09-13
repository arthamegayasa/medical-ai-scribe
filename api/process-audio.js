import { createHandlers } from '../lib/handlers.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
export default async function handler(req, res) {
  return createHandlers().processAudio(req, res);
}
