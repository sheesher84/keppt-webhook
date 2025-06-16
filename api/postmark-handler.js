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
  const rawBody    = TextBody || HtmlBody || '';             // preserve newlines
  const html       = HtmlBody || '';
  const text       = TextBody || '';
  const normalized = (text || html).replace(/\s+/g, ' ').trim();
  const receivedAt = new Date();

  //
  // 1) Parse total_amount from rawBody (with newlines)
  //
  let total_amount = null;
  let m = /^Total Tender\s*\$?([\d,]+(?:\.\d{1,2})?)/im.exec(rawBody);
  if (m) {
    total_amount = parseFloat(m[1].replace(/,/g, ''));
  } else {
    m = /^Total\s+(?!Tax|Discount)\$?([\d,]+(?:\.\d{1,2})?)/im.exec(rawBody);
    if (m) {
      total_amount = parseFloat(m[1].replace(/,/g, ''));
    } else {
      const all = rawBody.match(/\$[\d,]+(?:\.\d{1,2})?/g);
      if (all && all.length) {
        total_amount = parseFloat(all[all.length - 1].replace(/[$,]/g, ''));
      }
    }
  }

  //
  // 2) Generic vendor detection
  //
  let vendor = null;

  // 2a) First line before “-”
  const firstLine = rawBody.split('\n')[0] || '';
  m = /^([A-Za-z0-9 &]+)\s*-/ .exec(firstLine);
  if (m) vendor = m[1].trim();

  // 2b) “from X” in Subject
  if (!vendor && Subject) {
    m = /from\s+([A-Za-z0-9 &]+)/i.exec(Subject);
    if (m) vendor = m[1].trim();
  }

  // 2c) “purchase from X” in normalized body
  if (!vendor) {
    m = /purchase from\s+([A-Za-z0-9 &\.]+)/i.exec(normalized);
    if (m) vendor = m[1].trim();
  }

  // 2d) “Vendor: X” in normalized body
  if (!vendor) {
    m = /Vendor:\s*([^\.\n]+)/i.exec(normalized);
    if (m) vendor = m[1].trim();
  }

  // 2e) <img alt="…"> in HTML
  if (!vendor && html) {
    m = /<img[^>]+alt="([^"]+)"/i.exec(html);
    if (m) vendor = m[1].trim();
  }

  // 2f) Fallback to second-level domain
  if (!vendor && From) {
    const parts = From.split('@')[1].toLowerCase().split('.');
    vendor = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  }

  //
  // 3) Parse order_date
  //
  let order_date = null;
  m = /\b([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(rawBody);
  if (m) {
    order_date = new Date(m[1]).toISOString().split('T')[0];
  } else {
    m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(rawBody);
    if (m) {
      const [, mm, dd, yyyy] = m;
      order_date = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
  }

  //
  // 4) Parse payment info & “contactless” fallback
  //
  let form_of_payment = null, card_type = null, card_last4 = null;
  const clean = normalized.replace(/&bull;|&#8226;/g, '•');

  // 4a) Brand + “Account:”
  const acct  = /Account:\s*([x\*•\d]+)/i.exec(clean);
  const brand = /\b(Visa|MasterCard|AMEX|American Express)\b/i.exec(clean + ' ' + (Subject || ''));
  if (acct && brand) {
    form_of_payment = 'Card';
    const raw = brand[1];
    if (/^(mc|mastercard)$/i.test(raw))       card_type = 'MasterCard';
    else if (/^visa$/i.test(raw))             card_type = 'Visa';
    else if (/^(amex|american express)$/i.test(raw)) card_type = 'AMEX';
    else                                       card_type = raw;
    card_last4 = acct[1].replace(/[^0-9]/g, '').slice(-4);
  } else {
    // 4b) Generic masked pattern
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
    // 4c) “contactless” implies card
    else if (/contactless/i.test(clean)) {
      form_of_payment = 'Card';
    }
    // 4d) Cash
    else if (/cash/i.test(clean)) {
      form_of_payment = 'Cash';
    }
  }

  //
  // 5) Category lookup via DB only
  //
  let category_name = null, category_id = null;

  // 5a) Explicit “Category:” header
  m = /Category:\s*([^\.\n]+)/i.exec(normalized);
  if (m) {
    category_name = m[1].trim();
    const { data: cat } = await supabase
      .from('categories').select('id').eq('name', category_name).maybeSingle();
    if (cat) category_id = cat.id;
  }

  // 5b) vendor_categories mapping
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

  // 5c) Fallback to “Other”
  if (!category_id) {
    category_name ||= 'Other';
    const { data: other } = await supabase
      .from('categories').select('id').eq('name', 'Other').maybeSingle();
    category_id = other?.id || null;
  }

  //
  // 6) Insert into receipts
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
