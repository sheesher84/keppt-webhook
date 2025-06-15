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

  // 1) total_amount
  const rawAmt = /\$[\d,]+\.\d{2}/.exec(body)?.[0] || null;
  const total_amount = rawAmt
    ? parseFloat(rawAmt.replace(/[$,]/g, ''))
    : null;

  // 2) vendor
  const purchaseMatch   = /purchase from\s+([A-Za-z0-9 &]+)/i.exec(body);
  const vendorLineMatch = /Vendor:\s*([^\.\n]+)/i.exec(body);
  const vendor = purchaseMatch
    ? purchaseMatch[1].trim()
    : vendorLineMatch
    ? vendorLineMatch[1].trim()
    : From?.split('@')[1]?.split('.')[0] || null;

  // 3) order_date
  const dateMatch = /\b([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(body)?.[1] || null;
  const order_date = dateMatch
    ? new Date(dateMatch).toISOString().split('T')[0]
    : null;

  // 4) form_of_payment, card_type & card_last4 (as before)
  let form_of_payment = null, card_type = null, card_last4 = null;
  const cardMatch = /([A-Za-z]{2,})\s+x+(\d{4})/i.exec(body);
  if (cardMatch) {
    const rawType = cardMatch[1];
    if (/^(mc|mastercard)$/i.test(rawType))       card_type = 'MasterCard';
    else if (/^visa$/i.test(rawType))             card_type = 'Visa';
    else if (/^(amex|american express)$/i.test(rawType)) card_type = 'AMEX';
    else                                         card_type = rawType;
    card_last4      = cardMatch[2];
    form_of_payment = 'Card';
  } else if (/cash/i.test(body)) {
    form_of_payment = 'Cash';
  }

  // 5) Determine category_id

  // 5a) First, explicit “Category:” line
  let category_name = null;
  const catHdr = /Category:\s*([^\.\n]+)/i.exec(body);
  if (catHdr) {
    category_name = catHdr[1].trim();
  }

  // 5b) Next, try vendor_categories DB lookup
  let category_id = null;
  if (!category_id && vendor) {
    const { data: vc } = await supabase
      .from('vendor_categories')
      .select('category_id')
      .ilike('vendor_pattern', `%${vendor.toLowerCase()}%`)
      .limit(1)
      .single();
    if (vc) {
      category_id = vc.category_id;
      // optionally set category_name via join but this isn't needed for insertion
    }
  }

  // 5c) Next, if we got a category_name from the header but no ID yet, look it up
  if (category_name && !category_id) {
    const { data: cat } = await supabase
      .from('categories')
      .select('id')
      .eq('name', category_name)
      .maybeSingle();
    if (cat) {
      category_id = cat.id;
    }
  }

  // 5d) Fallback to “Other”
  if (!category_id) {
    category_name = category_name || 'Other';
    const { data: other } = await supabase
      .from('categories')
      .select('id')
      .eq('name', 'Other')
      .maybeSingle();
    category_id = other?.id || null;
  }

  // 6) Insert
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
