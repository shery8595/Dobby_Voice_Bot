Discord Voice Recorder Bot 🎤
A powerful Discord bot that records voice conversations, transcribes them using Deepgram, and provides AI-powered summaries and Q&A using Fireworks AI's Dobby model. All recordings are stored in Supabase for easy access and management.

https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white
https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white
https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white

✨ Features
🎤 Voice Recording: Record voice conversations in any Discord voice channel

📝 AI Transcription: Automatic transcription using Deepgram's speech recognition

🤖 AI Summarization: Get concise summaries of your conversations using Fireworks AI

❓ Q&A System: Ask questions about your recorded conversations

💾 Cloud Storage: All recordings stored securely in Supabase

🔍 Easy Access: Browse and select from previous recordings with interactive menus

🚀 Quick Start
Prerequisites
Node.js 16.9.0 or higher

FFmpeg installed on your system

Discord bot token and application ID

Supabase account

Deepgram API key

Fireworks AI API key

Installation
Clone the repository

bash
git clone https://github.com/your-username/discord-voice-recorder.git
cd discord-voice-recorder
Install dependencies

bash
npm install
Set up environment variables
Create a .env file in the root directory:

env
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_application_id_here
DEEPGRAM_API_KEY=your_deepgram_api_key_here
FIREWORK_API_KEY=your_fireworks_ai_api_key_here
SUPABASE_URL=your_supabase_url_here
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key_here
Invite your bot to Discord
Create an invite URL with the following permissions:

applications.commands

Send Messages

Connect

Speak

Use Voice Activity

Start the bot

bash
node index.js
