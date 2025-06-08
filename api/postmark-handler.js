import express from 'express';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const app = express();
app.use(bodyParser.json());

// Initialize Supabase
const supabase = createClient('https://YOUR_PROJECT.supabase.co', 'YOUR_SERVICE_ROLE_KEY');

app.post('/webhook/postmark', async (req, res) => {
  const data = req.body;

  const {
    From,
    Subject,
    TextBody,
    HtmlBody,
    Attachments,
    MessageID,
  } = data;

  const receivedAt = new Date();

  // Very basic receipt parsing — we'll enhance this with GPT later
  const parsedAmount = /\$[\d,]+\.\d{2}/.exec(TextBody || HtmlBody || '')?.[0];
  const parsedVendor = From.split('@')[1]?.split('.')[0];

  const { data: insertResult, error } = await supabase
    .from('receipts')
    .insert([{
      email_sender: From,
      subject: Subject,
      body_text: TextBody,
      body_html: HtmlBody,
      amount: parsedAmount,
      vendor: parsedVendor,
      message_id: MessageID,
      received_at: receivedAt,
    }]);

  if (error) {
    console.error('Insert error:', error);
    return res.status(500).send('Supabase error');
  }

  res.status(200).send('OK');
});

// Export for deployment (Vercel)
export default app;
