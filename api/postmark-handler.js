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

  // 1) Parse and clean the amount (strip "$" for numeric)
  const rawAmount = /\$[\d,]+\.\d{2}/.exec(TextBody || HtmlBody || '')?.[0] || null;
  const cleanedAmount = rawAmount
    ? parseFloat(rawAmount.replace(/[$,]/g, ''))
    : null;

  // 2) Improved vendor parsing from the email body
  let parsedVendor = null;
  const body = TextBody || HtmlBody || '';
  const purchaseMatch = /purchase from\s+([A-Za-z0-9 &]+)/i.exec(body);
  const vendorLineMatch = /Vendor:\s*([^\.\n]+)/i.exec(body);
  if (purchaseMatch) {
    parsedVendor = purchaseMatch[1].trim();
  } else if (vendorLineMatch) {
    parsedVendor = vendorLineMatch[1].trim();
  } else {
    parsedVendor = From?.split('@')[1]?.split('.')[0] || null;
  }

  // 3) Insert into Supabase
  const { error } = await supabase
    .from('receipts')
    .insert([{
      email_sender: From || null,
      subject: Subject || null,
      body_text: TextBody || null,
      body_html: HtmlBody || null,
      total_amount: cleanedAmount,
      vendor: parsedVendor,
      vendor_name: parsedVendor,
      message_id: MessageID || null,
      received_at: receivedAt,
    }]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully' });
}
