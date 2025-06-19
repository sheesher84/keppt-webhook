import { createClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --- Regex Helpers ---
function extractCard(text) {
  // Finds card type and last 4 from various formats
  const cardRegex = /(Visa|MasterCard|Amex|American Express|Discover|MC)[^0-9]{0,15}(?:ending in|x+|\*+)?\s*?(\d{4})/i;
  const match = cardRegex.exec(text);
  if (match) {
    let cardType = match[1];
    if (cardType === 'MC') cardType = 'MasterCard';
    if (cardType === 'Amex') cardType = 'American Express';
    return { card_type: cardType, card_last4: match[2] };
  }
  return { card_type: null, card_last4: null };
}

function extractAmount(text) {
  // Try to match the last "Total", "Amount Paid", or "Total Tendered"
  const lines = text.split('\n');
  let candidates = [];
  for (let line of lines) {
    if (
      /(total|amount paid|total tendered|order total|payment total)/i.test(line)
      && /\$?\s?([0-9]+([.,][0-9]{2})?)/.test(line)
    ) {
      const amt = line.match(/\$?\s?([0-9]+([.,][0-9]{2})?)/);
      if (amt) candidates.push(parseFloat(amt[1].replace(',', '.')));
    }
  }
  // fallback: last $xx.xx in the body
  if (candidates.length === 0) {
    const all = text.match(/\$([0-9]+(?:[.,][0-9]{2})?)/g);
    if (all) {
      let last = all[all.length - 1];
      return parseFloat(last.replace(/[^0-9.]/g, ''));
    }
    // fallback: numbers like "Total 65.18"
    const looseAmt = text.match(/total[^0-9]{1,6}([0-9]+(?:[.,][0-9]{2})?)/i);
    if (looseAmt) return parseFloat(looseAmt[1].replace(',', '.'));
    return null;
  }
  // Use the largest candidate (most likely the grand total)
  return Math.max(...candidates);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { From, Subject, TextBody, HtmlBody, MessageID } = req.body;
  const textBody = TextBody || '';
  const htmlBody = HtmlBody || '';
  const body = (textBody || htmlBody).replace(/\r/g, '');
  const receivedAt = new Date();

  // Regex extraction
  const regexCard = extractCard(body);
  const regexAmount = extractAmount(body);

  // LLM Prompt
  const prompt = `
You are a world-class receipt-parsing assistant. Parse the following purchase receipt and extract as JSON:
Fields: email_sender, subject, total_amount (number, no $), vendor, order_date (YYYY-MM-DD), form_of_payment ("Card" or "Cash"), card_type, card_last4, category, tracking_number.
If missing, set as null.
Email sender: ${From || ""}
Subject: ${Subject || ""}
Body: ${body}
  `.trim();

  let ai = {};
  try {
    const aiRes = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a world-class receipts-parsing assistant." },
        { role: "user", content: prompt }
      ],
      max_tokens: 400
    });
    ai = JSON.parse(aiRes.choices[0]?.message?.content);
  } catch (err) {
    console.warn("OpenAI parsing failed, falling back to regex-only:", err);
    ai = {};
  }

  // Hybrid assignment: Prefer LLM, fallback to regex, but *upvote* LLM if conflict
  function getField(field, regexValue) {
    if (ai[field] !== null && ai[field] !== undefined && ai[field] !== "") {
      return ai[field];
    }
    return regexValue !== undefined ? regexValue : null;
  }

  // Special handling for some fields
  let total_amount = getField("total_amount", regexAmount);
  if (typeof total_amount === "string") {
    total_amount = parseFloat(total_amount.replace(/[^0-9.]/g, ""));
  }
  let card_type = getField("card_type", regexCard.card_type);
  let card_last4 = getField("card_last4", regexCard.card_last4);

  // Insert into Supabase
  const { error } = await supabase
    .from('receipts')
    .insert([{
      email_sender:   getField("email_sender", From),
      subject:        getField("subject", Subject),
      body_text:      textBody || null,
      body_html:      htmlBody || null,
      total_amount,
      vendor:         getField("vendor", null),
      vendor_name:    getField("vendor", null),
      order_date:     getField("order_date", null),
      category:       getField("category", null),
      form_of_payment: getField("form_of_payment", card_type ? "Card" : null),
      card_type,
      card_last4,
      tracking_number: getField("tracking_number", null),
      message_id:     MessageID || null,
      received_at:    receivedAt
    }]);

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Database insert failed' });
  }

  return res.status(200).json({ message: 'Email processed successfully (Hybrid LLM+Regex)' });
}
