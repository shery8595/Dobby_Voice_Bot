/**
 * Discord voice recorder -> Supabase Storage -> Deepgram transcription -> Fireworks (Dobby) summarization & Q/A
 * Enhanced version with Supabase database and file storage - FIXED VERSION
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

// ---------- FIXED Voice recording logic ----------
function startRecording(connection, guildId) {
  const receiver = connection.receiver;
  const basePath = getRecordingPath(guildId);
  const pcmPath = `${basePath}.pcm`;
  const wavPath = `${basePath}.wav`;
  
  const pcmWriter = fs.createWriteStream(pcmPath);
  const userStreams = new Map();
  let hasReceivedAudio = false;
  let audioBuffer = Buffer.alloc(0);

  console.log(`Starting recording for guild ${guildId}, output: ${wavPath}`);

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
      
      // Use mono channel and standard sample rate for better compatibility
      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 1, // Changed to mono
        frameSize: 960
      });
      
      userStreams.set(userId, { opusStream, decoder });
      
      opusStream.pipe(decoder);
      
      // Collect audio data in memory buffer as well as writing to file
      decoder.on('data', (chunk) => {
        hasReceivedAudio = true;
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
        pcmWriter.write(chunk);
      });
      
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
    userStreams,
    hasReceivedAudio: () => hasReceivedAudio,
    getAudioBufferSize: () => audioBuffer.length
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
  
  // Wait longer for streams to finish
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Check if we actually received any audio
  const hasAudio = s.hasReceivedAudio();
  const bufferSize = s.getAudioBufferSize();
  
  console.log(`Audio received: ${hasAudio}, Buffer size: ${bufferSize} bytes`);
  
  if (!hasAudio || bufferSize < 1000) {
    // Clean up and provide helpful error
    try {
      if (fs.existsSync(s.pcmPath)) fs.unlinkSync(s.pcmPath);
      const conn = getVoiceConnection(s.connection.joinConfig.guildId);
      if (conn) conn.destroy();
    } catch (e) {
      console.warn('Error during cleanup:', e.message);
    }
    
    activeRecordings.delete(guildId);
    throw new Error('No audio was captured during recording. Please ensure:\n1. Users are speaking clearly\n2. Users are not muted\n3. Bot has proper voice permissions\n4. Users have push-to-talk disabled or are holding the key');
  }

  console.log('Converting PCM to WAV...');
  await new Promise((resolve, reject) => {
    // Updated FFmpeg arguments for mono audio
    const ffmpegArgs = [
      '-f', 's16le',        // Input format: 16-bit signed little endian PCM
      '-ar', '48000',       // Sample rate: 48kHz
      '-ac', '1',           // Audio channels: 1 (mono) - CHANGED
      '-i', s.pcmPath,      // Input file
      '-acodec', 'pcm_s16le', // Audio codec
      '-ar', '16000',       // Output sample rate: 16kHz (better for speech recognition)
      '-ac', '1',           // Output channels: 1 (mono)
      '-f', 'wav',          // Output format
      '-y',                 // Overwrite output file
      s.wavPath             // Output file
    ];

    console.log('FFmpeg command:', FFMPEG_PATH, ffmpegArgs.join(' '));

    const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { 
      stdio: ['pipe', 'pipe', 'pipe'] 
    });
    
    let stdout = '';
    let stderr = '';
    
    ffmpeg.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg finished with code ${code}`);
      if (stderr) console.log('FFmpeg stderr:', stderr);
      if (stdout) console.log('FFmpeg stdout:', stdout);
      
      if (code === 0) {
        try {
          fs.unlinkSync(s.pcmPath);
        } catch (e) {
          console.warn('Could not delete PCM file:', e.message);
        }
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}. Stderr: ${stderr}`));
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
  
  // Lower the minimum threshold since we're now using 16kHz mono
  if (stats.size < 500) {
    throw new Error(`Recording file is too small (${stats.size} bytes). This usually means:\n1. No clear speech was detected\n2. Users were muted during recording\n3. Audio input issues\n\nTry recording again with users speaking more clearly.`);
  }
  
  return s.wavPath;
}

// ---------- Interaction response helper ----------
async function safeReply(interaction, content, options = {}) {
  console.log(`Attempting to reply: deferred=${interaction.deferred}, replied=${interaction.replied}`);
  
  try {
    if (interaction.deferred) {
      console.log('Using editReply');
      return await interaction.editReply({ content, ...options });
    } else if (interaction.replied) {
      console.log('Using followUp');
      return await interaction.followUp({ content, ...options });
    } else {
      console.log('Using reply');
      return await interaction.reply({ content, ...options });
    }
  } catch (error) {
    console.error('Error sending interaction response:', error);
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
      }
    } catch (fallbackError) {
      console.error('Failed to send fallback response:', fallbackError);
    }
  }
}

// ---------- Discord bot + slash commands ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel, Partials.Guild, Partials.GuildMember]
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

client.once('ready', async () => {
  console.log('Bot ready:', client.user.tag);
  try {
    await registerCommands();
  } catch (err) {
    console.warn('Could not register commands automatically:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  console.log(`Received interaction: ${interaction.type} - ${interaction.isChatInputCommand() ? interaction.commandName : interaction.customId}`);
  
  try {
    if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'select_recording') {
        const recordingId = interaction.values[0];
        selectedRecordings.set(interaction.guildId, recordingId);
        
        try {
          const recording = await getRecordingById(recordingId);
          await safeReply(interaction, 
            `Selected recording: **${recording.title}**\nCreated: ${new Date(recording.created_at).toLocaleString()}\n\nYou can now use \`/summary\` or \`/ask\` to analyze this recording.`, 
            { ephemeral: true }
          );
        } catch (err) {
          await safeReply(interaction, `Error selecting recording: ${err.message}`, { ephemeral: true });
        }
      }
      return;
    }

    const { commandName } = interaction;

    if (commandName === 'record') {
      const action = interaction.options.getString('action');
      
      if (action === 'start') {
        try {
          // Handle null guild (mobile client issue)
          if (!interaction.guild) {
            return await safeReply(interaction, 'This command must be used in a server, not in DMs.', { ephemeral: true });
          }

          // Fetch guild to ensure it's fully loaded
          const guild = await client.guilds.fetch(interaction.guildId);
          if (!guild) {
            return await safeReply(interaction, 'Could not access server information. Please try again.', { ephemeral: true });
          }

          const member = await guild.members.fetch(interaction.user.id);
          const vc = member.voice.channel;

          if (!vc) {
            return await safeReply(interaction, 'Join a voice channel first.', { ephemeral: true });
          }

          if (activeRecordings.has(guild.id)) {
            return await safeReply(interaction, 'Already recording in this server.', { ephemeral: true });
          }

          await interaction.deferReply();
          
          const conn = joinVoiceChannel({
            channelId: vc.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
          });

          startRecording(conn, guild.id);
          await safeReply(interaction, `🔴 Started recording in ${vc.name}.\n\n**Important:** Make sure users:\n• Are not muted\n• Speak clearly\n• Have push-to-talk disabled (or hold the key while speaking)\n\nUse \`/record stop\` when finished.`);
        } catch (err) {
          console.error('Error starting recording:', err);
          await safeReply(interaction, `Error starting recording: ${err.message}`);
        }
        
      } else if (action === 'stop') {
        try {
          const guildId = interaction.guildId;
          if (!activeRecordings.has(guildId)) {
            return await safeReply(interaction, 'No active recording.', { ephemeral: true });
          }
          
          await interaction.deferReply();
          await safeReply(interaction, '⏹️ Stopping recording and processing audio...');
          
          const filePath = await stopRecording(guildId);
          await safeReply(interaction, '📤 Uploading recording to Supabase...');
          
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
          
          await safeReply(interaction, 
            `✅ Recording saved successfully!\n**Title:** ${title}\n**ID:** ${dbRecord.id}\n\nUse \`/recordings\` to see all recordings or \`/select\` to analyze this one.`
          );
          
        } catch (err) {
          console.error('Error in stop recording:', err);
          
          // More helpful error messages
          let errorMsg = err.message;
          if (err.message.includes('No audio was captured')) {
            errorMsg = `❌ **No audio captured!**\n\n${err.message}\n\n**Troubleshooting:**\n• Check that users weren't muted\n• Ensure the bot has proper voice permissions\n• Try speaking louder or closer to your microphone\n• If using push-to-talk, hold the key while speaking`;
          }
            
          await safeReply(interaction, errorMsg);
        }
      }
      
    } else if (commandName === 'recordings') {
      try {
        await interaction.deferReply();
        
        const recordings = await getRecordings(interaction.guildId);
        
        if (recordings.length === 0) {
          await safeReply(interaction, 'No recordings found for this server. Use `/record start` to create your first recording!');
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

        await safeReply(interaction, '', { embeds: [embed], components: [row] });
        
      } catch (err) {
        console.error('Error fetching recordings:', err);
        await safeReply(interaction, `Error fetching recordings: ${err.message}`);
      }
      
    } else if (commandName === 'select') {
      const recordingId = interaction.options.getString('recording_id');
      
      try {
        const recording = await getRecordingById(recordingId);
        
        if (recording.guild_id !== interaction.guildId) {
          return await safeReply(interaction, 'This recording does not belong to this server.', { ephemeral: true });
        }
        
        selectedRecordings.set(interaction.guildId, recordingId);
        
        await safeReply(interaction,
          `Selected recording: **${recording.title}**\nCreated: ${new Date(recording.created_at).toLocaleString()}\n\nYou can now use \`/summary\` or \`/ask\` to analyze this recording.`,
          { ephemeral: true }
        );
        
      } catch (err) {
        await safeReply(interaction, `Error selecting recording: ${err.message}`, { ephemeral: true });
      }
      
    } else if (commandName === 'summary') {
      const guildId = interaction.guildId;
      const selectedRecordingId = selectedRecordings.get(guildId);
      
      if (!selectedRecordingId) {
        return await safeReply(interaction, 'No recording selected. Use `/recordings` to list and select a recording first.', { ephemeral: true });
      }
      
      await interaction.deferReply();

      try {
        const recording = await getRecordingById(selectedRecordingId);
        
        await safeReply(interaction, '🔍 Transcribing recording with Deepgram...');
        
        // Extract filename from URL
        const fileName = recording.file_url.split('/').pop().split('?')[0];
        const transcript = await transcribeSupabaseFile(fileName);
        
        if (!transcript || transcript.trim().length === 0) {
          await safeReply(interaction, 'No speech detected in the recording. The audio might be too quiet or contain no clear speech.');
          return;
        }

        await safeReply(interaction, '🤖 Generating summary with Dobby...');

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
          await safeReply(interaction, `**Meeting Summary: ${recording.title}**\n${chunks[0]}`);
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i] });
          }
        } else {
          await safeReply(interaction, `**Meeting Summary: ${recording.title}**\n${summary}`);
        }
      } catch (err) {
        console.error('Error generating summary:', err);
        await safeReply(interaction, `Error generating summary: ${err.message}`);
      }
      
    } else if (commandName === 'ask') {
      const guildId = interaction.guildId;
      const selectedRecordingId = selectedRecordings.get(guildId);
      
      if (!selectedRecordingId) {
        return await safeReply(interaction, 'No recording selected. Use `/recordings` to list and select a recording first.', { ephemeral: true });
      }
      
      const question = interaction.options.getString('question');
      await interaction.deferReply();

      try {
        const recording = await getRecordingById(selectedRecordingId);
        
        await safeReply(interaction, '🔍 Transcribing recording with Deepgram...');
        
        // Extract filename from URL
        const fileName = recording.file_url.split('/').pop().split('?')[0];
        const transcript = await transcribeSupabaseFile(fileName);
        
        if (!transcript || transcript.trim().length === 0) {
          await safeReply(interaction, 'No speech detected in the recording. Cannot answer questions about empty transcript.');
          return;
        }

        await safeReply(interaction, '🤖 Analyzing with Dobby...');

        const prompt = `You are an assistant that answers questions based on a meeting transcript. 

Transcript: ${transcript}

Question: ${question}

Answer concisely and reference the part of the transcript that supports your answer if possible.`;

        const answer = await callDobby(prompt, 'You are an assistant specialized in extracting facts from transcripts.');
        await safeReply(interaction, `**Question:** ${question}\n**Answer:**\n${answer}`);
      } catch (err) {
        console.error('Error answering question:', err);
        await safeReply(interaction, `Error answering question: ${err.message}`);
      }
    }
  } catch (error) {
    console.error('Unhandled error in interaction handler:', error);
    await safeReply(interaction, 'An unexpected error occurred while processing your request.', { ephemeral: true });
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
