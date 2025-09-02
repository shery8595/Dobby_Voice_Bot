# Discord Voice Recorder Bot 🎙️

A Discord bot that records voice conversations, transcribes them using Deepgram AI, and provides AI-powered summaries and Q&A through Fireworks AI (Dobby model).

## Features ✨

- **Voice Recording**: Record voice channel conversations in real-time
- **AI Transcription**: Convert audio to text using Deepgram's Nova-2 model
- **Smart Summaries**: Generate meeting summaries with key points and action items
- **Interactive Q&A**: Ask questions about recorded conversations
- **Multi-user Support**: Handles multiple speakers simultaneously
- **Clean Audio Processing**: Uses FFmpeg for high-quality audio conversion

## Commands 🤖

- `/record start` - Begin recording in your current voice channel
- `/record stop` - Stop recording and process the audio
- `/summary` - Get an AI-generated summary of the last recording
- `/ask <question>` - Ask questions about the last recording

## Setup Instructions 🛠️

### Prerequisites

- Node.js (v16 or higher)
- Discord Bot Token
- Deepgram API Key
- Fireworks AI API Key

### Environment Variables

Create a `.env` file with the following variables:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_client_id
DEEPGRAM_API_KEY=your_deepgram_api_key
FIREWORK_API_KEY=your_fireworks_api_key
DOBBY_MODEL=accounts/sentientfoundation/models/dobby-unhinged-llama-3-3-70b-new
```

### Local Installation

1. Clone the repository:
```bash
git clone https://github.com/YOUR_USERNAME/discord-voice-recorder
cd discord-voice-recorder
```

2. Install dependencies:
```bash
npm install
```

3. Set up your environment variables in `.env`

4. Run the bot:
```bash
npm start
```

## API Keys Setup 🔑

### Discord Bot Token
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section
4. Create a bot and copy the token
5. Enable "Message Content Intent" if needed
6. Invite bot to your server with appropriate permissions

### Deepgram API Key
1. Sign up at [Deepgram](https://deepgram.com)
2. Go to your dashboard
3. Create an API key
4. Copy the key to your `.env` file

### Fireworks AI API Key
1. Sign up at [Fireworks AI](https://fireworks.ai)
2. Generate an API key
3. Copy the key to your `.env` file

## Bot Permissions Required 📋

Make sure your bot has these Discord permissions:
- View Channels
- Send Messages
- Use Slash Commands
- Connect to Voice
- Speak in Voice
- Use Voice Activity

## Deployment 🚀

### Railway Deployment
1. Push your code to GitHub
2. Go to [Railway](https://railway.app)
3. Connect your GitHub repository
4. Add all environment variables in Railway dashboard
5. Deploy automatically

### Other Platforms
- **Render**: Similar GitHub integration
- **Heroku**: Use Git or GitHub integration
- **DigitalOcean**: App Platform with GitHub

## Usage Example 💡

1. Join a voice channel in Discord
2. Use `/record start` to begin recording
3. Have your conversation
4. Use `/record stop` to end recording and get transcription
5. Use `/summary` to get meeting summary
6. Use `/ask` to ask specific questions about the recording

## File Structure 📁

```
discord-voice-recorder/
├── index.js              # Main bot file
├── package.json          # Dependencies and scripts
├── .env                  # Environment variables (local only)
├── .gitignore           # Git ignore file
├── README.md            # This file
└── recordings/          # Temporary audio files (auto-created)
```

## Dependencies 📦

- **discord.js**: Discord API wrapper
- **@discordjs/voice**: Voice connection handling
- **prism-media**: Audio processing
- **axios**: HTTP requests for APIs
- **ffmpeg-static**: Audio conversion
- **dotenv**: Environment variable loading

## Technical Details ⚙️

- **Audio Format**: 48kHz stereo PCM → WAV
- **Transcription**: Deepgram Nova-2 model
- **AI Model**: Dobby (Llama 3.3 70B) via Fireworks AI
- **Storage**: Temporary local files (auto-cleanup)

## Troubleshooting 🔧

**Common Issues:**
- **No audio recorded**: Ensure people speak clearly and Discord detects voice activity
- **Transcription failed**: Check Deepgram API key and credits
- **Bot offline**: Verify Discord token and bot permissions
- **Empty recordings**: Make sure voice activity detection is working

**Logs to check:**
- FFmpeg processing output
- Deepgram API responses
- Voice connection status
- File size validation

## Contributing 🤝

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License 📄

This project is licensed under the MIT License - see the LICENSE file for details.

## Support 💬

For issues and questions:
- Check the troubleshooting section
- Review the logs for error messages
- Ensure all API keys are valid and have sufficient credits

---

**Note**: This bot processes voice data and sends it to third-party AI services. Make sure you have proper consent from all participants before recording conversations.
