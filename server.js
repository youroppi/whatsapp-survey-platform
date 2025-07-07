require('dotenv').config(); // Load environment variables first

const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs').promises;
const FormData = require('form-data');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully at:', res.rows[0].now);
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Security and Environment Configuration
const requiredEnvVars = ['OPENAI_API_KEY', 'DATABASE_URL'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.warn('Warning: Missing required environment variables:', missingEnvVars.join(', '));
  if (missingEnvVars.includes('OPENAI_API_KEY')) {
    console.warn('Warning: Voice transcription features will be disabled without OPENAI_API_KEY');
  }
}

// OpenAI configuration - SECURED with environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// Voice processing configuration
const MAX_VOICE_DURATION = parseInt(process.env.MAX_VOICE_DURATION_SECONDS) || 60;
const VOICE_PROCESSING_TIMEOUT = parseInt(process.env.VOICE_PROCESSING_TIMEOUT_MS) || 30000;

// Validate OpenAI API key format (basic validation)
function validateOpenAIKey(apiKey) {
  if (!apiKey) return false;
  if (!apiKey.startsWith('sk-')) return false;
  if (apiKey.length < 20) return false;
  return true;
}

const isOpenAIConfigured = validateOpenAIKey(OPENAI_API_KEY);

if (!isOpenAIConfigured) {
  console.warn('OpenAI API key not configured or invalid. Voice transcription disabled.');
  console.warn('Set OPENAI_API_KEY environment variable to enable voice features.');
}

// Connected clients tracking
let connectedClients = new Set();

// Database helper functions
async function getOrCreateParticipant(phoneNumber) {
  const client = await pool.connect();
  try {
    // Check if participant exists
    let result = await client.query(
      'SELECT id, participant_code FROM participants WHERE phone_number = $1',
      [phoneNumber]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    
    // Create new participant with a generic code
    const participantCode = `P${Date.now().toString(36).toUpperCase()}`;
    result = await client.query(
      'INSERT INTO participants (phone_number, participant_code) VALUES ($1, $2) RETURNING id, participant_code',
      [phoneNumber, participantCode]
    );
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function getOrCreateSurveyParticipant(surveyId, participantId) {
  const client = await pool.connect();
  try {
    // Check if already exists
    let result = await client.query(
      'SELECT participant_survey_code FROM survey_participants WHERE survey_id = $1 AND participant_id = $2',
      [surveyId, participantId]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0].participant_survey_code;
    }
    
    // Get next participant code for this survey
    result = await client.query(
      'SELECT get_next_participant_code($1) as code',
      [surveyId]
    );
    
    const participantSurveyCode = result.rows[0].code;
    
    // Create survey participant record
    await client.query(
      'INSERT INTO survey_participants (survey_id, participant_id, participant_survey_code) VALUES ($1, $2, $3)',
      [surveyId, participantId, participantSurveyCode]
    );
    
    return participantSurveyCode;
  } finally {
    client.release();
  }
}

// Voice message processing functions
async function transcribeVoiceMessage(audioBuffer, fileName) {
  if (!isOpenAIConfigured) {
    throw new Error('Voice transcription not available. OpenAI API key not configured.');
  }

  try {
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: fileName,
      contentType: 'audio/ogg'
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('temperature', '0.2');

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData,
      timeout: VOICE_PROCESSING_TIMEOUT
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
    }

    const result = await response.json();
    return {
      text: result.text,
      language: result.language,
      duration: result.duration
    };
  } catch (error) {
    console.error('Voice transcription error:', error);
    throw error;
  }
}

async function translateToEnglish(text, detectedLanguage) {
  if (!isOpenAIConfigured || detectedLanguage === 'en') {
    return text;
  }

  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a professional translator. Translate the following text to English while preserving the original meaning and tone. If the text is already in English, return it as-is.'
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.3,
        max_tokens: 500
      }),
      timeout: VOICE_PROCESSING_TIMEOUT
    });

    if (!response.ok) {
      console.error('Translation API error:', response.status);
      return text;
    }

    const result = await response.json();
    return result.choices[0].message.content.trim();
  } catch (error) {
    console.error('Translation error:', error);
    return text;
  }
}

async function generateContextualSummary(transcribedText, originalText, language, questionText) {
  if (!isOpenAIConfigured) {
    return transcribedText;
  }

  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: `You are an AI assistant that creates clear, concise summaries of survey responses in relation to the question asked.

Rules:
1. Create a brief, clear summary of the user's response
2. Connect their response to the survey question context
3. Be positive and neutral - don't judge if the response is "good" or "bad"
4. Keep it concise but capture the key sentiment and meaning
5. Make it sound natural and conversational
6. Focus on what they DID say, not what they didn't say`
          },
          {
            role: 'user',
            content: `Survey Question: "${questionText}"
User's Response: "${transcribedText}"
${language !== 'en' ? `Original Language: ${language}` : ''}

Please provide a clear summary of how their response relates to the question.`
          }
        ],
        temperature: 0.3,
        max_tokens: 100
      }),
      timeout: VOICE_PROCESSING_TIMEOUT
    });

    if (!response.ok) {
      console.error('Summary API error:', response.status);
      return transcribedText;
    }

    const result = await response.json();
    return result.choices[0].message.content.trim();
  } catch (error) {
    console.error('Summary generation error:', error);
    return transcribedText;
  }
}

// WhatsApp client setup
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

let qrCodeData = null;
let isClientReady = false;

// WhatsApp client events
client.on('qr', (qr) => {
  console.log('QR Code received');
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error('Error generating QR code:', err);
      return;
    }
    qrCodeData = url;
    io.emit('qr-code', { qrCode: url });
  });
});

client.on('ready', () => {
  console.log('WhatsApp client is ready!');
  isClientReady = true;
  qrCodeData = null;
  io.emit('whatsapp-ready');
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp client disconnected:', reason);
  isClientReady = false;
  io.emit('whatsapp-disconnected');
});

// Handle incoming WhatsApp messages
client.on('message', async (message) => {
  if (message.from.endsWith('@c.us')) {
    await handleWhatsAppMessage(message);
  }
});

// Start WhatsApp client
client.initialize();

// Survey management functions
async function createSurvey(surveyData) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    
    // Generate survey ID and prefix
    const surveyId = Date.now().toString();
    const surveyPrefix = surveyData.title
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .substring(0, 10) || 'SURVEY';
    
    // Insert survey
    await dbClient.query(
      `INSERT INTO surveys (id, title, description, estimated_time, participant_prefix) 
       VALUES ($1, $2, $3, $4, $5)`,
      [surveyId, surveyData.title, surveyData.description || '', surveyData.estimatedTime, surveyPrefix]
    );
    
    // Insert questions
    for (let i = 0; i < surveyData.questions.length; i++) {
      const question = surveyData.questions[i];
      await dbClient.query(
        `INSERT INTO questions (survey_id, question_number, question_type, question_text, options, scale)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          surveyId,
          i + 1,
          question.type,
          question.question,
          question.type === 'multiple' || question.type === 'curated' ? JSON.stringify(question.options) : null,
          question.type === 'likert' ? JSON.stringify(question.scale) : null
        ]
      );
    }
    
    await dbClient.query('COMMIT');
    
    // Return the created survey
    const result = await dbClient.query(
      'SELECT * FROM surveys WHERE id = $1',
      [surveyId]
    );
    
    return {
      ...result.rows[0],
      questions: surveyData.questions
    };
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error('Error creating survey:', error);
    throw error;
  } finally {
    dbClient.release();
  }
}

async function activateSurvey(surveyId) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    
    // Deactivate all surveys
    await dbClient.query('UPDATE surveys SET is_active = false');
    
    // Activate the specified survey
    const result = await dbClient.query(
      'UPDATE surveys SET is_active = true WHERE id = $1 RETURNING *',
      [surveyId]
    );
    
    await dbClient.query('COMMIT');
    
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    return null;
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error('Error activating survey:', error);
    throw error;
  } finally {
    dbClient.release();
  }
}

async function getActiveSurvey() {
  try {
    const result = await pool.query(
      'SELECT * FROM surveys WHERE is_active = true LIMIT 1'
    );
    
    if (result.rows.length > 0) {
      const survey = result.rows[0];
      
      // Get questions for the survey
      const questionsResult = await pool.query(
        'SELECT * FROM questions WHERE survey_id = $1 ORDER BY question_number',
        [survey.id]
      );
      
      survey.questions = questionsResult.rows.map(q => ({
        id: q.id,
        type: q.question_type,
        question: q.question_text,
        options: q.options,
        scale: q.scale
      }));
      
      return survey;
    }
    return null;
  } catch (error) {
    console.error('Error getting active survey:', error);
    return null;
  }
}

// Session management
async function getOrCreateSession(phoneNumber, activeSurvey) {
  const dbClient = await pool.connect();
  try {
    // Get participant
    const participant = await getOrCreateParticipant(phoneNumber);
    
    // Check for existing session
    let result = await dbClient.query(
      'SELECT * FROM sessions WHERE phone_number = $1 AND survey_id = $2',
      [phoneNumber, activeSurvey.id]
    );
    
    if (result.rows.length > 0) {
      const session = result.rows[0];
      return {
        ...session,
        sessionData: session.session_data || {},
        session_data: session.session_data || {}
      };
    }
    
    // Create new session
    result = await dbClient.query(
      `INSERT INTO sessions (phone_number, survey_id, participant_id, session_data, current_question, stage)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [phoneNumber, activeSurvey.id, participant.id, JSON.stringify({}), 0, 'initial']
    );
    
    return {
      ...result.rows[0],
      sessionData: {},
      session_data: {}
    };
  } finally {
    dbClient.release();
  }
}

async function updateSession(sessionId, updates) {
  try {
    const setClause = [];
    const values = [];
    let paramCount = 1;
    
    if (updates.currentQuestion !== undefined) {
      setClause.push(`current_question = ${paramCount}`);
      values.push(updates.currentQuestion);
      paramCount++;
    }
    
    if (updates.current_question !== undefined) {
      setClause.push(`current_question = ${paramCount}`);
      values.push(updates.current_question);
      paramCount++;
    }
    
    if (updates.stage !== undefined) {
      setClause.push(`stage = ${paramCount}`);
      values.push(updates.stage);
      paramCount++;
    }
    
    if (updates.sessionData !== undefined) {
      setClause.push(`session_data = ${paramCount}`);
      values.push(JSON.stringify(updates.sessionData));
      paramCount++;
    }
    
    values.push(sessionId);
    
    await pool.query(
      `UPDATE sessions SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ${paramCount}`,
      values
    );
    
    console.log(`Updated session ${sessionId}: ${setClause.join(', ')}`);
  } catch (error) {
    console.error('Error updating session:', error);
  }
}

// WhatsApp message handling
async function handleWhatsAppMessage(message) {
  const phoneNumber = message.from;
  const isVoiceMessage = message.type === 'ptt' || message.type === 'audio';
  const messageText = isVoiceMessage ? '[Voice Message]' : message.body.toLowerCase().trim();
  
  console.log(`Received ${isVoiceMessage ? 'voice' : 'text'} message from ${phoneNumber}`);
  
  const activeSurvey = await getActiveSurvey();
  
  if (!activeSurvey) {
    await client.sendMessage(phoneNumber, 
      "Hello! There's no active survey at the moment. Please check back later!"
    );
    return;
  }
  
  // Get or create session
  const session = await getOrCreateSession(phoneNumber, activeSurvey);
  
  console.log(`Session stage: ${session.stage}, Current question: ${session.current_question}`);
  
  // Handle different conversation stages
  switch (session.stage) {
    case 'initial':
      await handleInitialMessage(phoneNumber, session, activeSurvey);
      break;
    case 'survey':
      await handleSurveyResponse(phoneNumber, session, activeSurvey, messageText, isVoiceMessage, message);
      break;
    case 'followup':
      await handleFollowUpResponse(phoneNumber, session, activeSurvey, messageText, isVoiceMessage, message);
      break;
    case 'voice_confirmation':
      await handleVoiceConfirmation(phoneNumber, session, activeSurvey, messageText);
      break;
  }
}

async function handleInitialMessage(phoneNumber, session, survey) {
  // Get or create survey participant
  const participantCode = await getOrCreateSurveyParticipant(survey.id, session.participant_id);
  
  // Update session
  await updateSession(session.id, {
    stage: 'survey',
    sessionData: { participantCode }
  });
  
  // Send welcome message (without participant ID)
  let welcomeMessage = `Welcome to our survey! 📊\n\n*${survey.title}*\n\n`;
  
  // Add custom description if available
  if (survey.description && survey.description.trim()) {
    welcomeMessage += `${survey.description}\n\n`;
  }
  
  welcomeMessage += `This will take about ${survey.estimated_time || '3-5'} minutes. Let's get started!`;
  
  await client.sendMessage(phoneNumber, welcomeMessage);
  await sendCurrentQuestion(phoneNumber, session, survey);
  
  broadcastSurveyStats();
}

async function sendCurrentQuestion(phoneNumber, session, survey) {
  const question = survey.questions[session.current_question];
  if (!question) return;

  let questionText = `*Question ${session.current_question + 1}/${survey.questions.length}*\n\n${question.question}\n\n`;
  
  switch (question.type) {
    case 'curated':
      questionText += question.options.map((option, index) => 
        `${index + 1}. ${option}`
      ).join('\n');
      questionText += '\n\nReply with the number of your choice (1, 2, 3...)';
      break;
    
    case 'multiple':
      questionText += question.options.map((option, index) => 
        `${index + 1}. ${option}`
      ).join('\n');
      questionText += '\n\nReply with the number of your choice (1, 2, 3...)';
      break;
    
    case 'likert':
      const scale = question.scale;
      questionText += `Rate from ${scale.min} to ${scale.max}\n`;
      questionText += `${scale.min} = ${scale.labels[0]}\n`;
      questionText += `${scale.max} = ${scale.labels[1]}\n\n`;
      questionText += `Reply with a number from ${scale.min} to ${scale.max}`;
      break;
    
    case 'text':
      questionText += 'Please type your answer:';
      break;
  }
  
  await client.sendMessage(phoneNumber, questionText);
}

async function handleSurveyResponse(phoneNumber, session, survey, messageText, isVoiceMessage, message) {
  const question = survey.questions[session.current_question];
  let selectedAnswer = null;
  let isValidAnswer = false;

  if (isVoiceMessage) {
    await client.sendMessage(phoneNumber, 
      "I received your voice message! For survey questions, please respond with the number of your choice or type your answer. You can use voice messages for follow-up explanations!"
    );
    return;
  }

  // Parse answer based on question type
  switch (question.type) {
    case 'curated':
    case 'multiple':
      const choiceIndex = parseInt(messageText) - 1;
      if (choiceIndex >= 0 && choiceIndex < question.options.length) {
        selectedAnswer = question.options[choiceIndex];
        isValidAnswer = true;
      }
      break;
    
    case 'likert':
      const rating = parseInt(messageText);
      const scale = question.scale;
      if (rating >= scale.min && rating <= scale.max) {
        selectedAnswer = rating;
        isValidAnswer = true;
      }
      break;
    
    case 'text':
      selectedAnswer = messageText;
      isValidAnswer = true;
      break;
  }

  if (!isValidAnswer) {
    await client.sendMessage(phoneNumber, 
      "Sorry, I didn't understand that. Please try again with a valid option."
    );
    return;
  }

  // Store the answer temporarily in session
  const sessionData = {
    ...session.sessionData,
    pendingAnswer: {
      questionId: question.id,
      answer: selectedAnswer,
      questionType: question.type,
      questionText: question.question
    }
  };
  
  await updateSession(session.id, {
    stage: 'followup',
    sessionData
  });

  // Create contextual follow-up message based on the answer
  let followUpMessage = '';
  
  if (question.type === 'curated' || question.type === 'multiple') {
    // For agree/disagree or multiple choice
    if (question.type === 'curated' && question.options) {
      if (selectedAnswer.toLowerCase() === 'agree') {
        followUpMessage = `Great to hear you agree! I'd love to understand what makes you feel positive about this.`;
      } else if (selectedAnswer.toLowerCase() === 'disagree') {
        followUpMessage = `I understand you disagree with this statement. Could you share what concerns you have?`;
      } else if (selectedAnswer.toLowerCase() === 'undecided') {
        followUpMessage = `I see you're undecided. What factors are making it difficult to decide?`;
      } else {
        followUpMessage = `Thank you for selecting "${selectedAnswer}". Could you tell me more about your choice?`;
      }
    } else {
      followUpMessage = `You selected "${selectedAnswer}". I'd love to hear more about why you chose this option.`;
    }
  } else if (question.type === 'likert') {
    const rating = parseInt(selectedAnswer);
    const scale = question.scale;
    if (rating <= scale.min + 1) {
      followUpMessage = `I see you gave a low rating of ${rating}. What aspects need improvement?`;
    } else if (rating >= scale.max - 1) {
      followUpMessage = `Wonderful! You gave a high rating of ${rating}. What did you particularly like?`;
    } else {
      followUpMessage = `You rated this ${rating} out of ${scale.max}. What influenced your rating?`;
    }
  } else {
    followUpMessage = `Thank you for your response. Could you elaborate a bit more?`;
  }
  
  followUpMessage += `\n\nYou can:\n🎤 Send a voice message (I'll transcribe it)\n💬 Type your response\n⏭️ Type 'skip' to continue\n\nI'd love to hear your thoughts!`;
  
  await client.sendMessage(phoneNumber, followUpMessage);
}

async function handleFollowUpResponse(phoneNumber, session, survey, messageText, isVoiceMessage, message) {
  let followUpText = '';

  if (isVoiceMessage) {
    if (!isOpenAIConfigured) {
      await client.sendMessage(phoneNumber, 
        "I received your voice message, but voice transcription is not available right now. Could you please type your response instead? Or type 'skip' to continue."
      );
      return;
    }

    try {
      await client.sendMessage(phoneNumber, "🎵 Processing your voice message... This may take a moment!");

      const media = await message.downloadMedia();
      const audioBuffer = Buffer.from(media.data, 'base64');
      
      if (audioBuffer.length > MAX_VOICE_DURATION * 1024 * 1024) {
        await client.sendMessage(phoneNumber, 
          `Voice message is too long. Please keep it under ${MAX_VOICE_DURATION} seconds and try again.`
        );
        return;
      }
      
      const transcription = await transcribeVoiceMessage(audioBuffer, 'voice_message.ogg');
      const translatedText = await translateToEnglish(transcription.text, transcription.language);
      
      const question = survey.questions[session.current_question];
      const summary = await generateContextualSummary(translatedText, transcription.text, transcription.language, question.question);
      
      let confirmationMessage = `🎤 Here's what you said:\n\n"${transcription.text}"`;
      
      if (transcription.language !== 'en') {
        confirmationMessage += `\n\nTranslated: "${translatedText}"`;
      }
      
      confirmationMessage += `\n\n📝 Summary of your response:\n"${summary}"`;
      confirmationMessage += `\n\nIs this what you meant?\n✅ Type 'yes' to confirm\n❌ Type 'no' to try again\n⏭️ Type 'skip' to continue without this response`;
      
      const sessionData = {
        ...session.sessionData,
        pendingVoiceValidation: {
          originalText: transcription.text,
          translatedText: translatedText,
          summary: summary,
          language: transcription.language,
          duration: transcription.duration
        }
      };
      
      await updateSession(session.id, {
        stage: 'voice_confirmation',
        sessionData
      });
      
      await client.sendMessage(phoneNumber, confirmationMessage);
      return;
      
    } catch (error) {
      console.error('Voice processing error:', error);
      
      let errorMessage = "Sorry, I couldn't process your voice message.";
      
      if (error.message.includes('API key')) {
        errorMessage = "Voice transcription service is temporarily unavailable.";
      } else if (error.message.includes('timeout')) {
        errorMessage = "Voice processing timed out. Please try a shorter message.";
      } else if (error.message.includes('rate limit')) {
        errorMessage = "Too many requests. Please wait a moment and try again.";
      }
      
      errorMessage += "\n\nPlease try again or type your response instead.";
      
      await client.sendMessage(phoneNumber, errorMessage);
      return;
    }
  } else {
    followUpText = messageText;
  }

  await processFollowUpResponse(phoneNumber, session, survey, followUpText);
}

async function handleVoiceConfirmation(phoneNumber, session, survey, messageText) {
  const response = messageText.toLowerCase().trim();
  const sessionData = session.sessionData || {};
  
  if (response === 'yes' || response === 'y' || response === 'correct') {
    const voiceData = sessionData.pendingVoiceValidation;
    await processFollowUpResponse(phoneNumber, session, survey, voiceData.summary, voiceData);
  } else if (response === 'no' || response === 'n' || response === 'incorrect') {
    await updateSession(session.id, {
      stage: 'followup',
      sessionData: {
        ...sessionData,
        pendingVoiceValidation: null
      }
    });
    
    const retryMessage = "No problem! Let's try again.\n\nYou can:\n🎤 Send another voice message\n💬 Type your response\n⏭️ Type 'skip' to continue";
    await client.sendMessage(phoneNumber, retryMessage);
  } else if (response === 'skip') {
    await processFollowUpResponse(phoneNumber, session, survey, '');
  } else {
    const helpMessage = "Please respond with:\n✅ 'yes' to confirm\n❌ 'no' to try again\n⏭️ 'skip' to continue";
    await client.sendMessage(phoneNumber, helpMessage);
  }
}

async function processFollowUpResponse(phoneNumber, session, survey, followUpText, voiceData = null) {
  const sessionData = session.sessionData || session.session_data || {};
  const pendingAnswer = sessionData.pendingAnswer;
  
  if (pendingAnswer) {
    // Store response in database
    const voiceMetadata = voiceData ? {
      originalLanguage: voiceData.language,
      originalText: voiceData.originalText,
      translatedText: voiceData.translatedText,
      duration: voiceData.duration,
      wasTranscribed: true
    } : null;
    
    await pool.query(
      `INSERT INTO responses (survey_id, participant_id, question_id, answer, follow_up_comment, voice_metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        survey.id,
        session.participant_id,
        pendingAnswer.questionId,
        pendingAnswer.answer.toString(),
        followUpText && followUpText !== 'skip' ? followUpText : null,
        voiceMetadata ? JSON.stringify(voiceMetadata) : null
      ]
    );
  }
  
  // Move to next question
  const nextQuestion = session.current_question + 1;
  
  console.log(`Moving from question ${session.current_question} to ${nextQuestion} (total: ${survey.questions.length})`);
  
  if (nextQuestion >= survey.questions.length) {
    // Survey complete
    const participantCode = sessionData.participantCode;
    
    // Mark survey as completed
    await pool.query(
      `UPDATE survey_participants 
       SET completed_at = CURRENT_TIMESTAMP, 
           is_completed = true,
           completion_duration_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at))
       WHERE survey_id = $1 AND participant_id = $2`,
      [survey.id, session.participant_id]
    );
    
    const completionMessage = `Thank you for completing the survey! 🎉\n\nYour responses have been recorded. Your feedback is valuable to us!\n\nHave a great day!`;
    
    await client.sendMessage(phoneNumber, completionMessage);
    
    // Delete session
    await pool.query('DELETE FROM sessions WHERE id = $1', [session.id]);
    
    broadcastSurveyStats();
    broadcastNewResponse();
  } else {
    // Continue to next question
    await updateSession(session.id, {
      current_question: nextQuestion,
      stage: 'survey',
      sessionData: {
        ...sessionData,
        pendingAnswer: null,
        pendingVoiceValidation: null
      }
    });
    
    const progress = Math.round((nextQuestion / survey.questions.length) * 100);
    const progressMessage = `Thank you for sharing!\n\nProgress: ${progress}% complete\n\n---\n\nLet's continue...`;
    
    await client.sendMessage(phoneNumber, progressMessage);
    
    // Create a session object with updated values for sendCurrentQuestion
    const updatedSession = {
      ...session,
      current_question: nextQuestion
    };
    
    await sendCurrentQuestion(phoneNumber, updatedSession, survey);
  }
}

// Real-time broadcasting functions
async function broadcastSurveyStats() {
  try {
    const stats = await pool.query('SELECT * FROM survey_statistics');
    io.emit('survey-stats', stats.rows);
  } catch (error) {
    console.error('Error broadcasting survey stats:', error);
  }
}

async function broadcastNewResponse() {
  try {
    const recentResponses = await pool.query(
      `SELECT r.*, p.participant_code, sp.participant_survey_code, q.question_text
       FROM responses r
       JOIN participants p ON r.participant_id = p.id
       JOIN survey_participants sp ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
       JOIN questions q ON r.question_id = q.id
       ORDER BY r.created_at DESC
       LIMIT 10`
    );
    
    io.emit('new-responses', recentResponses.rows);
  } catch (error) {
    console.error('Error broadcasting new responses:', error);
  }
}

// API Routes

// Get all surveys
app.get('/api/surveys', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, 
              COALESCE(stats.total_participants, 0) as participants,
              COALESCE(stats.completed_participants, 0) as completions,
              COALESCE(stats.total_responses, 0) as responses
       FROM surveys s
       LEFT JOIN survey_statistics stats ON s.id = stats.id
       ORDER BY s.created_at DESC`
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching surveys:', error);
    res.status(500).json({ error: 'Failed to fetch surveys' });
  }
});

// Create new survey
app.post('/api/surveys', async (req, res) => {
  try {
    const survey = await createSurvey(req.body);
    res.json(survey);
    broadcastSurveyStats();
  } catch (error) {
    console.error('Error creating survey:', error);
    res.status(500).json({ error: 'Failed to create survey' });
  }
});

// Activate survey
app.post('/api/surveys/:id/activate', async (req, res) => {
  try {
    const survey = await activateSurvey(req.params.id);
    if (survey) {
      res.json(survey);
      broadcastSurveyStats();
    } else {
      res.status(404).json({ error: 'Survey not found' });
    }
  } catch (error) {
    console.error('Error activating survey:', error);
    res.status(500).json({ error: 'Failed to activate survey' });
  }
});

// Get survey responses
app.get('/api/surveys/:id/responses', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, p.phone_number, p.participant_code, 
              sp.participant_survey_code, q.question_text
       FROM responses r
       JOIN participants p ON r.participant_id = p.id
       JOIN survey_participants sp ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
       JOIN questions q ON r.question_id = q.id
       WHERE r.survey_id = $1
       ORDER BY r.created_at`,
      [req.params.id]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching responses:', error);
    res.status(500).json({ error: 'Failed to fetch responses' });
  }
});

// Get survey analytics
app.get('/api/surveys/:id/analytics', async (req, res) => {
  try {
    // Get survey details with stats
    const surveyResult = await pool.query(
      'SELECT * FROM survey_statistics WHERE id = $1',
      [req.params.id]
    );
    
    if (surveyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    const survey = surveyResult.rows[0];
    
    // Get questions
    const questionsResult = await pool.query(
      'SELECT * FROM questions WHERE survey_id = $1 ORDER BY question_number',
      [req.params.id]
    );
    
    // Build analytics response
    const analytics = {
      totalResponses: parseInt(survey.total_responses) || 0,
      uniqueParticipants: parseInt(survey.total_participants) || 0,
      completedSurveys: parseInt(survey.completed_participants) || 0,
      completionRate: parseFloat(survey.completion_rate) || 0,
      averageCompletionTime: parseInt(survey.avg_completion_seconds) || 0,
      responsesByQuestion: {}
    };
    
    // Analyze responses by question
    for (const question of questionsResult.rows) {
      const responsesResult = await pool.query(
        `SELECT r.answer, r.follow_up_comment, sp.participant_survey_code
         FROM responses r
         JOIN survey_participants sp ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
         WHERE r.survey_id = $1 AND r.question_id = $2`,
        [req.params.id, question.id]
      );
      
      if (question.question_type === 'curated' || question.question_type === 'multiple') {
        const responses = {};
        responsesResult.rows.forEach(r => {
          responses[r.answer] = (responses[r.answer] || 0) + 1;
        });
        
        analytics.responsesByQuestion[question.id] = {
          question: question.question_text,
          type: question.question_type,
          responses: responses,
          followUps: responsesResult.rows
            .filter(r => r.follow_up_comment)
            .map(r => ({
              text: r.follow_up_comment,
              participantId: r.participant_survey_code
            }))
        };
      } else if (question.question_type === 'likert') {
        const ratings = responsesResult.rows.map(r => parseInt(r.answer));
        const distribution = {};
        ratings.forEach(r => {
          distribution[r] = (distribution[r] || 0) + 1;
        });
        
        analytics.responsesByQuestion[question.id] = {
          question: question.question_text,
          type: question.question_type,
          average: ratings.reduce((a, b) => a + b, 0) / ratings.length || 0,
          distribution: distribution,
          followUps: responsesResult.rows
            .filter(r => r.follow_up_comment)
            .map(r => ({
              text: r.follow_up_comment,
              participantId: r.participant_survey_code
            }))
        };
      }
    }
    
    res.json(analytics);
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// WhatsApp status
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    isReady: isClientReady,
    qrCode: qrCodeData
  });
});

// OpenAI configuration status
app.get('/api/openai/status', (req, res) => {
  res.json({
    isConfigured: isOpenAIConfigured,
    voiceTranscriptionEnabled: isOpenAIConfigured,
    features: {
      voiceTranscription: isOpenAIConfigured,
      languageDetection: isOpenAIConfigured,
      translation: isOpenAIConfigured,
      responseValidation: isOpenAIConfigured
    },
    limits: {
      maxVoiceDurationSeconds: MAX_VOICE_DURATION,
      processingTimeoutMs: VOICE_PROCESSING_TIMEOUT
    }
  });
});

// Test OpenAI connection
app.post('/api/openai/test', async (req, res) => {
  if (!isOpenAIConfigured) {
    return res.status(400).json({ 
      success: false, 
      error: 'OpenAI API key not configured',
      message: 'Please set the OPENAI_API_KEY environment variable'
    });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      timeout: 10000
    });

    if (response.ok) {
      res.json({ 
        success: true, 
        message: 'OpenAI API connection successful',
        features: ['Voice transcription', 'Language detection', 'Translation', 'Response validation']
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: 'OpenAI API key invalid',
        message: 'Please check your API key and try again'
      });
    }
  } catch (error) {
    console.error('OpenAI test error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Connection test failed',
      message: 'Unable to connect to OpenAI API'
    });
  }
});

// Export survey data with enhanced format
app.get('/api/surveys/:id/export', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        sp.participant_survey_code as "ParticipantID",
        s.title as "Survey",
        q.question_text as "Question",
        r.answer as "Answer",
        COALESCE(r.follow_up_comment, '') as "FollowUpComment",
        p.phone_number as "PhoneNumber",
        r.created_at AT TIME ZONE 'Asia/Singapore' as "ResponseTimestamp",
        sp.completed_at AT TIME ZONE 'Asia/Singapore' as "CompletionTimestamp",
        CASE 
          WHEN sp.completion_duration_seconds IS NOT NULL 
          THEN sp.completion_duration_seconds || ' seconds'
          ELSE 'N/A'
        END as "CompletionDuration",
        CASE WHEN r.voice_metadata IS NOT NULL THEN 'Yes' ELSE 'No' END as "VoiceTranscribed",
        COALESCE(r.voice_metadata->>'originalLanguage', '') as "VoiceLanguage"
       FROM responses r
       JOIN participants p ON r.participant_id = p.id
       JOIN survey_participants sp ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
       JOIN questions q ON r.question_id = q.id
       JOIN surveys s ON r.survey_id = s.id
       WHERE r.survey_id = $1
       ORDER BY sp.participant_survey_code, q.question_number`,
      [req.params.id]
    );
    
    // Format timestamps for Singapore timezone
    const csvData = result.rows.map(row => ({
      ...row,
      PhoneNumber: row.PhoneNumber.replace('@c.us', ''),
      ResponseTimestamp: new Date(row.ResponseTimestamp).toLocaleString('en-SG', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Singapore'
      }),
      CompletionTimestamp: row.CompletionTimestamp 
        ? new Date(row.CompletionTimestamp).toLocaleString('en-SG', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: 'Asia/Singapore'
          })
        : 'Not Completed'
    }));
    
    res.json(csvData);
  } catch (error) {
    console.error('Error exporting survey data:', error);
    res.status(500).json({ error: 'Failed to export survey data' });
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Admin client connected');
  connectedClients.add(socket);
  
  socket.emit('whatsapp-ready', isClientReady);
  if (qrCodeData) {
    socket.emit('qr-code', { qrCode: qrCodeData });
  }
  
  broadcastSurveyStats();
  
  socket.on('disconnect', () => {
    console.log('Admin client disconnected');
    connectedClients.delete(socket);
  });
});

// Serve admin dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WhatsApp Survey Platform running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  client.destroy();
  pool.end();
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

module.exports = app;
