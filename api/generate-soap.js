import { createHandlers } from '../lib/handlers.js';

export const config = { api: { bodyParser: { sizeLimit: '128kb' } } };
export default async function handler(req, res) {
  return createHandlers().generateSoap(req, res);
}
