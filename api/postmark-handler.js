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

  // --- Comprehensive prompt for expert-level parsing ---
  const prompt = `
You are a world-class receipt-parsing assistant. Your job is to extract purchase data from all types of receipts, even those with odd layouts or confusing formats. Use deep reasoning and all evidence present in the receipt. Here are your key rules:

General Rules:
- Only parse purchase receipts, not marketing/promotional emails.
- Always return a JSON object with the following fields (if missing, set as null):
  email_sender
  subject
  total_amount (number, no $ sign)
  vendor
  order_date (YYYY-MM-DD)
  form_of_payment ("Card" or "Cash")
  card_type ("Visa", "MasterCard", "AMEX", etc)
  card_last4 (4 digits)
  category
  tracking_number

Vendor Extraction:
- The "vendor" is the store, retailer, or service provider where the purchase was made.  
- It may appear as a logo alt text, in the header, after phrases like "Thank you for shopping at", "Sold by", "Paid to", "Merchant", or even in the email footer.
- Never use the sender's email as the vendor unless the vendor is literally the domain name (e.g., receipt@amazon.com = Amazon).
- If the vendor appears multiple places, use the most prominent or repeated store/brand name.

Amount Extraction:
- The "total_amount" is the amount actually paid/charged for the purchase (not subtotal, shipping, tax, or cash-back).  
- Look for "Total", "Order Total", "Amount Paid", "Amount", "Payment Total", "Total Tendered", or similar.
- If multiple amounts, prefer the one closest to a "Paid with" or payment type line, or the largest reasonable total.

Order Date:
- Look for "Order Date", "Date", or "Transaction Date". If only a timestamp exists, extract the date portion (YYYY-MM-DD).
- If multiple dates, prefer the one closest to the total or payment lines.

Form of Payment:
- Look for "Paid with", "Payment method", "Payment type", "Tender", "Visa/MC/AMEX", "Cash", "Contactless", or similar.
- If card is detected (any mention of card network or last 4), set form_of_payment as "Card", otherwise if only "Cash" is present, use "Cash".

Card Type and Last 4:
- "card_type" is typically "Visa", "MasterCard", "AMEX", "Discover", etc., may appear as "VISA", "MC", etc.
- "card_last4" are the last 4 digits of the masked card number, often shown as "ending in 1234", "****1234", "xxxx-1234", etc.

Category:
- If a "category" is mentioned, use it, otherwise infer based on the vendor (e.g., "Chevron" = "Transportation", "Whole Foods" = "Groceries", "Apple" = "Technology"). If unclear, use "Other".

Tracking Number:
- Look for "Tracking Number", "Track #: ", or similar lines. If not found, set as null.

Other Extraction Rules:
- Ignore promotional banners, surveys, advertisements, and unsubscribe/marketing footers.
- If receipt contains both purchases and returns/refunds, only use the net charge as the total_amount.
- If multiple purchases, use the grand total.
- Ignore color, boldness, font, or size—extract based on content only.
- For receipts that use strange labels or foreign language (but English text is present), use best judgment and reasoning.
- If you are unsure between two options for a field, pick the value with the most supporting context.

Examples:

Example 1:
Email sender: do_not_reply@target.com
Subject: Your Target eReceipt
Body:
Target
Thank you for your purchase.
Order Total: $44.90
Paid with: MasterCard ending in 1234
Order Date: 06/13/2025

Expected JSON:
{
  "email_sender": "do_not_reply@target.com",
  "subject": "Your Target eReceipt",
  "total_amount": 44.90,
  "vendor": "Target",
  "order_date": "2025-06-13",
  "form_of_payment": "Card",
  "card_type": "MasterCard",
  "card_last4": "1234",
  "category": "Shopping & Retail",
  "tracking_number": null
}

Example 2:
Email sender: receipts@walmart.com
Subject: Walmart Supercenter Purchase Receipt
Body:
Thank you for shopping at Walmart.
Walmart Supercenter #123
Date: 2025-06-10
Amount Paid: $63.12
Paid by: Visa ending in 4567

Expected JSON:
{
  "email_sender": "receipts@walmart.com",
  "subject": "Walmart Supercenter Purchase Receipt",
  "total_amount": 63.12,
  "vendor": "Walmart",
  "order_date": "2025-06-10",
  "form_of_payment": "Card",
  "card_type": "Visa",
  "card_last4": "4567",
  "category": "Groceries",
  "tracking_number": null
}

Example 3 (vendor in footer, complex label):
Email sender: support@pos.com
Subject: Receipt #0000999
Body:
Transaction Complete!
Amount: $28.00
Payment: Cash
Date: 2025-07-12
---
Thank you for shopping at THE FLOWER PATCH.

Expected JSON:
{
  "email_sender": "support@pos.com",
  "subject": "Receipt #0000999",
  "total_amount": 28.00,
  "vendor": "The Flower Patch",
  "order_date": "2025-07-12",
  "form_of_payment": "Cash",
  "card_type": null,
  "card_last4": null,
  "category": "Shopping & Retail",
  "tracking_number": null
}

Example 4 (multiple items, returns/refunds):
Email sender: gap@receipts.com
Subject: Your GAP Receipt
Body:
Thank you for shopping at GAP!
Order Total: $55.00
Return: $10.00
Net Charge: $45.00
Paid by: VISA xxxxxxxxxx1234
Order Date: 2025-06-15

Expected JSON:
{
  "email_sender": "gap@receipts.com",
  "subject": "Your GAP Receipt",
  "total_amount": 45.00,
  "vendor": "GAP",
  "order_date": "2025-06-15",
  "form_of_payment": "Card",
  "card_type": "Visa",
  "card_last4": "1234",
  "category": "Shopping & Retail",
  "tracking_number": null
}

Now, extract the JSON for this receipt:
Email sender: ${From || ""}
Subject: ${Subject || ""}
Body: ${body}
  `.trim();

  // Call OpenAI and parse result
  let parsed = {};
  try {
    const aiRes = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a world-class receipts-parsing assistant." },
        { role: "user",   content: prompt }
      ],
      max_tokens: 400
    });

    const content = aiRes.choices[0]?.message?.content;
    parsed = JSON.parse(content);

  } catch (err) {
    console.warn("OpenAI parsing failed, falling back to null fields:", err);
    parsed = {
      email_sender:   From || null,
      subject:        Subject || null,
      total_amount:   null,
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
