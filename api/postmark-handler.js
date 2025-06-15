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
  const body = (TextBody || HtmlBody || '').replace(/\r/g, '');
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

  // 5) Detect Card vs Cash & extract masked-card info
  let form_of_payment = null;
  let card_type        = null;
  let card_last4       = null;

  // a) Try masked-card line, e.g. "VISA xxxxxxxxxx1234" or "MC xxxxxx5678"
  const cardMatch = /([A-Za-z]{2,})\s+x+(\d{4})/i.exec(body);
  if (cardMatch) {
    const rawType = cardMatch[1].toLowerCase();
    // Normalize card type
    if (/^(mc|mastercard)$/i.test(rawType)) {
      card_type = 'MasterCard';
    } else if (/^visa$/i.test(rawType)) {
      card_type = 'Visa';
    } else if (/^(amex|american express)$/i.test(rawType)) {
      card_type = 'AMEX';
    } else {
      // Any other rawType, title-case it
      card_type = rawType[0].toUpperCase() + rawType.slice(1).toLowerCase();
    }
    card_last4      = cardMatch[2];
    form_of_payment = 'Card';
  }

  // b) Fallback: detect cash
  else if (/cash/i.test(body)) {
    form_of_payment = 'Cash';
  }

  // c) No explicit payment found, leave null

  // 6) Lookup category_id from categories table
  let category_id = null;
  {
    const { data: cat } = await supabase
      .from('categories')
      .select('id')
      .eq('name', category_name)
      .maybeSingle();
    if (cat) category_id = cat.id;
  }
  if (!category_id) {
    const { data: otherCat } = await supabase
      .from('categories')
      .select('id')
      .eq('name', 'Other')
      .maybeSingle();
    category_id = otherCat?.id || null;
  }

  // 7) Insert into Supabase
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
