import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Parse incoming email fields
    const data = req.body;
    const emailSender = data['From'] || data['sender'] || '';
    const subject = data['Subject'] || data['subject'] || '';
    const timestamp = data['Date'] || data['date'] || new Date().toISOString();
    const messageId = data['MessageID'] || data['message_id'] || null;
    const bodyText = data['body-plain'] || data['stripped-text'] || data['text'] || data['TextBody'] || '';
    const bodyHtml = data['HtmlBody'] || data['html'] || '';

    // Use plain text first, fallback to HTML
    const emailText = bodyText || bodyHtml || '';

    // Debug: log what we send to the LLM
    console.log('RAW EMAIL TEXT TO LLM:', emailText);

    if (!emailText) {
      console.error('No email text found in webhook payload.');
      return res.status(400).json({ error: 'No email text found.' });
    }

    // Build LLM prompt
    const llmPrompt = `
You are a receipt parser. Extract these fields as JSON from the receipt text:
- vendor (store name)
- total_amount (number, no currency sign)
- order_date (YYYY-MM-DD)
- form_of_payment (e.g. Card, PayPal, Apple Pay)
- card_type (Visa, MasterCard, Amex, Discover, etc)
- card_last4 (last 4 digits)
- category (shopping, travel, etc)
- tracking_number (if any)

If any field is missing, use null. Output **only JSON** (no comments, no text).

Receipt email:
${emailText}
`;

    // Call the LLM
    let llmResponseJson = {};
    try {
      const response = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o', // or gpt-3.5-turbo if needed
          messages: [{ role: 'user', content: llmPrompt }],
          max_tokens: 512,
        }),
      });
      const responseJson = await response.json();
      const llmText = responseJson.choices?.[0]?.message?.content || '{}';
      console.log('LLM RESULT:', llmText);

      // --- STRIP CODE FENCING BACKTICKS ---
      const cleanLLMText = llmText.replace(/```json|```/gi, '').trim();
      try {
        llmResponseJson = JSON.parse(cleanLLMText);
      } catch (e) {
        console.error('Failed to parse LLM JSON:', llmText);
        llmResponseJson = {};
      }
    } catch (err) {
      console.error('LLM API call failed:', err);
    }

    // Fallbacks for missing fields
    if (!llmResponseJson.vendor) {
      const vendorMatch =
        subject.match(/from ([\w\s&'’]+)/i) ||
        emailText.match(/Thank you for shopping at ([A-Za-z\s'’]+)[.!]/i) ||
        emailText.match(/at ([A-Za-z\s'’]+)[.!]/i);
      llmResponseJson.vendor =
        vendorMatch?.[1]?.trim() ||
        emailSender.split('@')[1]?.split('.')[0] ||
        null;
    }

    if (!llmResponseJson.total_amount) {
      const totalMatch =
        emailText.match(/total[\s:]*\$?([\d,]+\.\d{2})/i) ||
        emailText.match(/total tender[\s:]*\$?([\d,]+\.\d{2})/i);
      if (totalMatch) {
        llmResponseJson.total_amount = parseFloat(
          totalMatch[1].replace(/,/g, '')
        );
      }
    }

    if (!llmResponseJson.order_date) {
      const dateMatch =
        emailText.match(/(\d{2}\/\d{2}\/\d{4})/) ||
        emailText.match(/([A-Za-z]+ \d{1,2}, \d{4})/);
      if (dateMatch) {
        let isoDate;
        try {
          isoDate = new Date(dateMatch[1]).toISOString().split('T')[0];
        } catch {
          isoDate = null;
        }
        llmResponseJson.order_date = isoDate || null;
      }
    }

    if (!llmResponseJson.card_type || !llmResponseJson.card_last4) {
      const cardMatch =
        emailText.match(/(Visa|MasterCard|Amex|American Express|Discover)[^\d]*[xX*]{2,}(\d{4})/) ||
        emailText.match(/(Visa|MasterCard|Amex|American Express|Discover)[^\d]*\*+(\d{4})/) ||
        emailText.match(/Account[^\d]*X+(\d{4})/);
      if (cardMatch) {
        llmResponseJson.card_type =
          cardMatch[1]?.replace(/American Express/i, 'Amex') || null;
        llmResponseJson.card_last4 = cardMatch[2] || null;
        llmResponseJson.form_of_payment = 'Card';
      }
    }

    if (!llmResponseJson.category) llmResponseJson.category = null;

    // ---- ENSURE FIELDS MATCH SUPABASE AND FRONTEND ----
    llmResponseJson.vendor_name = llmResponseJson.vendor || null;
    llmResponseJson.total_amount = llmResponseJson.total_amount || null;
    llmResponseJson.order_date = llmResponseJson.order_date || null;
    llmResponseJson.form_of_payment = llmResponseJson.form_of_payment || null;
    llmResponseJson.card_type = llmResponseJson.card_type || null;
    llmResponseJson.card_last4 = llmResponseJson.card_last4 || null;
    llmResponseJson.category = llmResponseJson.category || null;
    llmResponseJson.tracking_number = llmResponseJson.tracking_number || null;

    // Add all extra metadata for traceability
    llmResponseJson.email_sender = emailSender;
    llmResponseJson.subject = subject;
    llmResponseJson.body_text = bodyText || null;
    llmResponseJson.body_html = bodyHtml || null;
    llmResponseJson.message_id = messageId || null;
    llmResponseJson.received_at = timestamp;

    // Legacy/compatibility fields (optional)
    llmResponseJson.vendor = llmResponseJson.vendor_name;
    llmResponseJson.amount = llmResponseJson.total_amount;
    llmResponseJson.receipt_date = llmResponseJson.order_date;

    // Debug: log final JSON
    console.log('FINAL RECEIPT JSON:', llmResponseJson);

    // Save to Supabase
    const { error } = await supabase
      .from('receipts')
      .insert([llmResponseJson]);

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to insert into Supabase.' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
}
// postmark-handler.js

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // NOTE: This matches your env file!
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Parse incoming email fields
    const data = req.body;
    const emailSender = data['From'] || data['sender'] || '';
    const subject = data['Subject'] || data['subject'] || '';
    const timestamp = data['Date'] || data['date'] || new Date().toISOString();
    const messageId = data['MessageID'] || data['message_id'] || null;
    const bodyText = data['body-plain'] || data['stripped-text'] || data['text'] || data['TextBody'] || '';
    const bodyHtml = data['HtmlBody'] || data['html'] || '';

    // Use plain text first, fallback to HTML
    const emailText = bodyText || bodyHtml || '';

    // Debug: log what we send to the LLM
    console.log('RAW EMAIL TEXT TO LLM:', emailText);

    if (!emailText) {
      console.error('No email text found in webhook payload.');
      return res.status(400).json({ error: 'No email text found.' });
    }

    // Build LLM prompt
    const llmPrompt = `
You are a receipt parser. Extract these fields as JSON from the receipt text:
- vendor (store name)
- total_amount (number, no currency sign)
- order_date (YYYY-MM-DD)
- form_of_payment (e.g. Card, PayPal, Apple Pay)
- card_type (Visa, MasterCard, Amex, Discover, etc)
- card_last4 (last 4 digits)
- category (shopping, travel, etc)
- tracking_number (if any)

If any field is missing, use null. Output **only JSON** (no comments, no text).

Receipt email:
${emailText}
`;

    // Call the LLM
    let llmResponseJson = {};
    try {
      const response = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o', // or gpt-3.5-turbo if needed
          messages: [{ role: 'user', content: llmPrompt }],
          max_tokens: 512,
        }),
      });
      const responseJson = await response.json();
      // LLM returns string in choices[0].message.content
      const llmText = responseJson.choices?.[0]?.message?.content || '{}';
      // Log raw LLM result
      console.log('LLM RESULT:', llmText);

      // --- STRIP CODE FENCING BACKTICKS ---
      const cleanLLMText = llmText.replace(/```json|```/gi, '').trim();
      try {
        llmResponseJson = JSON.parse(cleanLLMText);
      } catch (e) {
        console.error('Failed to parse LLM JSON:', llmText);
        llmResponseJson = {};
      }
    } catch (err) {
      console.error('LLM API call failed:', err);
    }

    // Regex fallback for any null fields
    // 1. Vendor fallback (subject, emailText, or sender domain)
    if (!llmResponseJson.vendor) {
      const vendorMatch =
        subject.match(/from ([\w\s&'’]+)/i) ||
        emailText.match(/Thank you for shopping at ([A-Za-z\s'’]+)[.!]/i) ||
        emailText.match(/at ([A-Za-z\s'’]+)[.!]/i);
      llmResponseJson.vendor =
        vendorMatch?.[1]?.trim() ||
        emailSender.split('@')[1]?.split('.')[0] ||
        null;
    }

    // 2. Total amount fallback
    if (!llmResponseJson.total_amount) {
      const totalMatch =
        emailText.match(/total[\s:]*\$?([\d,]+\.\d{2})/i) ||
        emailText.match(/total tender[\s:]*\$?([\d,]+\.\d{2})/i);
      if (totalMatch) {
        llmResponseJson.total_amount = parseFloat(
          totalMatch[1].replace(/,/g, '')
        );
      }
    }

    // 3. Order date fallback
    if (!llmResponseJson.order_date) {
      // Look for date in mm/dd/yyyy or month dd, yyyy
      const dateMatch =
        emailText.match(/(\d{2}\/\d{2}\/\d{4})/) ||
        emailText.match(
          /([A-Za-z]+ \d{1,2}, \d{4})/
        );
      if (dateMatch) {
        let isoDate;
        try {
          isoDate = new Date(dateMatch[1]).toISOString().split('T')[0];
        } catch {
          isoDate = null;
        }
        llmResponseJson.order_date = isoDate || null;
      }
    }

    // 4. Card details fallback
    if (!llmResponseJson.card_type || !llmResponseJson.card_last4) {
      const cardMatch =
        emailText.match(/(Visa|MasterCard|Amex|American Express|Discover)[^\d]*[xX*]{2,}(\d{4})/) ||
        emailText.match(/(Visa|MasterCard|Amex|American Express|Discover)[^\d]*\*+(\d{4})/) ||
        emailText.match(/Account[^\d]*X+(\d{4})/);
      if (cardMatch) {
        llmResponseJson.card_type =
          cardMatch[1]?.replace(/American Express/i, 'Amex') || null;
        llmResponseJson.card_last4 = cardMatch[2] || null;
        llmResponseJson.form_of_payment = 'Card';
      }
    }

    // 5. Fallback: category (just "Other" for now if nothing else found)
    if (!llmResponseJson.category) llmResponseJson.category = null;

    // --- ADD FOR FRONTEND COMPATIBILITY ---
    llmResponseJson.vendor_name = llmResponseJson.vendor || null;

    // Add other metadata
    llmResponseJson.email_sender = emailSender;
    llmResponseJson.subject = subject;
    llmResponseJson.body_text = bodyText || null;
    llmResponseJson.body_html = bodyHtml || null;
    llmResponseJson.message_id = messageId || null;
    llmResponseJson.received_at = timestamp;

    // Debug: log final JSON
    console.log('FINAL RECEIPT JSON:', llmResponseJson);

    // Save to Supabase
    const { error } = await supabase
      .from('receipts')
      .insert([llmResponseJson]);

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to insert into Supabase.' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
}
