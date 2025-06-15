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

  // 1) Parse total_amount (allow optional decimals or whole dollars)
  const rawAmtMatch = /\$[\d,]+(?:\.\d{1,2})?/.exec(body)?.[0] || null;
  const total_amount = rawAmtMatch
    ? parseFloat(rawAmtMatch.replace(/[$,]/g, ''))
    : null;

  // 2) Generic vendor detection
  let vendor = null;

  // 2a) Try merchant name in Subject (strip common suffixes)
  if (Subject) {
    const subjMatch = /^(.+?)(?: order| receipt| confirmation| -)/i.exec(Subject);
    if (subjMatch) {
      vendor = subjMatch[1].trim();
    }
  }

  // 2b) Fallback to "purchase from X" in body
  if (!vendor) {
    const purchaseMatch = /purchase from\s+([A-Za-z0-9 &\.]+)/i.exec(body);
    if (purchaseMatch) {
      vendor = purchaseMatch[1].trim();
    }
  }

  // 2c) Fallback to "Vendor: X" in body
  if (!vendor) {
    const vendorLineMatch = /Vendor:\s*([^\.\n]+)/i.exec(body);
    if (vendorLineMatch) {
      vendor = vendorLineMatch[1].trim();
    }
  }

  // 2d) Final fallback: first segment of the From domain
  if (!vendor && From) {
    const domain = From.split('@')[1].toLowerCase();
    vendor = domain.split('.')[0];
  }

  // 3) Parse order_date
  const dateMatch = /\b([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(body)?.[1] || null;
  const order_date = dateMatch
    ? new Date(dateMatch).toISOString().split('T')[0]
    : null;

  // 4) Parse payment info (mask ‘x’ or ‘*’ then 4 digits)
  let form_of_payment = null, card_type = null, card_last4 = null;
  const cardMatch = /([A-Za-z]{2,})\s+[x\*]+(\d{4})/i.exec(body);
  if (cardMatch) {
    const rawType = cardMatch[1];
    if (/^(mc|mastercard)$/i.test(rawType))         card_type = 'MasterCard';
    else if (/^visa$/i.test(rawType))               card_type = 'Visa';
    else if (/^(amex|american express)$/i.test(rawType)) card_type = 'AMEX';
    else                                           card_type = rawType;
    card_last4      = cardMatch[2];
    form_of_payment = 'Card';
  } else if (/cash/i.test(body)) {
    form_of_payment = 'Cash';
  }

  // 5) Determine category via DB lookups only
  let category_name = null;
  let category_id   = null;

  // 5a) Explicit “Category:” header
  const catHdr = /Category:\s*([^\.\n]+)/i.exec(body);
  if (catHdr) {
    category_name = catHdr[1].trim();
    const { data: cat } = await supabase
      .from('categories')
      .select('id')
      .eq('name', category_name)
      .maybeSingle();
    if (cat) category_id = cat.id;
  }

  // 5b) vendor_categories lookup
  if (!category_id && vendor) {
    const { data: vc } = await supabase
      .from('vendor_categories')
      .select('category_id')
      .ilike('vendor_pattern', `%${vendor.toLowerCase()}%`)
      .limit(1)
      .maybeSingle();
    if (vc) {
      category_id = vc.category_id;
      const { data: cat2 } = await supabase
        .from('categories')
        .select('name')
        .eq('id', category_id)
        .maybeSingle();
      category_name = cat2?.name || category_name;
    }
  }

  // 5c) Fallback to “Other”
  if (!category_id) {
    category_name ||= 'Other';
    const { data: other } = await supabase
      .from('categories')
      .select('id')
      .eq('name', 'Other')
      .maybeSingle();
    category_id = other?.id || null;
  }

  // 6) Insert into receipts
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
