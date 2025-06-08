# Keppt Webhook Handler

This is a serverless function to handle incoming emails from Postmark for Keppt.app.

## Endpoint

POST `/api/postmark-handler`

## Functionality

- Accepts inbound email via Postmark Webhook
- Extracts email contents and attachments
- Parses receipt data
- Stores results in Supabase

## Tech Stack

- Node.js (Serverless)
- Vercel (Deployment)
- Postmark (Email Inbound Webhook)
- Supabase (Storage & Database)
- OpenAI API (Receipt Parsing)
