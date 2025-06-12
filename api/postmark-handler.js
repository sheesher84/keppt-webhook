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

  // Extract dollar amount like "$67.89"
  const rawAmountMatch = /\$[\d,]+\.\d{2}/.exec(TextBody || HtmlBody || '');
  const parsedAmount = rawAmountMatch
    ? rawAmountMatch[0].replace(/[^0-9.]/g, '') // "67.89"
    : null;

  // Parse vendor from email
  const parsedVendor = From?.split('@')[1]?.split('.')[0] || null;

  const { error } = await supabase
    .from('receipts')
    .insert([{
      email_sender: From || null,
      subject: Subject || null,
      body_text: TextBody || null,
      body_html: HtmlBody || null,
      total_amount: parsedAmount ? parseFloat(parsedAmount) : null,
      vendor: parsedVendor,              // Kept for backward compatibility
      vendor_name: parsedVendor,         // Preferred field name
      message_id: MessageID || null,
      received_at: receivedAt,
    }]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully' });
}

}