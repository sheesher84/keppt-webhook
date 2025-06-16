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
  // combine & normalize bodies
  const html      = HtmlBody || '';
  const text      = TextBody || '';
  const body      = (text || html).replace(/\r/g, '');
  const receivedAt = new Date();

  //
  // 1) Parse total_amount (handles $95 or $95.00)
  //
  const rawAmt = /\$[\d,]+(?:\.\d{2})?/.exec(body)?.[0] || null;
  const total_amount = rawAmt
    ? parseFloat(rawAmt.replace(/[$,]/g, ''))
    : null;

  //
  // 2) Generic vendor detection
  //
  let vendor = null;

  // 2a) “from X” in the Subject
  if (Subject) {
    const m = /from\s+([A-Za-z0-9 &]+)/i.exec(Subject);
    if (m) vendor = m[1].trim();
  }

  // 2b) “purchase from X” in the body
  if (!vendor) {
    const m = /purchase from\s+([A-Za-z0-9 &\.]+)/i.exec(body);
    if (m) vendor = m[1].trim();
  }

  // 2c) “Vendor: X” line in the body
  if (!vendor) {
    const m = /Vendor:\s*([^\.\n]+)/i.exec(body);
    if (m) vendor = m[1].trim();
  }

  // 2d) Logo <img alt="…"> in the HTML
  if (!vendor && html) {
    const m = /<img[^>]+alt="([^"]+)"/i.exec(html);
    if (m) vendor = m[1].trim();
  }

  // 2e) Fallback: second-level domain (e.g. “lyft” from “post.lyft.com”)
  if (!vendor && From) {
    const parts = From.split('@')[1].toLowerCase().split('.');
    vendor = parts.length > 1
      ? parts[parts.length - 2]
      : parts[0];
  }

  //
  // 3) Parse order_date (e.g. “June 3, 2025” → “2025-06-03”)
  //
  const dateMatch = /\b([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(body)?.[1] || null;
  const order_date = dateMatch
    ? new Date(dateMatch).toISOString().split('T')[0]
    : null;

  //
  // 4) Parse payment info (cards or cash)
  //
  let form_of_payment = null, card_type = null, card_last4 = null;
  const clean = body
    .replace(/&bull;/gi, '•')
    .replace(/&#8226;/g, '•');

  const cardMatch = /([A-Za-z]{2,})\s+[x\*•]+(\d{4})/i.exec(clean);
  if (cardMatch) {
    const raw = cardMatch[1];
    if (/^(mc|mastercard)$/i.test(raw))       card_type = 'MasterCard';
    else if (/^visa$/i.test(raw))             card_type = 'Visa';
    else if (/^(amex|american express)$/i.test(raw)) card_type = 'AMEX';
    else                                       card_type = raw;
    card_last4      = cardMatch[2];
    form_of_payment = 'Card';
  } else if (/cash/i.test(body)) {
    form_of_payment = 'Cash';
  }

  //
  // 5) Category lookup via DB tables only
  //
  let category_name = null, category_id = null;

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

  // 5b) vendor_categories mapping
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
      if (cat2) category_name = cat2.name;
    }
  }

  // 5c) Default to “Other”
  if (!category_id) {
    category_name ||= 'Other';
    const { data: other } = await supabase
      .from('categories')
      .select('id')
      .eq('name', 'Other')
      .maybeSingle();
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
