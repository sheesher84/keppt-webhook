import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { From, Subject, TextBody, HtmlBody, MessageID } = req.body;
  const html       = HtmlBody || '';
  const text       = TextBody || '';
  const body       = (text || html).replace(/\r/g, '');
  const receivedAt = new Date();

  // Force JSON only from LLM
  const prompt = `
You are a world-class receipt-parsing assistant. Extract ONLY the following fields from the provided email receipt.
- Respond ONLY with a valid JSON object and nothing else.
- Do not include comments, explanations, or apologies.
- If a field is missing, set it to null.

JSON fields to extract:
email_sender, subject, total_amount (number, no $ sign), vendor, order_date (YYYY-MM-DD), form_of_payment ("Card" or "Cash"), card_type ("Visa", "MasterCard", "AMEX", etc), card_last4 (4 digits), category, tracking_number

Email sender: ${From || ""}
Subject: ${Subject || ""}
Body: ${body}
Output ONLY the JSON object as your answer.
  `.trim();

  let parsed = {};
  let openAIContent = '';
  try {
    const aiRes = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a world-class receipts-parsing assistant." },
        { role: "user",   content: prompt }
      ],
      max_tokens: 400,
      temperature: 0 // Less creative, more accurate
    });

    openAIContent = aiRes.choices[0]?.message?.content?.trim();
    console.log("OpenAI content:", openAIContent);
    parsed = JSON.parse(openAIContent);

    // Defensive: ensure every key exists
    parsed = {
      email_sender:   parsed.email_sender ?? (From || null),
      subject:        parsed.subject ?? (Subject || null),
      total_amount:   parsed.total_amount ?? null,
      vendor:         parsed.vendor ?? null,
      order_date:     parsed.order_date ?? null,
      form_of_payment: parsed.form_of_payment ?? null,
      card_type:      parsed.card_type ?? null,
      card_last4:     parsed.card_last4 ?? null,
      category:       parsed.category ?? null,
      tracking_number: parsed.tracking_number ?? null
    };

  } catch (err) {
    console.warn("OpenAI parsing failed, falling back to regex-only:", err);
    console.warn("OpenAI response content was:", openAIContent);

    // --- Basic regex fallback ---
    // (Add your preferred regex parsing here, but keeping it simple for demo)
    const amountMatch = (body.match(/\$([\d,]+\.\d{2}|\d+)/) || [])[1];
    let amount = amountMatch ? parseFloat(amountMatch.replace(/,/g, '')) : null;

    // (You can extend these with more robust patterns as needed)
    parsed = {
      email_sender:   From || null,
      subject:        Subject || null,
      total_amount:   amount,
      vendor:         null,
      order_date:     null,
      form_of_payment: null,
      card_type:      null,
      card_last4:     null,
      category:       null,
      tracking_number: null
    };
  }

  // Insert into receipts table using parsed fields
  const { error } = await supabase
    .from('receipts')
    .insert([{
      email_sender:   parsed.email_sender,
      subject:        parsed.subject,
      body_text:      TextBody || null,
      body_html:      HtmlBody || null,
      total_amount:   parsed.total_amount,
      vendor:         parsed.vendor,
      vendor_name:    parsed.vendor,
      order_date:     parsed.order_date,
      category:       parsed.category,
      form_of_payment: parsed.form_of_payment,
      card_type:      parsed.card_type,
      card_last4:     parsed.card_last4,
      tracking_number: parsed.tracking_number,
      message_id:     MessageID || null,
      received_at:    receivedAt
    }]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully (OpenAI)' });
}
