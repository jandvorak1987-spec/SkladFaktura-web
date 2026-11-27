import { handleB2bWebhookRequest } from '../server-lib/b2bWebhook.js';

export default async function handler(req, res) {
  return handleB2bWebhookRequest(req, res);
}
