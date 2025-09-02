/**
 * Discord voice recorder -> Deepgram transcription -> Fireworks (Dobby) summarization & Q/A
 * Fixed version with proper session management
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const FIREWORK_API_KEY = process.env.FIREWORK_API_KEY;
const DOBBY_MODEL = process.env.DOBBY_MODEL || 'accounts/sentientfoundation/models/dobby-unhinged-llama-3-3-70b-new';
const FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

// ---------- Session management ----------
// Separate storage for active recordings and completed transcripts
const activeRecordings = new Map(); // For active recording sessions
const transcripts = new Map(); // For completed transcripts

// ---------- Helpers ----------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getRecordingPath(guildId) {
  ensureDir('./recordings');
  return path.join(__dirname, 'recordings', `${guildId}_${Date.now()}`);
}

// Upload local file to Deepgram for transcription
async function transcribeWithDeepgram(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  
  const stats = fs.statSync(filePath);
  if (stats.size === 0) {
    throw new Error(`File is empty: ${filePath}`);
  }

  const audioBuffer = fs.readFileSync(filePath);
  
  const url = 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true';
  const headers = {
    'Authorization': `Token ${DEEPGRAM_API_KEY}`,
    'Content-Type': 'audio/wav'
  };

  try {
    const response = await axios.post(url, audioBuffer, { headers, timeout: 120000 });
    
    if (response.data && response.data.results && response.data.results.channels) {
      let transcript = '';
      for (const channel of response.data.results.channels) {
        for (const alternative of channel.alternatives) {
          transcript += alternative.transcript + ' ';
        }
      }
      return transcript.trim();
    } else {
      throw new Error('Unexpected response format from Deepgram');
    }
  } catch (error) {
    console.error('Deepgram API error:', error.response?.data || error.message);
    throw new Error(`Deepgram transcription failed: ${error.response?.data?.err_msg || error.message}`);
  }
}

// Call Fireworks / Dobby model for summarization / QA
async function callDobby(prompt, system = null, max_tokens = 1024) {
  const url = 'https://api.fireworks.ai/inference/v1/chat/completions';
  const headers = {
    Authorization: `Bearer ${FIREWORK_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const body = {
    model: DOBBY_MODEL,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt }
    ],
    max_tokens,
    temperature: 0.0
  };

  const resp = await axios.post(url, body, { headers, timeout: 120000 });
  const choice = resp.data?.choices?.[0];
  if (choice?.message?.content) return choice.message.content;
  if (choice?.text) return choice.text;
  return JSON.stringify(resp.data);
}

// ---------- Voice recording logic ----------
function startRecording(connection, guildId) {
  const receiver = connection.receiver;
  const basePath = getRecordingPath(guildId);
  const pcmPath = `${basePath}.pcm`;
  const wavPath = `${basePath}.wav`;
  
  const pcmWriter = fs.createWriteStream(pcmPath);
  const userStreams = new Map();

  connection.receiver.speaking.on('start', (userId) => {
    try {
      if (userStreams.has(userId)) {
        console.log('User already being recorded:', userId);
        return;
      }
      
      console.log('Recording started for user', userId);
      
      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual }
      });
      
      // Create a new decoder for this user
      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      });
      
      // Store both stream and decoder
      userStreams.set(userId, { opusStream, decoder });
      
      // Pipeline: Opus -> Decoder -> PCM file
      opusStream.pipe(decoder);
      decoder.pipe(pcmWriter, { end: false });
      
      opusStream.on('error', (err) => {
        console.error(`Opus stream error for user ${userId}:`, err);
        cleanup(userId);
      });
      
      decoder.on('error', (err) => {
        console.error(`Decoder error for user ${userId}:`, err);
        cleanup(userId);
      });
      
      opusStream.on('end', () => {
        console.log(`Opus stream ended for user ${userId}`);
        cleanup(userId);
      });
      
      function cleanup(id) {
        const streams = userStreams.get(id);
        if (streams) {
          try {
            streams.opusStream.destroy();
            streams.decoder.destroy();
          } catch (e) {
            console.error('Cleanup error:', e);
          }
          userStreams.delete(id);
        }
      }
      
    } catch (err) {
      console.error('Error subscribing to user stream:', err);
    }
  });

  connection.receiver.speaking.on('end', (userId) => {
    console.log('User stopped speaking:', userId);
  });

  // Store the active recording session
  activeRecordings.set(guildId, {
    connection,
    pcmPath,
    wavPath,
    pcmWriter,
    userStreams
  });

  return wavPath;
}

async function stopRecording(guildId) {
  const s = activeRecordings.get(guildId);
  if (!s) throw new Error('No recording session');

  console.log('Stopping recording...');

  // Clean up all user streams
  for (const [userId, streams] of s.userStreams) {
    try {
      streams.opusStream.destroy();
      streams.decoder.destroy();
      console.log(`Cleaned up streams for user ${userId}`);
    } catch (err) {
      console.error(`Error cleaning up user ${userId}:`, err);
    }
  }
  s.userStreams.clear();

  // Close PCM writer
  s.pcmWriter.end();
  
  // Wait for file to be written
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Convert PCM to WAV using FFmpeg
  console.log('Converting PCM to WAV...');
  await new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-f', 's16le',           // Input format: signed 16-bit little endian
      '-ar', '48000',          // Sample rate
      '-ac', '2',              // Channels
      '-i', s.pcmPath,         // Input file
      '-acodec', 'pcm_s16le',  // Output codec
      '-f', 'wav',             // Output format
      s.wavPath                // Output file
    ];

    const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { 
      stdio: ['pipe', 'pipe', 'pipe'] 
    });
    
    ffmpeg.stdout.on('data', (data) => {
      console.log('FFmpeg stdout:', data.toString());
    });
    
    ffmpeg.stderr.on('data', (data) => {
      console.log('FFmpeg stderr:', data.toString());
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg finished with code ${code}`);
      if (code === 0) {
        // Clean up PCM file
        try {
          fs.unlinkSync(s.pcmPath);
        } catch (e) {
          console.warn('Could not delete PCM file:', e.message);
        }
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      console.error('FFmpeg error:', err);
      reject(err);
    });
  });

  // Destroy voice connection
  try {
    const conn = getVoiceConnection(s.connection.joinConfig.guildId);
    if (conn) conn.destroy();
  } catch (e) {
    console.warn('Error destroying connection:', e.message);
  }

  // Remove from active recordings
  activeRecordings.delete(guildId);
  
  // Verify the WAV file was created and has content
  if (!fs.existsSync(s.wavPath)) {
    throw new Error(`WAV file was not created: ${s.wavPath}`);
  }
  
  const stats = fs.statSync(s.wavPath);
  console.log(`Final WAV file: ${s.wavPath} (${stats.size} bytes)`);
  
  if (stats.size < 1000) { // Less than 1KB probably means no actual audio
    throw new Error(`Recording appears to be empty or too short (${stats.size} bytes). Make sure people are speaking during the recording.`);
  }
  
  return s.wavPath;
}

// ---------- Discord bot + slash commands ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('record').setDescription('Start/stop recording')
      .addStringOption(opt => opt.setName('action').setDescription('start or stop').setRequired(true)
        .addChoices({ name: 'start', value: 'start' }, { name: 'stop', value: 'stop' })),
    new SlashCommandBuilder().setName('summary').setDescription('Get summary of last recording'),
    new SlashCommandBuilder().setName('ask').setDescription('Ask about last recording')
      .addStringOption(opt => opt.setName('question').setDescription('question about recording').setRequired(true))
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Registered slash commands globally.');
}

client.once('clientReady', async () => {
  console.log('Bot ready:', client.user.tag);
  try {
    await registerCommands();
  } catch (err) {
    console.warn('Could not register commands automatically:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'record') {
    const action = interaction.options.getString('action');
    if (action === 'start') {
      const member = interaction.member;
      const vc = member?.voice?.channel;
      if (!vc) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

      // Check if already recording
      if (activeRecordings.has(vc.guild.id)) {
        return interaction.reply({ content: 'Already recording in this server.', ephemeral: true });
      }

      try {
        await interaction.deferReply();
        
        const conn = joinVoiceChannel({
          channelId: vc.id,
          guildId: vc.guild.id,
          adapterCreator: vc.guild.voiceAdapterCreator,
        });

        const filepath = startRecording(conn, vc.guild.id);
        await interaction.editReply({ 
          content: `Started recording in ${vc.name}. Speak clearly into your microphone. Use \`/record stop\` when finished.` 
        });
      } catch (err) {
        console.error('Error starting recording:', err);
        await interaction.editReply({ content: `Error starting recording: ${err.message}` });
      }
    } else if (action === 'stop') {
      try {
        const guildId = interaction.guildId;
        if (!activeRecordings.has(guildId)) {
          return interaction.reply({ content: 'No active recording.', ephemeral: true });
        }
        
        await interaction.deferReply();
        await interaction.editReply({ content: 'Stopping recording and processing audio...' });
        
        const filePath = await stopRecording(guildId);
        
        await interaction.editReply({ content: 'Recording stopped. Starting transcription with Deepgram...' });
        
        const transcript = await transcribeWithDeepgram(filePath);

        if (!transcript || transcript.trim().length === 0) {
          await interaction.editReply({ 
            content: 'No speech detected in the recording. Make sure people speak clearly and loudly enough for Discord to pick up.' 
          });
          return;
        }

        // Store transcript separately from active recording sessions
        transcripts.set(guildId, { 
          transcript, 
          transcriptFile: filePath,
          timestamp: Date.now()
        });
        
        await interaction.editReply({ 
          content: `Transcription completed! Found ${transcript.length} characters of text.\n\nPreview: "${transcript.substring(0, 100)}${transcript.length > 100 ? '...' : ''}"\n\nUse \`/summary\` or \`/ask\` to analyze the recording.` 
        });
        
      } catch (err) {
        console.error('Error in stop recording:', err);
        const errorMsg = err.message.includes('corrupt or unsupported data') 
          ? 'Audio file appears to be corrupted. This can happen if no clear speech was detected or if there are audio driver issues. Try recording again with clearer speech.'
          : `Error processing recording: ${err.message}`;
          
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: errorMsg });
          } else {
            await interaction.reply({ content: errorMsg, ephemeral: true });
          }
        } catch (replyErr) {
          console.error('Could not send error response:', replyErr);
        }
      }
    }
  } else if (commandName === 'summary') {
    const guildId = interaction.guildId;
    const transcriptData = transcripts.get(guildId);
    if (!transcriptData || !transcriptData.transcript) {
      return interaction.reply({ 
        content: 'No transcript available. Record a conversation first using `/record start` and `/record stop`.', 
        ephemeral: true 
      });
    }
    
    await interaction.deferReply();

    const prompt = `Summarize the following meeting transcript into:
1) Short meeting summary (2-3 sentences)
2) Key bullet points (5)
3) Action items (list)
4) Decisions made (list)

Transcript:
${transcriptData.transcript}`;

    try {
      const summary = await callDobby(prompt, 'You are an assistant that summarizes meeting transcripts. Produce clear bullets and action items.');
      
      // Split into chunks if too long for Discord
      if (summary.length > 1900) {
        const chunks = summary.match(/.{1,1900}(?:\s|$)/g) || [summary];
        await interaction.editReply({ content: `**Meeting Summary (via Dobby)**\n${chunks[0]}` });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i] });
        }
      } else {
        await interaction.editReply({ content: `**Meeting Summary (via Dobby)**\n${summary}` });
      }
    } catch (err) {
      console.error('Error calling Dobby:', err);
      await interaction.editReply({ content: 'Error calling Dobby: ' + err.message });
    }
  } else if (commandName === 'ask') {
    const guildId = interaction.guildId;
    const transcriptData = transcripts.get(guildId);
    if (!transcriptData || !transcriptData.transcript) {
      return interaction.reply({ 
        content: 'No transcript available. Record a conversation first using `/record start` and `/record stop`.', 
        ephemeral: true 
      });
    }
    
    const question = interaction.options.getString('question');
    await interaction.deferReply();

    const prompt = `You are an assistant that answers questions based on a meeting transcript. 

Transcript: ${transcriptData.transcript}

Question: ${question}

Answer concisely and reference the part of the transcript that supports your answer if possible.`;

    try {
      const answer = await callDobby(prompt, 'You are an assistant specialized in extracting facts from transcripts.');
      await interaction.editReply({ content: `**Answer:**\n${answer}` });
    } catch (err) {
      console.error('Error calling Dobby:', err);
      await interaction.editReply({ content: 'Error calling Dobby: ' + err.message });
    }
  }
});

// Error handling
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

client.on('warn', (warning) => {
  console.warn('Discord client warning:', warning);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Gracefully shut down
  client.destroy();
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  
  // Stop all active recordings
  for (const [guildId, session] of activeRecordings) {
    try {
      stopRecording(guildId);
    } catch (e) {
      console.error('Error stopping recording during shutdown:', e);
    }
  }
  
  client.destroy();
  process.exit(0);
});

console.log('Starting Discord bot...');
client.login(DISCORD_TOKEN);