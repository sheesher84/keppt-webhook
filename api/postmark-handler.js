import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { From, Subject, TextBody, HtmlBody, MessageID } = req.body;
  const body = TextBody || HtmlBody || '';
  const receivedAt = new Date();

  // 1) Parse total_amount with regex and strip "$"
  const rawAmtMatch = /\$[\d,]+\.\d{2}/.exec(body)?.[0] || null;
  const total_amount = rawAmtMatch
    ? parseFloat(rawAmtMatch.replace(/[$,]/g, ''))
    : null;

  // 2) Parse merchant/vendor from body, fallback to sender domain
  const purchaseMatch   = /purchase from\s+([A-Za-z0-9 &]+)/i.exec(body);
  const vendorLineMatch = /Vendor:\s*([^\.\n]+)/i.exec(body);
  const merchant = purchaseMatch
    ? purchaseMatch[1].trim()
    : vendorLineMatch
    ? vendorLineMatch[1].trim()
    : From?.split('@')[1]?.split('.')[0] || null;

  // 3) Parse order_date from body (e.g., "June 11, 2025")
  const dateMatch = /\b([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(body)?.[1] || null;
  const order_date = dateMatch
    ? new Date(dateMatch).toISOString().split('T')[0]
    : null;

  // 4) Default category
  const category = 'Other';

  // 5) Insert into Supabase
  const { error } = await supabase
    .from('receipts')
    .insert([{
      email_sender: From || null,
      subject:      Subject || null,
      body_text:    TextBody || null,
      body_html:    HtmlBody || null,
      total_amount,
      vendor:       merchant,
      vendor_name:  merchant,
      order_date,
      category,
      message_id:   MessageID || null,
      received_at:  receivedAt
    }]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully' });
}
