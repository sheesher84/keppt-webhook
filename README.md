# Keppt Webhook – Postmark Email Handler

This project is a serverless function deployed to [Vercel](https://vercel.com) that handles inbound emails from [Postmark](https://postmarkapp.com) for the [Keppt](https://keppt.app) platform.

## 📬 Purpose

When a user sends a receipt to their `@keppt.app` address, Postmark forwards the email here. This webhook:

- Accepts the incoming email
- Extracts sender, subject, body, attachments
- Parses receipt data (vendor, amount, date)
- Stores structured data in a Supabase database
- Stores attachments (optional) in Supabase Storage

## ⚙️ Technologies Used

- Node.js (Vercel Serverless Function)
- [Postmark Inbound Webhook](https://postmarkapp.com/developer/user-guide/inbound-email/overview)
- [Supabase](https://supabase.com) (Postgres DB + file storage)
- [OpenAI API](https://platform.openai.com) (optional GPT-powered parsing)
- Vercel (CI/CD + cloud hosting)

## 🚀 Endpoints

| Method | Path                     | Description                   |
|--------|--------------------------|-------------------------------|
| POST   | `/api/postmark-handler`  | Handles Postmark email events |

> ✅ Only POST requests from Postmark will be accepted.

## 🔐 Environment Variables

To function correctly, the following env vars must be set in Vercel:

```env
SUPABASE_URL=https://keppt.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqbGNlam1wemx5aG5yeWNscHBoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0ODQ4NTM3NywiZXhwIjoyMDY0MDYxMzc3fQ.QuWAOA1yXxUn18go3eujnWQe1H8-JG1b35Rz-qithfQ
