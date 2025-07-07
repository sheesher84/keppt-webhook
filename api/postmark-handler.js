import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { IncomingForm } from 'formidable';
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export const config = {
  api: {
    bodyParser: false, // Required for formidable to parse attachments
  },
};

// --- OCR.space API Helper ---
async function ocrSpaceImage(filePath, fileName) {
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath), fileName);
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('apikey', 'K81861121988957'); // your API key
    const response = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: {
        ...formData.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    const parsedText = response.data?.ParsedResults?.[0]?.ParsedText || '';
    return parsedText;
  } catch (err) {
    console.error('OCR.space error:', err?.response?.data || err);
    return '';
  }
}

// --- Helper: is "low value" body ---
function isLowValueBody(text) {
  if (!text) return true;
  const cleaned = text.replace(/[\s\r\n>﻿]+/g, '').toLowerCase();
  if (cleaned.length < 5) return true;
  if (
    /sentfrommyiphone|receiptattached|seeattached|fwd|thankyou|regards|cheers|signature|receiptattached|invoiceattached|pleasefindattached|scannedcopy|scanattached|forwardedmessage|-----forwardedmessage-----|thismessagewas/i.test(cleaned)
  ) return true;
  return false;
}

// --- VENDOR PREFER SUBJECT OR SENDER (unchanged) ---
function extractVendor({ subject, emailSender, bodyText }) {
  subject = typeof subject === 'string' ? subject : (Array.isArray(subject) ? subject.join(' ') : '');
  bodyText = typeof bodyText === 'string' ? bodyText : (Array.isArray(bodyText) ? bodyText.join(' ') : '');
  emailSender = typeof emailSender === 'string' ? emailSender : (Array.isArray(emailSender) ? emailSender.join(' ') : '');

  let match = subject.match(/(?:from|receipt from|order from|purchase from|eReceipt from)\s+([A-Za-z0-9\s.'&\-]+)/i);
  if (match) return match[1].trim();

  match = subject.match(/your [\w\s]+ from ([A-Za-z0-9\s.'&\-]+)/i);
  if (match) return match[1].trim();

  if (emailSender) {
    let domMatch = emailSender.match(/@([\w\-\.]+)/);
    if (domMatch) {
      let dom = domMatch[1].split('.')[0];
      if (dom && !['gmail', 'yahoo', 'icloud', 'hotmail', 'me'].includes(dom)) {
        return dom.charAt(0).toUpperCase() + dom.slice(1);
      }
    }
  }

  match = subject.match(/([A-Za-z\s'\-&]+)$/);
  if (match && match[1].length > 2) return match[1].trim();

  match = bodyText.match(/(?:^|\n)Vendor:\s*([A-Za-z0-9\s\-\&]+)/i);
  if (match) return match[1].trim();

  return null;
}

// --- CATEGORY NORMALIZATION (unchanged) ---
function normalizeCategory(category, vendor, haystack) {
  if (!category && !haystack) return null;
  let c = (category || '').toLowerCase();
  let h = (haystack || '').toLowerCase();
  const normalizationMap = [
    { out: 'Travel', terms: [
      'cruise', 'ferry', 'excursion', 'itinerary', 'voyage', 'sailing date', 'boarding', 'ship',
      'airline', 'flight', 'hotel', 'lodging', 'car rental', 'rental car', 'travel', 'boarding pass', 'airbnb',
      'uber', 'lyft', 'amtrak', 'train ticket', 'airport', 'transit', 'shuttle', 'reservation #', 'plan my cruise', 'taxi', 'ride', 'rideshare', 'bus ticket', 'subway', 'commute'
    ]},
    { out: 'Food & Drink', terms: [
      'restaurant', 'food', 'dining', 'cafe', 'coffee', 'grille', 'starbucks', 'pizza', 'bar', 'bakery', 'juice',
      'wine', 'brew', 'eatery', 'bistro'
    ]},
    { out: 'Shopping', terms: [
      'shopping', 'order', 'store', 'apparel', 'retail', 'merchandise', 'clothing', 'footwear', 'accessories', 'gift card',
      'fashion', 'mall', 'shoes', 'outlet', 'boutique', 'electronics'
    ]},
    { out: 'Groceries', terms: [
      'grocery', 'groceries', 'market', 'whole foods', 'trader joe\'s', 'sprouts', 'food store', 'supermarket'
    ]},
    { out: 'Health', terms: [
      'pharmacy', 'medicine', 'rx', 'doctor', 'dental', 'prescription', 'clinic', 'hospital', 'health'
    ]},
    { out: 'Subscriptions', terms: [
      'icloud', 'netflix', 'subscription', 'membership', 'monthly', 'spotify', 'prime', 'plus', 'youtube', 'software'
    ]},
    { out: 'Utilities', terms: [
      'utility', 'utilities', 'pg&e', 'sdge', 'water', 'electric', 'bill', 'internet', 'at&t', 'comcast', 'xfinity'
    ]},
    { out: 'Donations', terms: [
      'donation', 'charity', 'nonprofit', 'foundation', 'tax-deductible'
    ]}
  ];
  for (const norm of normalizationMap) {
    if (c && norm.terms.some(term => c.includes(term))) return norm.out;
  }
  for (const norm of normalizationMap) {
    if (h && norm.terms.some(term => h.includes(term))) return norm.out;
  }
  if (category) return category.charAt(0).toUpperCase() + category.slice(1);
  return null;
}

// --- CATEGORY GUESS (unchanged) ---
function guessCategory({ category, vendor, subject, bodyText }) {
  const haystack = `${vendor || ''} ${subject || ''} ${bodyText || ''}`.toLowerCase();
  return normalizeCategory(category, vendor, haystack);
}

// --- HTML CARD LOGO EXTRACTOR (unchanged) ---
function extractCardDetailsFromHtml(html) {
  if (!html) return {};
  const $ = cheerio.load(html);
  let cardType = null;
  let cardLast4 = null;
  $('img').each((_, img) => {
    const src = ($(img).attr('src') || '').toLowerCase();
    const alt = ($(img).attr('alt') || '').toLowerCase();
    let type = null;
    if (src.includes('mastercard') || alt.includes('mastercard')) type = 'MasterCard';
    if (src.includes('visa') || alt.includes('visa')) type = 'Visa';
    if (src.includes('amex') || alt.includes('amex')) type = 'Amex';
    if (src.includes('discover') || alt.includes('discover')) type = 'Discover';
    if (src.includes('diners') || alt.includes('diners')) type = 'Diners';
    if (src.includes('jcb') || alt.includes('jcb')) type = 'JCB';
    if (src.includes('unionpay') || alt.includes('unionpay')) type = 'UnionPay';
    if (type) {
      cardType = type;
      const td = $(img).closest('td');
      const nextTd = td.next('td');
      if (nextTd && nextTd.text().trim().match(/^\d{4}$/)) {
        cardLast4 = nextTd.text().trim();
      }
    }
  });
  return { cardType, cardLast4 };
}

// --- MAIN HANDLER ---
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const contentType = req.headers['content-type'] || '';
    if (contentType.startsWith('multipart/')) {
      const form = new IncomingForm({ multiples: true });
      form.parse(req, async (err, fields, files) => {
        if (err) {
          console.error('Form parse error:', err);
          return res.status(400).json({ error: 'Form parse error' });
        }
        let emailSender = fields['From'] || fields['sender'] || '';
        let subject = fields['Subject'] || fields['subject'] || '';
        let bodyText = fields['body-plain'] || fields['stripped-text'] || fields['text'] || fields['TextBody'] || '';
        let bodyHtml = fields['body-html'] || fields['HtmlBody'] || fields['html'] || fields['stripped-html'] || '';
        const rawTimestamp = fields['Date'] || fields['date'] || new Date().toISOString();
        const messageId = fields['MessageID'] || fields['message_id'] || null;
        const receivedAtIso = new Date(rawTimestamp).toISOString();

        // Stringify fields before checks
        subject = typeof subject === 'string' ? subject : (Array.isArray(subject) ? subject.join(' ') : '');
        bodyText = typeof bodyText === 'string' ? bodyText : (Array.isArray(bodyText) ? bodyText.join(' ') : '');
        bodyHtml = typeof bodyHtml === 'string' ? bodyHtml : (Array.isArray(bodyHtml) ? bodyHtml.join(' ') : '');
        emailSender = typeof emailSender === 'string' ? emailSender : (Array.isArray(emailSender) ? emailSender.join(' ') : '');

        // --- Fallback: If body is empty or low-value AND we have attachments, OCR attachments
        let attachmentText = '';
        if (isLowValueBody(bodyText) && files && Object.keys(files).length > 0) {
          const fileObjs = Object.values(files).flat();
          for (const file of fileObjs) {
            if (
              (file.mimetype && (
                file.mimetype.startsWith('image/') ||
                file.mimetype === 'application/pdf'
              )) &&
              fs.existsSync(file.filepath)
            ) {
              try {
                const ocrResult = await ocrSpaceImage(file.filepath, file.originalFilename || file.newFilename);
                if (ocrResult && ocrResult.trim().length > 0) {
                  attachmentText += '\n' + ocrResult;
                }
              } catch (err) {
                console.error('OCR fallback error:', err);
              }
            }
          }
        }

        // If both bodyText and bodyHtml are empty/low-value, use attachmentText as fallback
        if ((isLowValueBody(bodyText) && isLowValueBody(bodyHtml)) && attachmentText.trim().length > 0) {
          bodyText = attachmentText;
        }

        if ((!bodyText || bodyText.trim().length === 0) && (!bodyHtml || bodyHtml.trim().length === 0)) {
          return res.status(400).json({ error: 'No email text found.' });
        }

        await runMainParser({
          emailSender, subject, bodyText, bodyHtml, messageId, receivedAtIso, res
        });
      });
      return;
    }

    // Else: Regular POST (no attachments)
    const data = req.body;
    let emailSender = data['From'] || data['sender'] || '';
    let subject = data['Subject'] || data['subject'] || '';
    let bodyText = data['body-plain'] || data['stripped-text'] || data['text'] || data['TextBody'] || '';
    let bodyHtml = data['body-html'] || data['HtmlBody'] || data['html'] || data['stripped-html'] || '';
    const rawTimestamp = data['Date'] || data['date'] || new Date().toISOString();
    const messageId = data['MessageID'] || data['message_id'] || null;
    const receivedAtIso = new Date(rawTimestamp).toISOString();

    subject = typeof subject === 'string' ? subject : (Array.isArray(subject) ? subject.join(' ') : '');
    bodyText = typeof bodyText === 'string' ? bodyText : (Array.isArray(bodyText) ? bodyText.join(' ') : '');
    bodyHtml = typeof bodyHtml === 'string' ? bodyHtml : (Array.isArray(bodyHtml) ? bodyHtml.join(' ') : '');
    emailSender = typeof emailSender === 'string' ? emailSender : (Array.isArray(emailSender) ? emailSender.join(' ') : '');

    if ((!bodyText || bodyText.trim().length === 0) && (!bodyHtml || bodyHtml.trim().length === 0)) {
      return res.status(400).json({ error: 'No email text found.' });
    }
    await runMainParser({
      emailSender, subject, bodyText, bodyHtml, messageId, receivedAtIso, res
    });
  } catch (err) {
    console.error('Handler failure:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// --- MAIN PARSER LOGIC (unchanged) ---
async function runMainParser({
  emailSender, subject, bodyText, bodyHtml, messageId, receivedAtIso, res
}) {
  try {
    subject = typeof subject === 'string' ? subject : (Array.isArray(subject) ? subject.join(' ') : '');
    bodyText = typeof bodyText === 'string' ? bodyText : (Array.isArray(bodyText) ? bodyText.join(' ') : '');
    bodyHtml = typeof bodyHtml === 'string' ? bodyHtml : (Array.isArray(bodyHtml) ? bodyHtml.join(' ') : '');
    emailSender = typeof emailSender === 'string' ? emailSender : (Array.isArray(emailSender) ? emailSender.join(' ') : '');

    const emailText = bodyText || bodyHtml || '';
    console.log('RAW EMAIL TEXT TO LLM:', emailText);

    const llmPrompt = `You are a receipt parser. Extract these fields as JSON from the receipt text:
- vendor
- total_amount
- order_date
- form_of_payment
- card_type
- card_last4
- category
- tracking_number
- invoice_number
If any field is missing, use null. Output only JSON.\n\nReceipt email:\n${emailText}`;
    let llmResponseJson = {};
    let fieldSources = {};
    try {
      const response = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: llmPrompt }],
          max_tokens: 512,
        }),
      });
      const result = await response.json();
      const content = result.choices?.[0]?.message?.content || '{}';
      llmResponseJson = JSON.parse(content.replace(/```json|```/gi, '').trim());
      for (const k in llmResponseJson) {
        if (llmResponseJson[k] !== null && llmResponseJson[k] !== undefined) {
          fieldSources[k] = 'LLM';
        }
      }
    } catch (err) {
      console.error('LLM API Error:', err);
    }
    // --- Vendor fix: prefer subject, sender, domain, then body fallback
    const extractedVendor = extractVendor({ subject, emailSender, bodyText });
    if (
      !llmResponseJson.vendor ||
      /thank you|order|krave|receipt/i.test(llmResponseJson.vendor) ||
      llmResponseJson.vendor.length < 3
    ) {
      if (extractedVendor) {
        llmResponseJson.vendor = extractedVendor;
        fieldSources.vendor = 'contextual_extraction';
      }
    }
    // Fallback total
    if (!llmResponseJson.total_amount) {
      const match = (typeof emailText === 'string' ? emailText : '').match(/total[\s:]*\$?([\d,]+\.\d{2})/i);
      if (match) {
        llmResponseJson.total_amount = parseFloat(match[1].replace(/,/g, ''));
        fieldSources.total_amount = 'regex_fallback';
      }
    }
    // Fallback order date
    if (!llmResponseJson.order_date) {
      const match = (typeof emailText === 'string' ? emailText : '').match(/(\d{4}-\d{2}-\d{2})|(\d{2}\/\d{2}\/\d{4})/);
      if (match) {
        llmResponseJson.order_date = new Date(match[0]).toISOString().split('T')[0];
        fieldSources.order_date = 'regex_fallback';
      }
    }
    // Fallback for card type and last4 in plain text
    if (!llmResponseJson.card_type || !llmResponseJson.card_last4) {
      const cardMatch = (typeof emailText === 'string' ? emailText : '').match(/(Visa|MasterCard|Amex|American Express|Discover)[^\d]*[xX*]{2,}(\d{4})/i) ||
                        (typeof emailText === 'string' ? emailText : '').match(/Account[^\d]*\*+(\d{4})/i);
      if (cardMatch) {
        if (!llmResponseJson.card_type) {
          llmResponseJson.card_type = cardMatch[1]?.replace(/American Express/i, 'Amex') || null;
          fieldSources.card_type = 'regex_fallback';
        }
        if (!llmResponseJson.card_last4) {
          llmResponseJson.card_last4 = cardMatch[2] || cardMatch[1] || null;
          fieldSources.card_last4 = 'regex_fallback';
        }
        if (!llmResponseJson.form_of_payment) {
          llmResponseJson.form_of_payment = 'Card';
          fieldSources.form_of_payment = 'regex_fallback';
        }
      }
    }
    // NEW: Extract from HTML logo/structure (only if still null)
    if ((!llmResponseJson.card_type || !llmResponseJson.card_last4) && bodyHtml) {
      const htmlCard = extractCardDetailsFromHtml(bodyHtml);
      if (!llmResponseJson.card_type && htmlCard.cardType) {
        llmResponseJson.card_type = htmlCard.cardType;
        fieldSources.card_type = 'html_logo';
      }
      if (!llmResponseJson.card_last4 && htmlCard.cardLast4) {
        llmResponseJson.card_last4 = htmlCard.cardLast4;
        fieldSources.card_last4 = 'html_logo';
      }
      if ((htmlCard.cardType || htmlCard.cardLast4) && !llmResponseJson.form_of_payment) {
        llmResponseJson.form_of_payment = 'Card';
        fieldSources.form_of_payment = 'html_logo';
      }
    }
    // Fallback for card_last4 anywhere
    if (!llmResponseJson.card_last4) {
      const last4Match = (typeof emailText === 'string' ? emailText : '').match(/(?:^|\s)(\d{4})(?=\s*\$?\d{1,3}[\.,]\d{2})/);
      if (last4Match) {
        llmResponseJson.card_last4 = last4Match[1];
        fieldSources.card_last4 = 'pattern_fallback';
      }
    }
    // Fallback for form_of_payment
    if (!llmResponseJson.form_of_payment && (llmResponseJson.card_type || llmResponseJson.card_last4)) {
      llmResponseJson.form_of_payment = 'Card';
      fieldSources.form_of_payment = 'inferred_fallback';
    }
    // Fallback for invoice number
    if (!llmResponseJson.invoice_number) {
      const match = (typeof emailText === 'string' ? emailText : '').match(/(?:Order|Invoice)[\s#:]*([A-Za-z0-9\-]+)/i);
      if (match) {
        llmResponseJson.invoice_number = match[1];
        fieldSources.invoice_number = 'regex_fallback';
      }
    }
    // Amount cleanup for DB
    if (typeof llmResponseJson.total_amount === 'string') {
      const num = llmResponseJson.total_amount.replace(/[^0-9.]/g, '');
      llmResponseJson.total_amount = parseFloat(num) || null;
      fieldSources.total_amount = 'normalized_string';
    }
    if (typeof llmResponseJson.amount === 'string') {
      const num = llmResponseJson.amount.replace(/[^0-9.]/g, '');
      llmResponseJson.amount = parseFloat(num) || null;
      fieldSources.amount = 'normalized_string';
    }
    // --- CATEGORY normalization and fallback (keywords only) ---
    llmResponseJson.category = guessCategory({
      category: llmResponseJson.category,
      vendor: llmResponseJson.vendor,
      subject,
      bodyText,
    });
    fieldSources.category = llmResponseJson.category ? (fieldSources.category || 'normalized_keyword') : null;
    // Attach extra fields for traceability
    llmResponseJson.vendor_name = llmResponseJson.vendor || null;
    llmResponseJson.amount = llmResponseJson.total_amount || null;
    llmResponseJson.receipt_date = llmResponseJson.order_date || null;
    llmResponseJson.email_sender = emailSender;
    llmResponseJson.subject = subject;
    llmResponseJson.body_text = bodyText || null;
    llmResponseJson.body_html = bodyHtml || null;
    llmResponseJson.message_id = messageId;
    llmResponseJson.received_at = receivedAtIso;
    // --- LOG THE OUTPUT & FIELD SOURCES ---
    llmResponseJson._field_sources = fieldSources;
    console.log('FINAL RECEIPT JSON:', llmResponseJson);
    console.log('FIELD SOURCES AUDIT:', fieldSources);
    // Prevent debug/audit field from being saved to DB!
    const { _field_sources, ...toInsert } = llmResponseJson;
    // Insert to Supabase
    const { error } = await supabase.from('receipts').insert([toInsert]);
    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'DB insert failed' });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Handler failure:', err);
    res.status(500).json({ error: 'Server error' });
  }
}
