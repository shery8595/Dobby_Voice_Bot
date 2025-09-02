# 🎙️ Discord Voice Recorder + Supabase + Deepgram + Dobby LLM

This project is a Discord bot that can **record voice chats**, upload the audio to **Supabase storage**, and then let users **list and select recordings** for **transcription** using Deepgram.  
The transcribed text is then passed to **Fireworks (Dobby LLM)** for **summarization** and **Q&A**.

---

## ✨ Features
- ✅ Record voice in Discord channels  
- ✅ Save recordings in Supabase Storage  
- ✅ List and select past recordings  
- ✅ Convert audio to text using Deepgram  
- ✅ Summarize + Q&A with Fireworks (Dobby)  

---

## 📦 Requirements
- Node.js **20+**  
- Discord Bot Token  
- Supabase Project + Storage Bucket  
- Deepgram API Key  
- Fireworks (Dobby) API Key  

---

## ⚙️ Setup

1. Clone this repo:
   ```bash
   git clone https://github.com/yourusername/discord-voice-dobby.git
   cd discord-voice-dobby
Install dependencies:

bash
Copy code
npm install
Create a .env file in the root folder:

env
Copy code
DISCORD_TOKEN=your_discord_token
DISCORD_CLIENT_ID=your_discord_client_id
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_anon_key
DEEPGRAM_API_KEY=your_deepgram_api_key
FIREWORKS_API_KEY=your_fireworks_api_key
SUPABASE_BUCKET=recordings
Start the bot:

bash
Copy code
node index.js
🚀 Usage
Join a voice channel in Discord

Use /record start to begin recording

Use /record stop to stop and save the file to Supabase

Use /list to see recordings

Use /transcribe <filename> to convert to text

Use /summarize <filename> to get a summary and ask questions

🛠️ Tech Stack
Discord.js – Discord bot framework

Supabase – Storage for audio files

Deepgram – Speech-to-text transcription

Fireworks (Dobby) – LLM for summarization and Q&A

📜 License
MIT License © 2025

css
Copy code

Do you want me to also add a **diagram** (like a simple flow chart of how audio → supabase → deepgram → dobby works) in the README?







Ask ChatGPT
