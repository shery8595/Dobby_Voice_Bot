/**
 * Discord voice recorder -> Supabase Storage -> Deepgram transcription -> Fireworks (Dobby) summarization & Q/A
 * Enhanced version with Supabase database and file storage
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');

// Environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const FIREWORK_API_KEY = process.env.FIREWORK_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOBBY_MODEL = process.env.DOBBY_MODEL || 'accounts/sentientfoundation/models/dobby-unhinged-llama-3-3-70b-new';
const FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

// Initialize Supabase client with Service Role Key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- Session management ----------
const activeRecordings = new Map(); // For active recording sessions

// ---------- Supabase Database Functions ----------
async function saveRecordingToDatabase(guildId, userId, title, fileUrl) {
  const { data, error } = await supabase
    .from('recordings')
    .insert([
      {
        guild_id: guildId,
        user_id: userId,
        title: title,
        file_url: fileUrl,
        created_at: new Date().toISOString()
      }
    ])
    .select()
    .single();

  if (error) {
    console.error('Database insert error:', error);
    throw new Error(`Failed to save recording to database: ${error.message}`);
  }

  return data;
}

async function getRecordings(guildId, limit = 10) {
  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Database query error:', error);
    throw new Error(`Failed to fetch recordings: ${error.message}`);
  }

  return data || [];
}

async function getRecordingById(recordingId) {
  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('id', recordingId)
    .single();

  if (error) {
    console.error('Database query error:', error);
    throw new Error(`Failed to fetch recording: ${error.message}`);
  }

  return data;
}

// ---------- Supabase Storage Functions ----------
async function uploadRecordingToSupabase(filePath, guildId) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const fileName = `${guildId}_${Date.now()}.wav`;
  const fileBuffer = fs.readFileSync(filePath);

  const { data, error } = await supabase.storage
    .from('recordings')
    .upload(fileName, fileBuffer, {
      contentType: 'audio/wav',
      cacheControl: '3600',
      upsert: false
    });

  if (error) {
    console.error('Storage upload error:', error);
    throw new Error(`Failed to upload to Supabase: ${error.message}`);
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('recordings')
    .getPublicUrl(fileName);

  return {
    path: data.path,
    fullPath: data.fullPath,
    publicUrl: urlData.publicUrl
  };
}

async function downloadRecordingFromSupabase(fileName) {
  const { data, error } = await supabase.storage
    .from('recordings')
    .download(fileName);

  if (error) {
    console.error('Storage download error:', error);
    throw new Error(`Failed to download from Supabase: ${error.message}`);
  }

  return data; // This is a Blob
}

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

// Transcribe from Supabase stored file
async function transcribeSupabaseFile(fileName) {
  const blob = await downloadRecordingFromSupabase(fileName);
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  const url = 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true';
  const headers = {
    'Authorization': `Token ${DEEPGRAM_API_KEY}`,
    'Content-Type': 'audio/wav'
  };

  try {
    const response = await axios.post(url, buffer, { headers, timeout: 120000 });
    
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
      
      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      });
      
      userStreams.set(userId, { opusStream, decoder });
      
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

  s.pcmWriter.end();
  await new Promise(resolve => setTimeout(resolve, 7000)); // increase flush time for cloud

  // Check PCM size before conversion
  if (!fs.existsSync(s.pcmPath)) {
    throw new Error(`PCM file not found: ${s.pcmPath}`);
  }
  const pcmSize = fs.statSync(s.pcmPath).size;
  console.log(`PCM file size: ${pcmSize} bytes`);
  if (pcmSize < 100) {
    throw new Error(`Recording PCM appears empty (${pcmSize} bytes). Make sure people are speaking.`);
  }

  console.log('Converting PCM to WAV...');
  await new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', s.pcmPath,
      '-acodec', 'pcm_s16le',
      '-f', 'wav',
      s.wavPath
    ];

    const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { 
      stdio: ['pipe', 'pipe', 'pipe'] 
    });
    
    ffmpeg.stdout.on('data', (data) => console.log('FFmpeg stdout:', data.toString()));
    ffmpeg.stderr.on('data', (data) => console.log('FFmpeg stderr:', data.toString()));
    
    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg finished with code ${code}`);
      if (code === 0) {
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

  try {
    const conn = getVoiceConnection(s.connection.joinConfig.guildId);
    if (conn) conn.destroy();
  } catch (e) {
    console.warn('Error destroying connection:', e.message);
  }

  activeRecordings.delete(guildId);
  
  if (!fs.existsSync(s.wavPath)) {
    throw new Error(`WAV file was not created: ${s.wavPath}`);
  }
  
  const stats = fs.statSync(s.wavPath);
  console.log(`Final WAV file: ${s.wavPath} (${stats.size} bytes)`);
  
  if (stats.size < 1000) {
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
        .addChoices({ name: 'start', value: 'start' }, { name: 'stop', value: 'stop' }))
      .addStringOption(opt => opt.setName('title').setDescription('Title for the recording (when stopping)')),
    
    new SlashCommandBuilder().setName('recordings').setDescription('List all recordings for this server'),
    
    new SlashCommandBuilder().setName('select').setDescription('Select a recording to analyze')
      .addStringOption(opt => opt.setName('recording_id').setDescription('Recording ID').setRequired(true)),
    
    new SlashCommandBuilder().setName('summary').setDescription('Get summary of selected recording'),
    
    new SlashCommandBuilder().setName('ask').setDescription('Ask about selected recording')
      .addStringOption(opt => opt.setName('question').setDescription('Question about recording').setRequired(true))
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Registered slash commands globally.');
}

// Store selected recording per guild
const selectedRecordings = new Map();

client.once('clientReady', async () => {
  console.log('Bot ready:', client.user.tag);
  try {
    await registerCommands();
  } catch (err) {
    console.warn('Could not register commands automatically:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'select_recording') {
      const recordingId = interaction.values[0];
      selectedRecordings.set(interaction.guildId, recordingId);
      
      try {
        const recording = await getRecordingById(recordingId);
        await interaction.reply({
          content: `Selected recording: **${recording.title}**\nCreated: ${new Date(recording.created_at).toLocaleString()}\n\nYou can now use \`/summary\` or \`/ask\` to analyze this recording.`,
          ephemeral: true
        });
      } catch (err) {
        await interaction.reply({
          content: `Error selecting recording: ${err.message}`,
          ephemeral: true
        });
      }
    }
    return;
  }

  const { commandName } = interaction;

  if (commandName === 'record') {
    const action = interaction.options.getString('action');
    
    if (action === 'start') {
      const member = interaction.member;
      const vc = member?.voice?.channel;
      if (!vc) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });

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

        startRecording(conn, vc.guild.id);
        await interaction.editReply({ 
          content: `🔴 Started recording in ${vc.name}. Speak clearly into your microphone. Use \`/record stop\` when finished.` 
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
        await interaction.editReply({ content: '⏹️ Stopping recording and processing audio...' });
        
        const filePath = await stopRecording(guildId);
        await interaction.editReply({ content: '📤 Uploading recording to Supabase...' });
        
        // Upload to Supabase
        const uploadResult = await uploadRecordingToSupabase(filePath, guildId);
        
        // Get title from user input or generate default
        const title = interaction.options.getString('title') || `Recording ${new Date().toLocaleDateString()}`;
        
        // Save to database
        const dbRecord = await saveRecordingToDatabase(
          guildId, 
          interaction.user.id, 
          title, 
          uploadResult.publicUrl
        );
        
        // Clean up local file
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn('Could not delete local file:', e.message);
        }
        
        await interaction.editReply({ 
          content: `✅ Recording saved successfully!\n**Title:** ${title}\n**ID:** ${dbRecord.id}\n\nUse \`/recordings\` to see all recordings or \`/select\` to analyze this one.` 
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
    
  } else if (commandName === 'recordings') {
    try {
      await interaction.deferReply();
      
      const recordings = await getRecordings(interaction.guildId);
      
      if (recordings.length === 0) {
        await interaction.editReply({ 
          content: 'No recordings found for this server. Use `/record start` to create your first recording!' 
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📼 Server Recordings')
        .setColor(0x00AE86)
        .setDescription(`Found ${recordings.length} recording(s)`);

      // Add fields for each recording
      recordings.forEach((recording, index) => {
        const date = new Date(recording.created_at).toLocaleString();
        embed.addFields({
          name: `${index + 1}. ${recording.title}`,
          value: `ID: \`${recording.id}\`\nCreated: ${date}`,
          inline: true
        });
      });

      // Create select menu for recordings
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_recording')
        .setPlaceholder('Choose a recording to analyze...')
        .setMaxValues(1);

      recordings.forEach(recording => {
        selectMenu.addOptions({
          label: recording.title,
          description: `Created: ${new Date(recording.created_at).toLocaleDateString()}`,
          value: recording.id.toString()
        });
      });

      const row = new ActionRowBuilder().addComponents(selectMenu);

      await interaction.editReply({ 
        embeds: [embed],
        components: [row]
      });
      
    } catch (err) {
      console.error('Error fetching recordings:', err);
      await interaction.editReply({ content: `Error fetching recordings: ${err.message}` });
    }
    
  } else if (commandName === 'select') {
    const recordingId = interaction.options.getString('recording_id');
    
    try {
      const recording = await getRecordingById(recordingId);
      
      if (recording.guild_id !== interaction.guildId) {
        return interaction.reply({ 
          content: 'This recording does not belong to this server.', 
          ephemeral: true 
        });
      }
      
      selectedRecordings.set(interaction.guildId, recordingId);
      
      await interaction.reply({
        content: `Selected recording: **${recording.title}**\nCreated: ${new Date(recording.created_at).toLocaleString()}\n\nYou can now use \`/summary\` or \`/ask\` to analyze this recording.`,
        ephemeral: true
      });
      
    } catch (err) {
      await interaction.reply({
        content: `Error selecting recording: ${err.message}`,
        ephemeral: true
      });
    }
    
  } else if (commandName === 'summary') {
    const guildId = interaction.guildId;
    const selectedRecordingId = selectedRecordings.get(guildId);
    
    if (!selectedRecordingId) {
      return interaction.reply({ 
        content: 'No recording selected. Use `/recordings` to list and select a recording first.', 
        ephemeral: true 
      });
    }
    
    await interaction.deferReply();

    try {
      const recording = await getRecordingById(selectedRecordingId);
      
      await interaction.editReply({ content: '🔍 Transcribing recording with Deepgram...' });
      
      // Extract filename from URL
      const fileName = recording.file_url.split('/').pop().split('?')[0];
      const transcript = await transcribeSupabaseFile(fileName);
      
      if (!transcript || transcript.trim().length === 0) {
        await interaction.editReply({ 
          content: 'No speech detected in the recording. The audio might be too quiet or contain no clear speech.' 
        });
        return;
      }

      await interaction.editReply({ content: '🤖 Generating summary with Dobby...' });

      const prompt = `Summarize the following meeting transcript into:
1) Short meeting summary (2-3 sentences)
2) Key bullet points (5)
3) Action items (list)
4) Decisions made (list)

Transcript:
${transcript}`;

      const summary = await callDobby(prompt, 'You are an assistant that summarizes meeting transcripts. Produce clear bullets and action items.');
      
      if (summary.length > 1900) {
        const chunks = summary.match(/.{1,1900}(?:\s|$)/g) || [summary];
        await interaction.editReply({ content: `**Meeting Summary: ${recording.title}**\n${chunks[0]}` });
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i] });
        }
      } else {
        await interaction.editReply({ content: `**Meeting Summary: ${recording.title}**\n${summary}` });
      }
    } catch (err) {
      console.error('Error generating summary:', err);
      await interaction.editReply({ content: `Error generating summary: ${err.message}` });
    }
    
  } else if (commandName === 'ask') {
    const guildId = interaction.guildId;
    const selectedRecordingId = selectedRecordings.get(guildId);
    
    if (!selectedRecordingId) {
      return interaction.reply({ 
        content: 'No recording selected. Use `/recordings` to list and select a recording first.', 
        ephemeral: true 
      });
    }
    
    const question = interaction.options.getString('question');
    await interaction.deferReply();

    try {
      const recording = await getRecordingById(selectedRecordingId);
      
      await interaction.editReply({ content: '🔍 Transcribing recording with Deepgram...' });
      
      // Extract filename from URL
      const fileName = recording.file_url.split('/').pop().split('?')[0];
      const transcript = await transcribeSupabaseFile(fileName);
      
      if (!transcript || transcript.trim().length === 0) {
        await interaction.editReply({ 
          content: 'No speech detected in the recording. Cannot answer questions about empty transcript.' 
        });
        return;
      }

      await interaction.editReply({ content: '🤖 Analyzing with Dobby...' });

      const prompt = `You are an assistant that answers questions based on a meeting transcript. 

Transcript: ${transcript}

Question: ${question}

Answer concisely and reference the part of the transcript that supports your answer if possible.`;

      const answer = await callDobby(prompt, 'You are an assistant specialized in extracting facts from transcripts.');
      await interaction.editReply({ content: `**Question:** ${question}\n**Answer:**\n${answer}` });
    } catch (err) {
      console.error('Error answering question:', err);
      await interaction.editReply({ content: `Error answering question: ${err.message}` });
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
  client.destroy();
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  
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

console.log('Starting Discord bot with Supabase integration...');
client.login(DISCORD_TOKEN);


