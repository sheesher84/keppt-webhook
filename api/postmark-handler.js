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

  // 1) Parse total_amount
  const rawAmtMatch = /\$[\d,]+\.\d{2}/.exec(body)?.[0] || null;
  const total_amount = rawAmtMatch
    ? parseFloat(rawAmtMatch.replace(/[$,]/g, ''))
    : null;

  // 2) Parse merchant/vendor
  const purchaseMatch   = /purchase from\s+([A-Za-z0-9 &]+)/i.exec(body);
  const vendorLineMatch = /Vendor:\s*([^\.\n]+)/i.exec(body);
  const vendor = purchaseMatch
    ? purchaseMatch[1].trim()
    : vendorLineMatch
    ? vendorLineMatch[1].trim()
    : From?.split('@')[1]?.split('.')[0] || null;

  // 3) Parse order_date
  const dateMatch = /\b([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(body)?.[1] || null;
  const order_date = dateMatch
    ? new Date(dateMatch).toISOString().split('T')[0]
    : null;

  // 4) Parse category name (fallback to 'Other')
  const categoryLineMatch = /Category:\s*([^\.\n]+)/i.exec(body);
  const category_name = categoryLineMatch
    ? categoryLineMatch[1].trim()
    : 'Other';

  // 5) Parse form of payment
  const paymentMatch = /Payment Method[:\-]?\s*([A-Za-z &]+)/i.exec(body);
  const form_of_payment = paymentMatch
    ? paymentMatch[1].trim()
    : null;

  // 6) Parse card type (Visa, Mastercard, AMEX)
  const cardTypeMatch = /\b(Visa|Mastercard|AMEX|American Express)\b/i.exec(body);
  const card_type = cardTypeMatch
    ? cardTypeMatch[1].trim()
    : null;

  // 7) Parse last 4 digits
  const last4Match = /(ending in|last 4)[^\d]*(\d{4})/i.exec(body);
  const card_last4 = last4Match
    ? last4Match[2]
    : null;

  // 8) Lookup category_id from categories table
  let category_id = null;
  if (category_name) {
    const { data: cat, error: catErr } = await supabase
      .from('categories')
      .select('id')
      .eq('name', category_name)
      .maybeSingle();
    if (cat) category_id = cat.id;
  }
  // fallback to 'Other' category id
  if (!category_id) {
    const { data: otherCat } = await supabase
      .from('categories')
      .select('id')
      .eq('name', 'Other')
      .maybeSingle();
    category_id = otherCat?.id || null;
  }

  // 9) Insert into Supabase
  const { error } = await supabase
    .from('receipts')
    .insert([{
      email_sender:   From || null,
      subject:        Subject || null,
      body_text:      TextBody || null,
      body_html:      HtmlBody || null,
      total_amount,
      vendor,
      vendor_name:    vendor,
      order_date,
      category:       category_name,
      category_id,
      form_of_payment,
      card_type,
      card_last4,
      message_id:     MessageID || null,
      received_at:    receivedAt
    }]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully' });
}

