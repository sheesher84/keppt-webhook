import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 1) Pull in both text and HTML, strip tags from HTML, preserve newlines
  const textBody = req.body.TextBody || '';
  const htmlBody = (req.body.HtmlBody || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?[^>]+(>|$)/g, ' ');
  const rawBody = (textBody + '\n' + htmlBody).replace(/\r/g, '\n');
  const lines = rawBody
    .split(/\n/)
    .map(l => l.trim())
    .filter(l => l.length);
  const receivedAt = new Date();

  // 2) Parse total_amount by scanning bottom-up for “Total Tender” or “Total”
  let total_amount = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    let m = ln.match(/^Total Tender[\s:]*\$?([\d,]+(?:\.\d{1,2})?)/i);
    if (m) {
      total_amount = parseFloat(m[1].replace(/,/g, ''));
      break;
    }
    m = ln.match(/^Total[\s:]*\$?([\d,]+(?:\.\d{1,2})?)/i);
    if (m && !/^Total (Tax|Discount)/i.test(ln)) {
      total_amount = parseFloat(m[1].replace(/,/g, ''));
      break;
    }
  }
  if (total_amount === null) {
    // Fallback: last decimal number
    const allNums = rawBody.match(/[\d,]+\.\d{2}/g);
    if (allNums?.length) {
      total_amount = parseFloat(allNums[allNums.length - 1].replace(/,/g, ''));
    }
  }

  // 3) Vendor detection (no hard-codes)
  let vendor = null;
  // 3a) First line, before “-”
  let m = lines[0].match(/^([A-Za-z0-9 &]+)\s*-/);
  if (m) vendor = m[1].trim();
  // 3b) “from X” in subject
  if (!vendor && req.body.Subject) {
    m = req.body.Subject.match(/from\s+([A-Za-z0-9 &]+)/i);
    if (m) vendor = m[1].trim();
  }
  // 3c) “purchase from X” in body
  if (!vendor) {
    m = rawBody.match(/purchase from\s+([A-Za-z0-9 &\.]+)/i);
    if (m) vendor = m[1].trim();
  }
  // 3d) “Vendor: X”
  if (!vendor) {
    m = rawBody.match(/Vendor:\s*([^\.\n]+)/i);
    if (m) vendor = m[1].trim();
  }
  // 3e) <img alt="…">
  if (!vendor && htmlBody) {
    m = htmlBody.match(/<img[^>]+alt="([^"]+)"/i);
    if (m) vendor = m[1].trim();
  }
  // 3f) fallback to second-level domain
  if (!vendor && req.body.From) {
    const parts = req.body.From.split('@')[1].toLowerCase().split('.');
    vendor = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  }

  // 4) Parse order_date (MM/DD/YYYY or “Month D, YYYY”)
  let order_date = null;
  m = rawBody.match(/\b([A-Za-z]+ \d{1,2}, \d{4})\b/);
  if (m) {
    order_date = new Date(m[1]).toISOString().split('T')[0];
  } else {
    m = rawBody.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const [, mm, dd, yyyy] = m;
      order_date = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    }
  }

  // 5) Parse payment info & “contactless” fallback
  let form_of_payment = null, card_type = null, card_last4 = null;
  const clean = rawBody.replace(/&bull;|&#8226;/g, '•');
  // 5a) Look for “Account:” and a card brand
  const acctMatch  = clean.match(/Account:\s*([x\*•\d]+)/i);
  const brandMatch = (clean + ' ' + (req.body.Subject||'')).match(
    /\b(Visa|MasterCard|Amex|American Express)\b/i
  );
  if (acctMatch && brandMatch) {
    form_of_payment = 'Card';
    const rawBrand = brandMatch[1].toLowerCase();
    if (/^(mc|mastercard)$/i.test(rawBrand))       card_type = 'MasterCard';
    else if (/^visa$/i.test(rawBrand))             card_type = 'Visa';
    else if (/^(amex|american express)$/i.test(rawBrand)) card_type = 'AMEX';
    else                                           card_type = brandMatch[1];
    card_last4 = acctMatch[1].replace(/[^0-9]/g, '').slice(-4);
  } else {
    // 5b) Generic masked fallback
    m = clean.match(/([A-Za-z]{2,})\s+[x\*•]+(\d{4})/i);
    if (m) {
      form_of_payment = 'Card';
      const rawBrand = m[1].toLowerCase();
      if (/^(mc|mastercard)$/i.test(rawBrand))       card_type = 'MasterCard';
      else if (/^visa$/i.test(rawBrand))             card_type = 'Visa';
      else if (/^(amex|american express)$/i.test(rawBrand)) card_type = 'AMEX';
      else                                           card_type = m[1];
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

  // 6) Category lookup in your DB
  let category_name = null, category_id = null;
  // 6a) Explicit “Category:” header
  m = rawBody.match(/Category:\s*([^\.\n]+)/i);
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
  // 6c) fallback to “Other”
  if (!category_id) {
    category_name ||= 'Other';
    const { data: other } = await supabase
      .from('categories').select('id').eq('name', 'Other').maybeSingle();
    category_id = other?.id || null;
  }

  // 7) Insert the parsed receipt
  const { error } = await supabase
    .from('receipts')
    .insert([{
      email_sender:  req.body.From     || null,
      subject:       req.body.Subject  || null,
      body_text:     textBody          || null,
      body_html:     htmlBody          || null,
      total_amount,
      vendor,
      vendor_name:   vendor,
      order_date,
      category:      category_name,
      category_id,
      form_of_payment,
      card_type,
      card_last4,
      message_id:    req.body.MessageID || null,
      received_at:   receivedAt
    }]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully' });
}
