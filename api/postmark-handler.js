import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const {
    From,
    Subject,
    TextBody,
    HtmlBody,
    Attachments,
    MessageID,
  } = req.body;

  const receivedAt = new Date();

  // Parse amount and clean "$" for numeric insertion
  const rawAmount = /\$[\d,]+\.\d{2}/.exec(TextBody || HtmlBody || '')?.[0] || null;
  const cleanedAmount = rawAmount ? parseFloat(rawAmount.replace(/[$,]/g, '')) : null;

  const parsedVendor = From?.split('@')[1]?.split('.')[0] || null;

  const { error } = await supabase
    .from('receipts')
    .insert([{
      email_sender: From,
      subject: Subject,
      body_text: TextBody,
      body_html: HtmlBody,
      amount: cleanedAmount,
      vendor: parsedVendor,
      vendor_name: parsedVendor,
      message_id: MessageID,
      received_at: receivedAt,
    }]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully' });
}