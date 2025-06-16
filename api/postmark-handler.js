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

  // 1) Normalize bodies & collapse whitespace
  const raw = (TextBody || HtmlBody || '').replace(/\r/g, ' ');
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const receivedAt = new Date();

  //
  // 2) Parse total_amount
  //
  let total_amount = null;

  // 2a) Try “Total Tender”
  let m = /Total Tender\s*\$?([\d,]+(?:\.\d{1,2})?)/i.exec(normalized);
  if (m) {
    total_amount = parseFloat(m[1].replace(/,/g, ''));
  } else {
    // 2b) Try “Total” (but not Discount or Tax)
    m = /(?:^| )Total\s+([\d,]+(?:\.\d{1,2})?)(?: |$)/i.exec(normalized);
    if (m) {
      total_amount = parseFloat(m[1].replace(/,/g, ''));
    }
  }

  //
  // 3) Generic vendor extraction
  //
  let vendor = null;

  // 3a) First line before “-” (hyphen-minus) in raw text
  const firstLine = (TextBody || HtmlBody || '').split('\n')[0] || '';
  m = /^([A-Za-z0-9 &]+)\s*-/ .exec(firstLine);
  if (m) {
    vendor = m[1].trim();
  }

  // 3b) “from X” in Subject
  if (!vendor && Subject) {
    m = /from\s+([A-Za-z0-9 &]+)/i.exec(Subject);
    if (m) vendor = m[1].trim();
  }

  // 3c) “purchase from X” in normalized body
  if (!vendor) {
    m = /purchase from\s+([A-Za-z0-9 &\.]+)/i.exec(normalized);
    if (m) vendor = m[1].trim();
  }

  // 3d) “Vendor: X” in normalized body
  if (!vendor) {
    m = /Vendor:\s*([^\.\n]+)/i.exec(normalized);
    if (m) vendor = m[1].trim();
  }

  // 3e) <img alt="…"> in HTML
  if (!vendor && HtmlBody) {
    m = /<img[^>]+alt="([^"]+)"/i.exec(HtmlBody);
    if (m) vendor = m[1].trim();
  }

  // 3f) Fallback to second-level domain
  if (!vendor && From) {
    const parts = From.split('@')[1].toLowerCase().split('.');
    vendor = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  }

  //
  // 4) Parse order_date
  //
  let order_date = null;
  m = /\b([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(normalized);
  if (m) {
    order_date = new Date(m[1]).toISOString().split('T')[0];
  } else {
    m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(normalized);
    if (m) {
      const [, mm, dd, yyyy] = m;
      order_date = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
  }

  //
  // 5) Parse payment info & detect “contactless”
  //
  let form_of_payment = null, card_type = null, card_last4 = null;
  const clean = normalized.replace(/&bull;|&#8226;/g, '•');

  // 5a) Brand + “Account: xxxx1234”
  const acct = /Account:\s*([x\*•\d]+)/i.exec(clean);
  const brand = /\b(Visa|MasterCard|AMEX|American Express)\b/i.exec(clean + ' ' + (Subject || ''));
  if (acct && brand) {
    form_of_payment = 'Card';
    const raw = brand[1];
    if (/^(mc|mastercard)$/i.test(raw))       card_type = 'MasterCard';
    else if (/^visa$/i.test(raw))             card_type = 'Visa';
    else if (/^(amex|american express)$/i.test(raw)) card_type = 'AMEX';
    else                                       card_type = raw;
    card_last4 = acct[1].replace(/[^0-9]/g, '').slice(-4);
  }
  // 5b) Fallback generic masked
  else {
    m = /([A-Za-z]{2,})\s+[x\*•]+(\d{4})/i.exec(clean);
    if (m) {
      form_of_payment = 'Card';
      const raw = m[1];
      if (/^(mc|mastercard)$/i.test(raw))       card_type = 'MasterCard';
      else if (/^visa$/i.test(raw))             card_type = 'Visa';
      else if (/^(amex|american express)$/i.test(raw)) card_type = 'AMEX';
      else                                       card_type = raw;
      card_last4 = m[2];
    }
    // 5c) “contactless” implies card
    else if (/contactless/i.test(clean)) {
      form_of_payment = 'Card';
    }
    // 5d) cash
    else if (/cash/i.test(clean)) {
      form_of_payment = 'Cash';
    }
  }

  //
  // 6) Lookup category entirely in DB
  //
  let category_name = null, category_id = null;

  // 6a) Explicit “Category:” header
  m = /Category:\s*([^\.\n]+)/i.exec(normalized);
  if (m) {
    category_name = m[1].trim();
    const { data: cat } = await supabase
      .from('categories').select('id').eq('name', category_name).maybeSingle();
    if (cat) category_id = cat.id;
  }

  // 6b) vendor_categories mapping
  if (!category_id && vendor) {
    const { data: vc } = await supabase
      .from('vendor_categories')
      .select('category_id')
      .ilike('vendor_pattern', `%${vendor.toLowerCase()}%`)
      .limit(1).maybeSingle();
    if (vc) {
      category_id = vc.category_id;
      const { data: cat2 } = await supabase
        .from('categories').select('name').eq('id', category_id).maybeSingle();
      if (cat2) category_name = cat2.name;
    }
  }

  // 6c) Default to “Other”
  if (!category_id) {
    category_name ||= 'Other';
    const { data: other } = await supabase
      .from('categories').select('id').eq('name', 'Other').maybeSingle();
    category_id = other?.id || null;
  }

  //
  // 7) Insert receipt
  //
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
