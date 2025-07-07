require('dotenv').config();

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
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Enhanced logging
const logger = {
  info: (message, data = {}) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data),
  warn: (message, data = {}) => console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data),
  error: (message, error = {}) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error),
  debug: (message, data = {}) => process.env.NODE_ENV !== 'production' && console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data)
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : "*",
    methods: ["GET", "POST"]
  }
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Enhanced PostgreSQL connection with retry logic
const createPool = () => {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
};

let pool = createPool();

// Database connection test with retry
async function testDatabaseConnection(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      client.release();
      logger.info('Database connected successfully', { timestamp: result.rows[0].now });
      return true;
    } catch (error) {
      logger.error(`Database connection attempt ${i + 1} failed`, error);
      if (i === retries - 1) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  return false;
}

// Environment validation
const requiredEnvVars = ['DATABASE_URL'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  logger.error('Missing required environment variables', { missing: missingEnvVars });
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  logger.warn('OPENAI_API_KEY not configured - voice transcription will be disabled');
}

// OpenAI configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

const MAX_VOICE_DURATION = parseInt(process.env.MAX_VOICE_DURATION_SECONDS) || 60;
const VOICE_PROCESSING_TIMEOUT = parseInt(process.env.VOICE_PROCESSING_TIMEOUT_MS) || 30000;

function validateOpenAIKey(apiKey) {
  return apiKey && apiKey.startsWith('sk-') && apiKey.length > 20;
}

const isOpenAIConfigured = validateOpenAIKey(OPENAI_API_KEY);
logger.info('OpenAI configuration', { enabled: isOpenAIConfigured });

// In-memory session locks to prevent race conditions
const sessionLocks = new Map();

// Database helper functions with proper error handling
async function withDatabaseTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getOrCreateParticipant(phoneNumber) {
  return withDatabaseTransaction(async (client) => {
    const normalizedPhone = phoneNumber.trim();
    
    let result = await client.query(
      'SELECT id, participant_code FROM participants WHERE phone_number = $1',
      [normalizedPhone]
    );
    
    if (result.rows.length > 0) {
      logger.debug('Found existing participant', { id: result.rows[0].id });
      return result.rows[0];
    }
    
    const participantCode = `P${Date.now().toString(36).toUpperCase()}`;
    result = await client.query(
      'INSERT INTO participants (phone_number, participant_code) VALUES ($1, $2) RETURNING id, participant_code',
      [normalizedPhone, participantCode]
    );
    
    logger.info('Created new participant', { id: result.rows[0].id, code: participantCode });
    return result.rows[0];
  });
}

async function getOrCreateSurveyParticipant(surveyId, participantId) {
  return withDatabaseTransaction(async (client) => {
    let result = await client.query(
      'SELECT participant_survey_code FROM survey_participants WHERE survey_id = $1 AND participant_id = $2',
      [surveyId, participantId]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0].participant_survey_code;
    }
    
    result = await client.query(
      'SELECT get_next_participant_code($1) as code',
      [surveyId]
    );
    
    const participantSurveyCode = result.rows[0].code;
    
    await client.query(
      'INSERT INTO survey_participants (survey_id, participant_id, participant_survey_code) VALUES ($1, $2, $3)',
      [surveyId, participantId, participantSurveyCode]
    );
    
    return participantSurveyCode;
  });
}

// Enhanced session management with proper validation
async function getOrCreateSession(phoneNumber, activeSurvey) {
  const normalizedPhone = phoneNumber.trim();
  const lockKey = `${normalizedPhone}-${activeSurvey.id}`;
  
  // Prevent race conditions
  if (sessionLocks.has(lockKey)) {
    logger.debug('Session operation already in progress', { phone: normalizedPhone });
    await new Promise(resolve => setTimeout(resolve, 100));
    return getOrCreateSession(phoneNumber, activeSurvey);
  }
  
  sessionLocks.set(lockKey, true);
  
  try {
    return await withDatabaseTransaction(async (client) => {
      logger.debug('Looking for session', { phone: normalizedPhone, survey: activeSurvey.id });
      
      const participant = await getOrCreateParticipant(normalizedPhone);
      
      let result = await client.query(
        'SELECT * FROM sessions WHERE phone_number = $1 AND survey_id = $2',
        [normalizedPhone, activeSurvey.id]
      );
      
      if (result.rows.length > 0) {
        const session = result.rows[0];
        logger.debug('Found existing session', { id: session.id, stage: session.stage });
        return {
          ...session,
          sessionData: session.session_data || {}
        };
      }
      
      logger.debug('Creating new session');
      result = await client.query(
        `INSERT INTO sessions (phone_number, survey_id, participant_id, session_data, current_question, stage)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [normalizedPhone, activeSurvey.id, participant.id, '{}', 0, 'initial']
      );
      
      const newSession = result.rows[0];
      logger.info('Created new session', { id: newSession.id });
      return {
        ...newSession,
        sessionData: {}
      };
    });
  } finally {
    sessionLocks.delete(lockKey);
  }
}

async function updateSession(sessionId, updates) {
  if (!sessionId) {
    throw new Error('Session ID is required for update');
  }
  
  if (!updates || Object.keys(updates).length === 0) {
    logger.warn('No updates provided for session', { sessionId });
    return;
  }
  
  return withDatabaseTransaction(async (client) => {
    const setClause = [];
    const values = [];
    let paramCount = 1;
    
    // Validate and normalize updates
    if (updates.currentQuestion !== undefined || updates.current_question !== undefined) {
      const questionNum = updates.currentQuestion ?? updates.current_question;
      if (!Number.isInteger(questionNum) || questionNum < 0) {
        throw new Error(`Invalid question number: ${questionNum}`);
      }
      setClause.push(`current_question = $${paramCount}`);
      values.push(questionNum);
      paramCount++;
    }
    
    if (updates.stage !== undefined) {
      const validStages = ['initial', 'survey', 'followup', 'voice_confirmation', 'completed'];
      if (!validStages.includes(updates.stage)) {
        throw new Error(`Invalid stage: ${updates.stage}`);
      }
      setClause.push(`stage = $${paramCount}`);
      values.push(updates.stage);
      paramCount++;
    }
    
    if (updates.sessionData !== undefined) {
      try {
        const serialized = JSON.stringify(updates.sessionData);
        setClause.push(`session_data = $${paramCount}`);
        values.push(serialized);
        paramCount++;
      } catch (jsonError) {
        throw new Error(`Session data is not serializable: ${jsonError.message}`);
      }
    }
    
    if (setClause.length === 0) {
      logger.warn('No valid updates provided for session', { sessionId });
      return;
    }
    
    values.push(sessionId);
    
    const query = `UPDATE sessions SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount}`;
    
    logger.debug('Executing session update', { query, values });
    
    const result = await client.query(query, values);
    
    if (result.rowCount === 0) {
      throw new Error(`Session ${sessionId} not found or update failed`);
    }
    
    logger.debug('Successfully updated session', { sessionId });
  });
}

// Voice processing functions with enhanced error handling
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VOICE_PROCESSING_TIMEOUT);

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

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
    if (error.name === 'AbortError') {
      throw new Error('Voice transcription timed out');
    }
    logger.error('Voice transcription error', error);
    throw error;
  }
}

async function translateToEnglish(text, detectedLanguage) {
  if (!isOpenAIConfigured || detectedLanguage === 'en') {
    return text;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VOICE_PROCESSING_TIMEOUT);

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
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.error('Translation API error', { status: response.status });
      return text;
    }

    const result = await response.json();
    return result.choices[0].message.content.trim();
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.warn('Translation timed out, returning original text');
    } else {
      logger.error('Translation error', error);
    }
    return text;
  }
}

async function generateContextualSummary(transcribedText, originalText, language, questionText) {
  if (!isOpenAIConfigured) {
    return transcribedText;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VOICE_PROCESSING_TIMEOUT);

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
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.error('Summary API error', { status: response.status });
      return transcribedText;
    }

    const result = await response.json();
    return result.choices[0].message.content.trim();
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.warn('Summary generation timed out, returning original text');
    } else {
      logger.error('Summary generation error', error);
    }
    return transcribedText;
  }
}

// WhatsApp client setup with enhanced error handling
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth'
  }),
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
let connectedClients = new Set();

client.on('qr', (qr) => {
  logger.info('QR Code received');
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      logger.error('Error generating QR code', err);
      return;
    }
    qrCodeData = url;
    io.emit('qr-code', { qrCode: url });
  });
});

client.on('ready', () => {
  logger.info('WhatsApp client is ready');
  isClientReady = true;
  qrCodeData = null;
  io.emit('whatsapp-ready');
});

client.on('disconnected', (reason) => {
  logger.warn('WhatsApp client disconnected', { reason });
  isClientReady = false;
  io.emit('whatsapp-disconnected');
});

client.on('auth_failure', (message) => {
  logger.error('WhatsApp authentication failed', { message });
  io.emit('whatsapp-auth-failed', { message });
});

// Enhanced message handling
client.on('message', async (message) => {
  if (message.from.endsWith('@c.us')) {
    try {
      await handleWhatsAppMessage(message);
    } catch (error) {
      logger.error('Error handling WhatsApp message', error);
      // Send generic error message to user
      try {
        await client.sendMessage(message.from, 
          "Sorry, I encountered an error processing your message. Please try again in a few moments."
        );
      } catch (sendError) {
        logger.error('Failed to send error message to user', sendError);
      }
    }
  }
});

// Start WhatsApp client with retry logic
async function initializeWhatsApp() {
  try {
    await client.initialize();
    logger.info('WhatsApp client initialization started');
  } catch (error) {
    logger.error('Failed to initialize WhatsApp client', error);
    setTimeout(initializeWhatsApp, 5000); // Retry after 5 seconds
  }
}

// Survey management functions with enhanced validation
async function createSurvey(surveyData) {
  // Validate input
  if (!surveyData.title || !surveyData.questions || !Array.isArray(surveyData.questions)) {
    throw new Error('Invalid survey data: title and questions are required');
  }
  
  if (surveyData.questions.length === 0) {
    throw new Error('Survey must have at least one question');
  }

  return withDatabaseTransaction(async (client) => {
    const surveyId = Date.now().toString();
    const surveyPrefix = surveyData.title
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .substring(0, 10) || 'SURVEY';
    
    // Check for recent duplicates
    const duplicateCheck = await client.query(
      `SELECT id FROM surveys 
       WHERE title = $1 
       AND created_at > NOW() - INTERVAL '5 seconds'
       LIMIT 1`,
      [surveyData.title]
    );
    
    if (duplicateCheck.rows.length > 0) {
      throw new Error('Survey with this title was just created. Please wait before creating another.');
    }
    
    // Insert survey
    await client.query(
      `INSERT INTO surveys (id, title, description, estimated_time, participant_prefix) 
       VALUES ($1, $2, $3, $4, $5)`,
      [surveyId, surveyData.title, surveyData.description || '', surveyData.estimatedTime, surveyPrefix]
    );
    
    // Insert questions with validation
    for (let i = 0; i < surveyData.questions.length; i++) {
      const question = surveyData.questions[i];
      
      if (!question.question || !question.type) {
        throw new Error(`Question ${i + 1} is missing required fields`);
      }
      
      await client.query(
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
    
    const result = await client.query(
      'SELECT * FROM surveys WHERE id = $1',
      [surveyId]
    );
    
    logger.info('Created new survey', { id: surveyId, title: surveyData.title });
    
    return {
      ...result.rows[0],
      questions: surveyData.questions
    };
  });
}

async function activateSurvey(surveyId) {
  return withDatabaseTransaction(async (client) => {
    await client.query('UPDATE surveys SET is_active = false');
    
    const result = await client.query(
      'UPDATE surveys SET is_active = true WHERE id = $1 RETURNING *',
      [surveyId]
    );
    
    if (result.rows.length > 0) {
      logger.info('Activated survey', { id: surveyId });
      return result.rows[0];
    }
    return null;
  });
}

async function getActiveSurvey() {
  try {
    const result = await pool.query(
      'SELECT * FROM surveys WHERE is_active = true LIMIT 1'
    );
    
    if (result.rows.length > 0) {
      const survey = result.rows[0];
      
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
      
      logger.debug('Active survey loaded', { id: survey.id, questionCount: survey.questions.length });
      return survey;
    }
    
    return null;
  } catch (error) {
    logger.error('Error getting active survey', error);
    return null;
  }
}

// Enhanced message handling with proper error recovery
async function handleWhatsAppMessage(message) {
  const phoneNumber = message.from;
  const isVoiceMessage = message.type === 'ptt' || message.type === 'audio';
  const messageText = isVoiceMessage ? '[Voice Message]' : message.body.toLowerCase().trim();
  
  logger.info('Received message', { 
    from: phoneNumber, 
    type: isVoiceMessage ? 'voice' : 'text',
    content: messageText.substring(0, 50) 
  });
  
  const activeSurvey = await getActiveSurvey();
  
  if (!activeSurvey) {
    await client.sendMessage(phoneNumber, 
      "Hello! There's no active survey at the moment. Please check back later!"
    );
    return;
  }
  
  try {
    const session = await getOrCreateSession(phoneNumber, activeSurvey);
    
    logger.debug('Session state', {
      id: session.id,
      stage: session.stage,
      currentQuestion: session.current_question
    });
    
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
      default:
        logger.error('Unknown session stage', { stage: session.stage, sessionId: session.id });
        await updateSession(session.id, { stage: 'survey' });
        await handleSurveyResponse(phoneNumber, session, activeSurvey, messageText, isVoiceMessage, message);
    }
  } catch (error) {
    logger.error('Error in message handling', error);
    
    // Try to clean up and send user-friendly message
    await client.sendMessage(phoneNumber, 
      "Sorry, I encountered an error. Let me restart your survey. Please send any message to begin again."
    );
    
    // Clean up session
    try {
      await pool.query('DELETE FROM sessions WHERE phone_number = $1 AND survey_id = $2', 
        [phoneNumber, activeSurvey.id]);
    } catch (cleanupError) {
      logger.error('Failed to cleanup session after error', cleanupError);
    }
  }
}

async function handleInitialMessage(phoneNumber, session, survey) {
  if (session.stage !== 'initial') {
    logger.warn('handleInitialMessage called for non-initial session', { 
      sessionId: session.id, 
      stage: session.stage 
    });
    return;
  }
  
  const participantCode = await getOrCreateSurveyParticipant(survey.id, session.participant_id);
  
  await updateSession(session.id, {
    stage: 'survey',
    sessionData: { participantCode: participantCode }
  });
  
  let welcomeMessage = `Welcome to our survey! 📊\n\n*${survey.title}*\n\n`;
  
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
  if (!question) {
    logger.error('No question found for index', { 
      questionIndex: session.current_question, 
      totalQuestions: survey.questions.length 
    });
    return;
  }

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
  logger.debug('Sent question', { questionIndex: session.current_question });
}

async function handleSurveyResponse(phoneNumber, session, survey, messageText, isVoiceMessage, message) {
  const question = survey.questions[session.current_question];
  
  if (!question) {
    logger.error('No question found for response', { questionIndex: session.current_question });
    await client.sendMessage(phoneNumber, 'Sorry, there was an error. Please try again.');
    return;
  }
  
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
      if (messageText.trim().length > 0) {
        selectedAnswer = messageText;
        isValidAnswer = true;
      }
      break;
  }

  if (!isValidAnswer) {
    await client.sendMessage(phoneNumber, 
      "Sorry, I didn't understand that. Please try again with a valid option."
    );
    return;
  }

  logger.debug('Valid answer received', { answer: selectedAnswer, questionIndex: session.current_question });

  // Store the answer temporarily in session
  const currentSessionData = session.sessionData || {};
  const sessionData = {
    ...currentSessionData,
    pendingAnswer: {
      questionId: question.id,
      answer: selectedAnswer,
      questionType: question.type,
      questionText: question.question
    }
  };
  
  await updateSession(session.id, {
    stage: 'followup',
    sessionData: sessionData
  });

  // Generate contextual follow-up message
  let followUpMessage = generateFollowUpMessage(question, selectedAnswer);
  followUpMessage += `\n\nYou can:\n🎤 Send a voice message (I'll transcribe it)\n💬 Type your response\n⏭️ Type 'skip' to continue\n\nI'd love to hear your thoughts!`;
  
  await client.sendMessage(phoneNumber, followUpMessage);
}

function generateFollowUpMessage(question, selectedAnswer) {
  if (question.type === 'curated' && question.options) {
    if (selectedAnswer.toLowerCase() === 'agree') {
      return `Great to hear you agree! I'd love to understand what makes you feel positive about this.`;
    } else if (selectedAnswer.toLowerCase() === 'disagree') {
      return `I understand you disagree with this statement. Could you share what concerns you have?`;
    } else if (selectedAnswer.toLowerCase() === 'undecided') {
      return `I see you're undecided. What factors are making it difficult to decide?`;
    }
  }
  
  if (question.type === 'likert') {
    const rating = parseInt(selectedAnswer);
    const scale = question.scale;
    if (rating <= scale.min + 1) {
      return `I see you gave a low rating of ${rating}. What aspects need improvement?`;
    } else if (rating >= scale.max - 1) {
      return `Wonderful! You gave a high rating of ${rating}. What did you particularly like?`;
    } else {
      return `You rated this ${rating} out of ${scale.max}. What influenced your rating?`;
    }
  }
  
  return `You selected "${selectedAnswer}". I'd love to hear more about your choice.`;
}

// Continue with the rest of the functions...
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
      logger.error('Voice processing error', error);
      
      let errorMessage = "Sorry, I couldn't process your voice message.";
      
      if (error.message.includes('API key')) {
        errorMessage = "Voice transcription service is temporarily unavailable.";
      } else if (error.message.includes('timeout') || error.message.includes('timed out')) {
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
  const sessionData = session.sessionData || {};
  const pendingAnswer = sessionData.pendingAnswer;
  
  if (!pendingAnswer) {
    logger.error('No pending answer found in session', { sessionId: session.id });
    await client.sendMessage(phoneNumber, "Sorry, there was an error. Please try again.");
    return;
  }

  try {
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

    logger.info('Stored response', { 
      sessionId: session.id, 
      questionId: pendingAnswer.questionId,
      hasFollowUp: !!(followUpText && followUpText !== 'skip'),
      hasVoice: !!voiceMetadata
    });
  } catch (error) {
    logger.error('Failed to store response', error);
    await client.sendMessage(phoneNumber, "Sorry, there was an error saving your response. Please try again.");
    return;
  }
  
  // Move to next question
  const nextQuestion = session.current_question + 1;
  
  if (nextQuestion >= survey.questions.length) {
    // Survey complete
    try {
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
      
      logger.info('Survey completed', { sessionId: session.id, participantId: session.participant_id });
      
      broadcastSurveyStats();
      broadcastNewResponse();
    } catch (error) {
      logger.error('Failed to complete survey', error);
    }
  } else {
    // Continue to next question
    try {
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
      
      // Send next question
      const updatedSession = {
        ...session,
        current_question: nextQuestion
      };
      
      await sendCurrentQuestion(phoneNumber, updatedSession, survey);
    } catch (error) {
      logger.error('Failed to move to next question', error);
      await client.sendMessage(phoneNumber, "Sorry, there was an error. Please try again.");
    }
  }
}

// Real-time broadcasting functions
async function broadcastSurveyStats() {
  try {
    const result = await pool.query(`
      SELECT s.*, 
             COALESCE(stats.total_participants, 0) as participants,
             COALESCE(stats.completed_participants, 0) as completions,
             COALESCE(stats.total_responses, 0) as responses
      FROM surveys s
      LEFT JOIN (
        SELECT survey_id,
               COUNT(DISTINCT participant_id) as total_participants,
               COUNT(DISTINCT CASE WHEN is_completed THEN participant_id END) as completed_participants,
               COUNT(r.id) as total_responses
        FROM survey_participants sp
        LEFT JOIN responses r ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
        GROUP BY survey_id
      ) stats ON s.id = stats.survey_id
      ORDER BY s.created_at DESC
    `);
    
    io.emit('survey-stats', result.rows);
  } catch (error) {
    logger.error('Error broadcasting survey stats', error);
  }
}

async function broadcastNewResponse() {
  try {
    const result = await pool.query(`
      SELECT r.*, p.participant_code, sp.participant_survey_code, q.question_text
      FROM responses r
      JOIN participants p ON r.participant_id = p.id
      JOIN survey_participants sp ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
      JOIN questions q ON r.question_id = q.id
      ORDER BY r.created_at DESC
      LIMIT 10
    `);
    
    io.emit('new-responses', result.rows);
  } catch (error) {
    logger.error('Error broadcasting new responses', error);
  }
}

// API Routes with enhanced error handling
app.get('/api/surveys', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, 
             COALESCE(stats.total_participants, 0) as participants,
             COALESCE(stats.completed_participants, 0) as completions,
             COALESCE(stats.total_responses, 0) as responses
      FROM surveys s
      LEFT JOIN (
        SELECT survey_id,
               COUNT(DISTINCT participant_id) as total_participants,
               COUNT(DISTINCT CASE WHEN is_completed THEN participant_id END) as completed_participants,
               COUNT(r.id) as total_responses
        FROM survey_participants sp
        LEFT JOIN responses r ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
        GROUP BY survey_id
      ) stats ON s.id = stats.survey_id
      ORDER BY s.created_at DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    logger.error('Error fetching surveys', error);
    res.status(500).json({ error: 'Failed to fetch surveys' });
  }
});

// Survey creation with rate limiting
const createSurveyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // limit each IP to 5 survey creations per minute
  message: { error: 'Too many surveys created. Please wait before creating another.' }
});

app.post('/api/surveys', createSurveyLimiter, async (req, res) => {
  try {
    const survey = await createSurvey(req.body);
    res.json(survey);
    broadcastSurveyStats();
  } catch (error) {
    logger.error('Error creating survey', error);
    res.status(400).json({ error: error.message });
  }
});

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
    logger.error('Error activating survey', error);
    res.status(500).json({ error: 'Failed to activate survey' });
  }
});

app.get('/api/surveys/:id/responses', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, p.phone_number, p.participant_code, 
             sp.participant_survey_code, q.question_text
      FROM responses r
      JOIN participants p ON r.participant_id = p.id
      JOIN survey_participants sp ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
      JOIN questions q ON r.question_id = q.id
      WHERE r.survey_id = $1
      ORDER BY r.created_at
    `, [req.params.id]);
    
    res.json(result.rows);
  } catch (error) {
    logger.error('Error fetching responses', error);
    res.status(500).json({ error: 'Failed to fetch responses' });
  }
});

app.get('/api/surveys/:id/analytics', async (req, res) => {
  try {
    // Get survey stats
    const statsResult = await pool.query(`
      SELECT survey_id,
             COUNT(DISTINCT participant_id) as total_participants,
             COUNT(DISTINCT CASE WHEN is_completed THEN participant_id END) as completed_participants,
             COUNT(r.id) as total_responses,
             ROUND(AVG(CASE WHEN completion_duration_seconds IS NOT NULL THEN completion_duration_seconds END)) as avg_completion_seconds
      FROM survey_participants sp
      LEFT JOIN responses r ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
      WHERE sp.survey_id = $1
      GROUP BY survey_id
    `, [req.params.id]);
    
    if (statsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    const stats = statsResult.rows[0];
    
    // Get questions
    const questionsResult = await pool.query(
      'SELECT * FROM questions WHERE survey_id = $1 ORDER BY question_number',
      [req.params.id]
    );
    
    const analytics = {
      totalResponses: parseInt(stats.total_responses) || 0,
      uniqueParticipants: parseInt(stats.total_participants) || 0,
      completedSurveys: parseInt(stats.completed_participants) || 0,
      completionRate: stats.total_participants > 0 ? 
        Math.round((stats.completed_participants / stats.total_participants) * 100) : 0,
      averageCompletionTime: parseInt(stats.avg_completion_seconds) || 0,
      responsesByQuestion: {}
    };
    
    // Analyze responses by question
    for (const question of questionsResult.rows) {
      const responsesResult = await pool.query(`
        SELECT r.answer, r.follow_up_comment, sp.participant_survey_code
        FROM responses r
        JOIN survey_participants sp ON sp.survey_id = r.survey_id AND sp.participant_id = r.participant_id
        WHERE r.survey_id = $1 AND r.question_id = $2
      `, [req.params.id, question.id]);
      
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
            .map(r => r.follow_up_comment)
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
          average: ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
          distribution: distribution,
          followUps: responsesResult.rows
            .filter(r => r.follow_up_comment)
            .map(r => r.follow_up_comment)
        };
      }
    }
    
    res.json(analytics);
  } catch (error) {
    logger.error('Error fetching analytics', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    isReady: isClientReady,
    qrCode: qrCodeData
  });
});

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

app.post('/api/openai/test', async (req, res) => {
  if (!isOpenAIConfigured) {
    return res.status(400).json({ 
      success: false, 
      error: 'OpenAI API key not configured',
      message: 'Please set the OPENAI_API_KEY environment variable'
    });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

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
    if (error.name === 'AbortError') {
      res.status(408).json({ 
        success: false, 
        error: 'Connection timeout',
        message: 'OpenAI API connection timed out'
      });
    } else {
      logger.error('OpenAI test error', error);
      res.status(500).json({ 
        success: false, 
        error: 'Connection test failed',
        message: 'Unable to connect to OpenAI API'
      });
    }
  }
});

app.get('/api/surveys/:id/export', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        sp.participant_survey_code as "ParticipantID",
        s.title as "Survey",
        q.question_text as "Question",
        r.answer as "Answer",
        COALESCE(r.follow_up_comment, '') as "FollowUpComment",
        p.phone_number as "PhoneNumber",
        r.created_at AT TIME ZONE 'UTC' as "ResponseTimestamp",
        sp.completed_at AT TIME ZONE 'UTC' as "CompletionTimestamp",
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
      ORDER BY sp.participant_survey_code, q.question_number
    `, [req.params.id]);
    
    const csvData = result.rows.map(row => ({
      ...row,
      PhoneNumber: row.PhoneNumber.replace('@c.us', ''),
      ResponseTimestamp: new Date(row.ResponseTimestamp).toISOString(),
      CompletionTimestamp: row.CompletionTimestamp 
        ? new Date(row.CompletionTimestamp).toISOString()
        : 'Not Completed'
    }));
    
    res.json(csvData);
  } catch (error) {
    logger.error('Error exporting survey data', error);
    res.status(500).json({ error: 'Failed to export survey data' });
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  logger.info('Admin client connected');
  connectedClients.add(socket);
  
  socket.emit('whatsapp-ready', isClientReady);
  if (qrCodeData) {
    socket.emit('qr-code', { qrCode: qrCodeData });
  }
  
  broadcastSurveyStats();
  
  socket.on('disconnect', () => {
    logger.info('Admin client disconnected');
    connectedClients.delete(socket);
  });
});

// Serve admin dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const dbResult = await pool.query('SELECT 1');
    
    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      whatsapp: isClientReady,
      openai: isOpenAIConfigured,
      database: dbResult.rows.length > 0
    });
  } catch (error) {
    logger.error('Health check failed', error);
    res.status(503).json({ 
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Database connection failed'
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled API error', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize application
async function initialize() {
  try {
    logger.info('Starting WhatsApp Survey Platform...');
    
    // Test database connection
    await testDatabaseConnection();
    
    // Initialize WhatsApp client
    initializeWhatsApp();
    
    // Start server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.info('Server started', { port: PORT });
    });
    
  } catch (error) {
    logger.error('Failed to initialize application', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  
  try {
    if (client) {
      await client.destroy();
    }
    
    if (pool) {
      await pool.end();
    }
    
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  } catch (error) {
    logger.error('Error during shutdown', error);
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.emit('SIGTERM');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
  process.exit(1);
});

// Start the application
initialize();

module.exports = app;
