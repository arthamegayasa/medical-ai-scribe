import { createHandlers } from '../lib/handlers.js';

export default async function handler(req, res) {
  return createHandlers().config(req, res);
}
