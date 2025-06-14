import { createClient } from '@supabase/supabase-js';
import { Configuration, OpenAIApi } from 'openai';

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize OpenAI
const openai = new OpenAIApi(
  new Configuration({ apiKey: process.env.OPENAI_API_KEY })
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // DEBUG: log env‐vars
  console.log('→ SUPABASE_URL=', process.env.SUPABASE_URL);
  console.log(
    '→ SUPABASE_SERVICE_ROLE_KEY=',
    process.env.SUPABASE_SERVICE_ROLE_KEY
      ? `${process.env.SUPABASE_SERVICE_ROLE_KEY.slice(0, 8)}…`
      : null
  );

  const { From, Subject, TextBody, HtmlBody, Attachments, MessageID } = req.body;
  const receivedAt = new Date();
  const body = TextBody || HtmlBody || '';

  // 1) Attempt GPT-4 parsing
  let merchant, order_date, total_amount, category;
  try {
    const prompt = `
You are a JSON-only parser for email receipts. Given an email body, extract exactly the following fields:
- merchant (string)
- order_date (YYYY-MM-DD)
- total_amount (number)
- category (one of: Groceries, Travel, Utilities, Other)

Respond with only the JSON object.

Email body:
${body}
    `.trim();

    const completion = await openai.createChatCompletion({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    });

    const parsed = JSON.parse(completion.data.choices[0].message.content);
    merchant      = parsed.merchant;
    order_date    = parsed.order_date;
    total_amount  = parsed.total_amount;
    category      = parsed.category;
  } catch (err) {
    console.error('OpenAI parsing failed, falling back to regex:', err);

    // 2) Regex fallback

    // amount
    const rawAmtMatch = /\$[\d,]+\.\d{2}/.exec(body)?.[0] || null;
    total_amount = rawAmtMatch
      ? parseFloat(rawAmtMatch.replace(/[$,]/g, ''))
      : null;

    // merchant
    const purchaseMatch   = /purchase from\s+([A-Za-z0-9 &]+)/i.exec(body);
    const vendorLineMatch = /Vendor:\s*([^\.\n]+)/i.exec(body);
    merchant = purchaseMatch
      ? purchaseMatch[1].trim()
      : vendorLineMatch
      ? vendorLineMatch[1].trim()
      : From?.split('@')[1]?.split('.')[0] || null;

    // order date
    const dateMatch = /\b([A-Za-z]+ \d{1,2}, \d{4})\b/.exec(body)?.[1] || null;
    order_date = dateMatch
      ? new Date(dateMatch).toISOString().split('T')[0]
      : null;

    // category default
    category = 'Other';
  }

  // 3) Insert into Supabase
  const { error } = await supabase
    .from('receipts')
    .insert([
      {
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
        received_at:  receivedAt,
      },
    ]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully' });
}
