// server.js - Complete WhatsApp Survey Platform Server with All Fixes
// Includes working voice transcription and CSV export

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
const { RateLimiterMemory } = require('rate-limiter-flexible');

// Enhanced logging system
const logger = {
  info: (message, data = {}) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data),
  warn: (message, data = {}) => console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, data),
  error: (message, error = {}) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error),
  debug: (message, data = {}) => process.env.NODE_ENV !== 'production' && console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data)
};

// Express app setup
const app = express();
const server = http.createServer(app);

// Important: Set trust proxy for Render.com
app.set('trust proxy', true);

// Socket.IO setup with Render.com compatibility fixes
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://whatsapp-survey-platform.onrender.com', 'https://*.onrender.com', '*']
      : "*",
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  // Important for Render.com
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  // Allow connections from behind proxies
  allowRequest: (req, callback) => {
    callback(null, true); // Allow all connections
  }
});

// Security middleware - allowing inline scripts temporarily
app.use(helmet({
  contentSecurityPolicy: false, // Disabled temporarily for easier development
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc)
    if (!origin) return callback(null, true);
    
    // In production, be more restrictive
    if (process.env.NODE_ENV === 'production') {
      const allowedOrigins = [
        'https://whatsapp-survey-platform.onrender.com',
        /https:\/\/.*\.onrender\.com$/
      ];
      
      const isAllowed = allowedOrigins.some(allowed => {
        if (allowed instanceof RegExp) {
          return allowed.test(origin);
        }
        return allowed === origin;
      });
      
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(null, true); // Still allow for now to prevent issues
      }
    } else {
      // In development, allow all origins
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Handle preflight requests
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');
    return res.sendStatus(200);
  }
  next();
});

// Rate limiting with rate-limiter-flexible
const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
  points: 100, // Number of requests
  duration: 900, // Per 15 minutes (900 seconds)
});

const rateLimitMiddleware = async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip || req.socket.remoteAddress || 'unknown');
    next();
  } catch (rejRes) {
    res.status(429).json({ error: 'Too many requests from this IP, please try again later.' });
  }
};

app.use('/api/', rateLimitMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Global variables
let client;
let isClientReady = false;
let qrCodeData = null;
let connectedClients = new Set();
let activeSurveys = new Map();
let isOpenAIConfigured = false;

// Initialize WhatsApp client with enhanced media handling
function initializeWhatsApp() {
  try {
    client = new Client({
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
          '--disable-gpu',
          // Add these for better media handling
          '--disable-web-security',
          '--disable-features=IsolateOrigins',
          '--disable-site-isolation-trials'
        ]
      },
      // Add this for better media handling
      bypassCSP: true // Bypass content security policy
    });

    client.on('qr', async (qr) => {
      logger.info('QR code generated');
      try {
        qrCodeData = await qrcode.toDataURL(qr);
        io.emit('qr-code', { qrCode: qrCodeData });
      } catch (error) {
        logger.error('Error generating QR code', error);
      }
    });

    client.on('ready', () => {
      logger.info('WhatsApp client is ready');
      isClientReady = true;
      qrCodeData = null;
      io.emit('whatsapp-ready', true);
      loadActiveSurveys();
    });

    client.on('authenticated', () => {
      logger.info('WhatsApp client authenticated');
    });

    client.on('auth_failure', (msg) => {
      logger.error('WhatsApp authentication failed', msg);
      isClientReady = false;
      io.emit('whatsapp-ready', false);
    });

    client.on('disconnected', (reason) => {
      logger.warn('WhatsApp client disconnected', reason);
      isClientReady = false;
      io.emit('whatsapp-ready', false);
    });

    client.on('message', async (message) => {
      if (message.from.endsWith('@c.us')) {
        // Enhanced logging for debugging
        logger.info(`Message received:`, {
          from: message.from,
          type: message.type,
          hasMedia: message.hasMedia,
          body: message.body.substring(0, 50) // First 50 chars
        });
        
        // If it's a voice message, log more details
        if (message.type === 'ptt') {
          logger.info('Voice message details:', {
            duration: message.duration,
            hasMedia: message.hasMedia,
            isForwarded: message.isForwarded
          });
        }
        
        await handleWhatsAppMessage(message);
      }
    });

    client.initialize();
  } catch (error) {
    logger.error('Failed to initialize WhatsApp client', error);
    // Continue without WhatsApp functionality
  }
}

// Handle incoming WhatsApp messages
async function handleWhatsAppMessage(message) {
  try {
    const phoneNumber = message.from.replace('@c.us', '');
    logger.info(`Received message from ${phoneNumber}: ${message.body}`);

    // Get or create participant
    const participant = await getOrCreateParticipant(phoneNumber);
    
    // Check for active session
    let session = await getActiveSession(phoneNumber);
    
    if (!session) {
      // Start new survey session
      const activeSurvey = await getActiveSurvey();
      if (!activeSurvey) {
        await message.reply('Sorry, no surveys are currently active. Please check back later.');
        return;
      }
      
      session = await createSession(phoneNumber, activeSurvey.id, participant.id);
      
      // Send welcome message
      const welcomeMessage = `Hi! 👋 Thanks for participating in our survey: "${activeSurvey.title}"\n\nThis should take about ${activeSurvey.estimated_time}.\n\nLet's get started!`;
      await message.reply(welcomeMessage);
      
      // Send first question
      await sendQuestion(session, message);
    } else {
      // Continue existing session
      await processResponse(session, message);
    }
  } catch (error) {
    logger.error('Error handling WhatsApp message', error);
    await message.reply('Sorry, something went wrong. Please try again later.');
  }
}

// Get or create participant
async function getOrCreateParticipant(phoneNumber) {
  const client = await pool.connect();
  try {
    let result = await client.query(
      'SELECT * FROM participants WHERE phone_number = $1',
      [phoneNumber]
    );
    
    if (result.rows.length === 0) {
      const participantCode = generateParticipantCode();
      result = await client.query(
        'INSERT INTO participants (phone_number, participant_code) VALUES ($1, $2) RETURNING *',
        [phoneNumber, participantCode]
      );
    }
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Generate participant code
function generateParticipantCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Get active session
async function getActiveSession(phoneNumber) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM sessions WHERE phone_number = $1 AND stage != $2',
      [phoneNumber, 'completed']
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

// Create new session
async function createSession(phoneNumber, surveyId, participantId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'INSERT INTO sessions (phone_number, survey_id, participant_id, current_question, stage) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [phoneNumber, surveyId, participantId, 0, 'survey']
    );
    
    // Create survey_participant entry
    const participantSurveyCode = await client.query(
      'SELECT get_next_participant_code($1) as code',
      [surveyId]
    );
    
    await client.query(
      'INSERT INTO survey_participants (survey_id, participant_id, participant_survey_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [surveyId, participantId, participantSurveyCode.rows[0].code || generateParticipantCode()]
    );
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

// Get active survey
async function getActiveSurvey() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM surveys WHERE is_active = true LIMIT 1'
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

// Send question to participant
async function sendQuestion(session, message) {
  const client = await pool.connect();
  try {
    // Get total questions count for this survey
    const totalQuestionsResult = await client.query(
      'SELECT COUNT(*) as total FROM questions WHERE survey_id = $1',
      [session.survey_id]
    );
    const totalQuestions = totalQuestionsResult.rows[0].total;
    
    const result = await client.query(
      'SELECT * FROM questions WHERE survey_id = $1 AND question_number = $2',
      [session.survey_id, session.current_question + 1]
    );
    
    if (result.rows.length === 0) {
      // No more questions, complete survey
      await completeSurvey(session, message);
      return;
    }
    
    const question = result.rows[0];
    // Format: Question X/Y
    let questionText = `Question ${question.question_number}/${totalQuestions}:\n${question.question_text}`;
    
    if (question.question_type === 'multiple' || question.question_type === 'curated') {
      let options;
      try {
        // Try to parse as JSON first
        options = typeof question.options === 'string' 
          ? JSON.parse(question.options) 
          : question.options;
      } catch (e) {
        // If JSON parse fails, check if it's a comma-separated string
        if (typeof question.options === 'string' && question.options.includes(',')) {
          options = question.options.split(',').map(opt => opt.trim());
        } else {
          // Default fallback options
          options = question.question_type === 'curated' 
            ? ['Agree', 'Neutral', 'Disagree'] 
            : ['Option 1', 'Option 2'];
          logger.error('Invalid options format for question', { 
            questionId: question.id, 
            options: question.options 
          });
        }
      }
      
      questionText += '\n' + options.map((opt, idx) => `${idx + 1}. ${opt}`).join('\n');
      questionText += '\n\nPlease reply with the number of your choice (1, 2, 3...)';
    } else if (question.question_type === 'likert') {
      let scale;
      try {
        scale = typeof question.scale === 'string' 
          ? JSON.parse(question.scale) 
          : question.scale;
      } catch (e) {
        // Default scale if parsing fails
        scale = { min: 1, max: 5, labels: ['Poor', 'Excellent'] };
        logger.error('Invalid scale format for question', { 
          questionId: question.id, 
          scale: question.scale 
        });
      }
      
      questionText += `\n\nRate from ${scale.min} to ${scale.max}`;
      questionText += `\n(${scale.min} = ${scale.labels[0]}, ${scale.max} = ${scale.labels[1]})`;
      questionText += '\n\nPlease reply with a number';
    } else if (question.question_type === 'text') {
      questionText += '\n\nPlease provide your answer in text or voice message.';
    }
    
    await message.reply(questionText);
    
    // Update session
    await client.query(
      'UPDATE sessions SET current_question = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [question.question_number, session.id]
    );
    
  } catch (error) {
    logger.error('Error in sendQuestion', error);
    await message.reply('Sorry, there was an error loading the question. Please try again.');
  } finally {
    client.release();
  }
}

// Updated processResponse function with conversational acknowledgments
async function processResponse(session, message) {
  const client = await pool.connect();
  try {
    // Check if this is a voice confirmation response
    if (session.stage === 'voice_confirmation') {
      await handleVoiceConfirmation(session, message, client);
      return;
    }
    
    // Check if this is a follow-up response
    if (session.stage === 'followup') {
      await handleFollowupResponse(session, message, client);
      return;
    }
    
    const result = await client.query(
      'SELECT * FROM questions WHERE survey_id = $1 AND question_number = $2',
      [session.survey_id, session.current_question]
    );
    
    if (result.rows.length === 0) {
      await message.reply('Something went wrong. Please start over.');
      return;
    }
    
    const question = result.rows[0];
    let answer = message.body;
    let followUpComment = null;
    let voiceMetadata = null;
    
    // Handle voice messages with enhanced error handling
    if (message.hasMedia && message.type === 'ptt') {
      logger.info('Processing voice message...');
      
      try {
        const media = await message.downloadMedia();
        logger.info(`Downloaded voice message: ${media.mimetype}, size: ${media.data.length}`);
        
        if (isOpenAIConfigured) {
          const transcription = await transcribeVoice(media);
          
          if (transcription) {
            answer = transcription;
            voiceMetadata = { 
              duration: message.duration || 0,
              transcribed: true,
              originalTranscription: transcription,
              mimetype: media.mimetype
            };
            
            // Store transcription in session for confirmation
            await client.query(
              `UPDATE sessions 
               SET session_data = jsonb_set(
                 COALESCE(session_data, '{}'), 
                 '{pendingVoiceResponse}', 
                 $1::jsonb
               ),
               stage = 'voice_confirmation'
               WHERE id = $2`,
              [JSON.stringify({ 
                answer, 
                questionId: question.id, 
                voiceMetadata,
                questionType: question.question_type 
              }), session.id]
            );
            
            // Ask for confirmation
            await message.reply(`I heard: "${answer}"\n\nIs this correct?\n1. Yes\n2. No, let me try again`);
            return;
          } else {
            logger.warn('Transcription returned empty result');
            await message.reply('Sorry, I couldn\'t understand the voice message. Please try again or type your response.');
            return;
          }
        } else {
          await message.reply('Voice transcription is not available. Please type your response instead.');
          return;
        }
      } catch (error) {
        logger.error('Error processing voice message:', error);
        await message.reply('Sorry, there was an error processing your voice message. Please try again or type your response.');
        return;
      }
    }
    
    // Store original answer for acknowledgment
    let originalAnswer = answer;
    let formattedAnswer = answer;
    
    // Validate answer based on question type
    if (question.question_type === 'multiple' || question.question_type === 'curated') {
      let options;
      try {
        options = typeof question.options === 'string' 
          ? JSON.parse(question.options) 
          : question.options;
      } catch (e) {
        // Handle comma-separated string
        if (typeof question.options === 'string' && question.options.includes(',')) {
          options = question.options.split(',').map(opt => opt.trim());
        } else {
          options = ['Option 1', 'Option 2'];
        }
      }
      
      const choice = parseInt(answer);
      if (choice >= 1 && choice <= options.length) {
        answer = options[choice - 1];
        formattedAnswer = answer.toLowerCase();
      } else {
        await message.reply(`Please reply with a number between 1 and ${options.length}.`);
        return;
      }
    } else if (question.question_type === 'likert') {
      let scale;
      try {
        scale = typeof question.scale === 'string' 
          ? JSON.parse(question.scale) 
          : question.scale;
      } catch (e) {
        scale = { min: 1, max: 5 };
      }
      
      const rating = parseInt(answer);
      if (rating >= scale.min && rating <= scale.max) {
        answer = rating.toString();
        formattedAnswer = `a rating of ${rating}`;
      } else {
        await message.reply(`Please reply with a number between ${scale.min} and ${scale.max}.`);
        return;
      }
    }
    
    // Check if response already exists
    const existingResponse = await client.query(
      'SELECT id FROM responses WHERE survey_id = $1 AND participant_id = $2 AND question_id = $3',
      [session.survey_id, session.participant_id, question.id]
    );
    
    if (existingResponse.rows.length > 0) {
      // Update existing response instead of inserting
      await client.query(
        'UPDATE responses SET answer = $1, voice_metadata = $2, created_at = CURRENT_TIMESTAMP WHERE survey_id = $3 AND participant_id = $4 AND question_id = $5',
        [answer, voiceMetadata ? JSON.stringify(voiceMetadata) : null, session.survey_id, session.participant_id, question.id]
      );
      logger.info(`Updated existing response for participant ${session.participant_id}, question ${question.id}`);
    } else {
      // Insert new response
      await client.query(
        'INSERT INTO responses (survey_id, participant_id, question_id, answer, follow_up_comment, voice_metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [session.survey_id, session.participant_id, question.id, answer, followUpComment, voiceMetadata ? JSON.stringify(voiceMetadata) : null]
      );
    }
    
    // Create conversational acknowledgment based on question type
    let acknowledgment = '';
    
    if (question.question_type === 'curated') {
      if (formattedAnswer === 'agree') {
        acknowledgment = `Thank you for sharing that you agree with the statement.`;
      } else if (formattedAnswer === 'disagree') {
        acknowledgment = `Thank you for sharing that you disagree with the statement.`;
      } else if (formattedAnswer === 'neutral' || formattedAnswer === 'undecided') {
        acknowledgment = `Thank you for sharing that you're undecided about this statement.`;
      } else {
        acknowledgment = `Thank you for your response.`;
      }
    } else if (question.question_type === 'multiple') {
      acknowledgment = `Thank you for selecting "${answer}".`;
    } else if (question.question_type === 'likert') {
      acknowledgment = `Thank you for giving ${formattedAnswer}.`;
    } else {
      acknowledgment = `Thank you for your response.`;
    }
    
    // Broadcast new response for real-time analytics
    const responseData = {
      surveyId: session.survey_id,
      participantId: session.participant_id,
      phoneNumber: session.phone_number,
      question: question.question_text,
      answer: answer,
      timestamp: new Date().toISOString()
    };
    io.emit('new-response', responseData);
    
    // Ask follow-up question with conversational tone
    const shouldAskFollowUp = true; // You can make this configurable per survey
    
    if (shouldAskFollowUp && isOpenAIConfigured) {
      await client.query(
        `UPDATE sessions 
         SET stage = 'followup',
             session_data = jsonb_set(
               COALESCE(session_data, '{}'), 
               '{lastQuestionId}', 
               $1::jsonb
             )
         WHERE id = $2`,
        [question.id.toString(), session.id]
      );
      
      // Conversational follow-up message
      let followUpMessage = acknowledgment + ' ';
      
      if (question.question_type === 'curated') {
        if (formattedAnswer === 'agree') {
          followUpMessage += `Can you tell me more about why you agree?\n\n`;
        } else if (formattedAnswer === 'disagree') {
          followUpMessage += `Can you tell me more about why you disagree?\n\n`;
        } else {
          followUpMessage += `Can you tell me more about why you're undecided?\n\n`;
        }
      } else if (question.question_type === 'multiple') {
        followUpMessage += `Can you tell me more about why you chose this option?\n\n`;
      } else if (question.question_type === 'likert') {
        followUpMessage += `Can you tell me more about why you gave this rating?\n\n`;
      } else {
        followUpMessage += `Would you like to elaborate on your answer?\n\n`;
      }
      
      followUpMessage += `You can:\n`;
      followUpMessage += `🎤 Send a voice message (I'll transcribe it)\n`;
      followUpMessage += `💬 Type your response\n`;
      followUpMessage += `⏭️ Type 'skip' to continue\n\n`;
      followUpMessage += `I'd love to hear your thoughts!`;
      
      await message.reply(followUpMessage);
      return;
    }
    
    // If no follow-up, just send acknowledgment and move to next question
    await message.reply(acknowledgment);
    
    // Move to next question
    await sendQuestion(session, message);
    
  } catch (error) {
    logger.error('Error in processResponse', error);
    
    // If it's a duplicate key error, try to recover gracefully
    if (error.code === '23505') {
      logger.warn('Duplicate response detected, moving to next question');
      try {
        await sendQuestion(session, message);
      } catch (sendError) {
        logger.error('Error sending next question after duplicate', sendError);
        await message.reply('Sorry, something went wrong. Please try again.');
      }
    } else {
      await message.reply('Sorry, something went wrong. Please try again.');
    }
  } finally {
    client.release();
  }
}

// Enhanced voice transcription with better error handling
async function transcribeVoice(media) {
  if (!process.env.OPENAI_API_KEY) {
    logger.error('OpenAI API key not configured');
    return null;
  }
  
  try {
    logger.info('Starting voice transcription...');
    
    // Ensure we have valid media data
    if (!media || !media.data) {
      logger.error('No media data received');
      return null;
    }
    
    const formData = new FormData();
    
    // Convert base64 to buffer and append with proper mime type
    const audioBuffer = Buffer.from(media.data, 'base64');
    
    // WhatsApp voice messages are usually in ogg format
    formData.append('file', audioBuffer, {
      filename: 'audio.ogg',
      contentType: media.mimetype || 'audio/ogg'
    });
    formData.append('model', 'whisper-1');
    
    logger.info(`Sending audio to OpenAI (size: ${audioBuffer.length} bytes, type: ${media.mimetype})`);
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.text();
      logger.error(`OpenAI API error: ${response.status} - ${errorData}`);
      return null;
    }
    
    const result = await response.json();
    logger.info(`Transcription successful: "${result.text}"`);
    return result.text;
    
  } catch (error) {
    logger.error('Voice transcription failed:', error);
    return null;
  }
}

// Fixed processResponse function with duplicate handling and enhanced voice support
async function processResponse(session, message) {
  const client = await pool.connect();
  try {
    // Check if this is a voice confirmation response
    if (session.stage === 'voice_confirmation') {
      await handleVoiceConfirmation(session, message, client);
      return;
    }
    
    // Check if this is a follow-up response
    if (session.stage === 'followup') {
      await handleFollowupResponse(session, message, client);
      return;
    }
    
    const result = await client.query(
      'SELECT * FROM questions WHERE survey_id = $1 AND question_number = $2',
      [session.survey_id, session.current_question]
    );
    
    if (result.rows.length === 0) {
      await message.reply('Something went wrong. Please start over.');
      return;
    }
    
    const question = result.rows[0];
    let answer = message.body;
    let followUpComment = null;
    let voiceMetadata = null;
    
    // Handle voice messages with enhanced error handling
    if (message.hasMedia && message.type === 'ptt') {
      logger.info('Processing voice message...');
      
      try {
        const media = await message.downloadMedia();
        logger.info(`Downloaded voice message: ${media.mimetype}, size: ${media.data.length}`);
        
        if (isOpenAIConfigured) {
          const transcription = await transcribeVoice(media);
          
          if (transcription) {
            answer = transcription;
            voiceMetadata = { 
              duration: message.duration || 0,
              transcribed: true,
              originalTranscription: transcription,
              mimetype: media.mimetype
            };
            
            // Store transcription in session for confirmation
            await client.query(
              `UPDATE sessions 
               SET session_data = jsonb_set(
                 COALESCE(session_data, '{}'), 
                 '{pendingVoiceResponse}', 
                 $1::jsonb
               ),
               stage = 'voice_confirmation'
               WHERE id = $2`,
              [JSON.stringify({ 
                answer, 
                questionId: question.id, 
                voiceMetadata,
                questionType: question.question_type 
              }), session.id]
            );
            
            // Ask for confirmation
            await message.reply(`I heard: "${answer}"\n\nIs this correct?\n1. Yes\n2. No, let me try again`);
            return;
          } else {
            logger.warn('Transcription returned empty result');
            await message.reply('Sorry, I couldn\'t understand the voice message. Please try again or type your response.');
            return;
          }
        } else {
          await message.reply('Voice transcription is not available. Please type your response instead.');
          return;
        }
      } catch (error) {
        logger.error('Error processing voice message:', error);
        await message.reply('Sorry, there was an error processing your voice message. Please try again or type your response.');
        return;
      }
    }
    
    // Validate answer based on question type
    if (question.question_type === 'multiple' || question.question_type === 'curated') {
      let options;
      try {
        options = typeof question.options === 'string' 
          ? JSON.parse(question.options) 
          : question.options;
      } catch (e) {
        // Handle comma-separated string
        if (typeof question.options === 'string' && question.options.includes(',')) {
          options = question.options.split(',').map(opt => opt.trim());
        } else {
          options = ['Option 1', 'Option 2'];
        }
      }
      
      const choice = parseInt(answer);
      if (choice >= 1 && choice <= options.length) {
        answer = options[choice - 1];
      } else {
        await message.reply(`Please reply with a number between 1 and ${options.length}.`);
        return;
      }
    } else if (question.question_type === 'likert') {
      let scale;
      try {
        scale = typeof question.scale === 'string' 
          ? JSON.parse(question.scale) 
          : question.scale;
      } catch (e) {
        scale = { min: 1, max: 5 };
      }
      
      const rating = parseInt(answer);
      if (rating >= scale.min && rating <= scale.max) {
        answer = rating.toString();
      } else {
        await message.reply(`Please reply with a number between ${scale.min} and ${scale.max}.`);
        return;
      }
    }
    
    // Check if response already exists
    const existingResponse = await client.query(
      'SELECT id FROM responses WHERE survey_id = $1 AND participant_id = $2 AND question_id = $3',
      [session.survey_id, session.participant_id, question.id]
    );
    
    if (existingResponse.rows.length > 0) {
      // Update existing response instead of inserting
      await client.query(
        'UPDATE responses SET answer = $1, voice_metadata = $2, created_at = CURRENT_TIMESTAMP WHERE survey_id = $3 AND participant_id = $4 AND question_id = $5',
        [answer, voiceMetadata ? JSON.stringify(voiceMetadata) : null, session.survey_id, session.participant_id, question.id]
      );
      logger.info(`Updated existing response for participant ${session.participant_id}, question ${question.id}`);
    } else {
      // Insert new response
      await client.query(
        'INSERT INTO responses (survey_id, participant_id, question_id, answer, follow_up_comment, voice_metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [session.survey_id, session.participant_id, question.id, answer, followUpComment, voiceMetadata ? JSON.stringify(voiceMetadata) : null]
      );
    }
    
    // Send confirmation
    await message.reply(`Thank you! Your answer: "${answer}"`);
    
    // Broadcast new response for real-time analytics
    const responseData = {
      surveyId: session.survey_id,
      participantId: session.participant_id,
      phoneNumber: session.phone_number,
      question: question.question_text,
      answer: answer,
      timestamp: new Date().toISOString()
    };
    io.emit('new-response', responseData);
    
    // Ask follow-up for text responses
    if (question.question_type === 'text' && isOpenAIConfigured) {
      await client.query(
        `UPDATE sessions 
         SET stage = 'followup',
             session_data = jsonb_set(
               COALESCE(session_data, '{}'), 
               '{lastQuestionId}', 
               $1::jsonb
             )
         WHERE id = $2`,
        [question.id.toString(), session.id]
      );
      
      await message.reply(`Would you like to elaborate on your answer? You can send a voice message or type "skip" to continue.`);
      return;
    }
    
    // Move to next question
    await sendQuestion(session, message);
    
  } catch (error) {
    logger.error('Error in processResponse', error);
    
    // If it's a duplicate key error, try to recover gracefully
    if (error.code === '23505') {
      logger.warn('Duplicate response detected, moving to next question');
      try {
        await sendQuestion(session, message);
      } catch (sendError) {
        logger.error('Error sending next question after duplicate', sendError);
        await message.reply('Sorry, something went wrong. Please try again.');
      }
    } else {
      await message.reply('Sorry, something went wrong. Please try again.');
    }
  } finally {
    client.release();
  }
}

// Handle voice confirmation
async function handleVoiceConfirmation(session, message, client) {
  try {
    const response = message.body.trim();
    const sessionData = session.session_data || {};
    const pendingResponse = sessionData.pendingVoiceResponse;
    
    if (!pendingResponse) {
      await message.reply('Sorry, I lost track of your response. Please answer the question again.');
      await client.query('UPDATE sessions SET stage = $1 WHERE id = $2', ['survey', session.id]);
      return;
    }
    
    if (response === '1' || response.toLowerCase() === 'yes') {
      // Save the transcribed response
      await client.query(
        'INSERT INTO responses (survey_id, participant_id, question_id, answer, voice_metadata) VALUES ($1, $2, $3, $4, $5)',
        [session.survey_id, session.participant_id, pendingResponse.questionId, pendingResponse.answer, JSON.stringify(pendingResponse.voiceMetadata)]
      );
      
      // Get question details for proper acknowledgment
      const questionResult = await client.query(
        'SELECT * FROM questions WHERE id = $1',
        [pendingResponse.questionId]
      );
      const question = questionResult.rows[0];
      
      // Create acknowledgment based on answer and question type
      let acknowledgment = 'Thank you for your response.';
      if (question && question.question_type === 'curated') {
        const formattedAnswer = pendingResponse.answer.toLowerCase();
        if (formattedAnswer.includes('agree')) {
          acknowledgment = 'Thank you for sharing that you agree with the statement.';
        } else if (formattedAnswer.includes('disagree')) {
          acknowledgment = 'Thank you for sharing that you disagree with the statement.';
        } else if (formattedAnswer.includes('neutral') || formattedAnswer.includes('undecided')) {
          acknowledgment = 'Thank you for sharing that you\'re undecided about this statement.';
        }
      }
      
      // Clear pending response and move to follow-up
      await client.query(
        'UPDATE sessions SET stage = $1, session_data = jsonb_set(session_data - $2, \'{lastQuestionId}\', $3::jsonb) WHERE id = $4',
        ['followup', 'pendingVoiceResponse', pendingResponse.questionId.toString(), session.id]
      );
      
      // Broadcast response
      io.emit('new-response', {
        surveyId: session.survey_id,
        participantId: session.participant_id,
        phoneNumber: session.phone_number,
        answer: pendingResponse.answer,
        isVoice: true,
        timestamp: new Date().toISOString()
      });
      
      // Ask follow-up question with acknowledgment
      let followUpMessage = acknowledgment + ' Can you tell me more about your response?\n\n';
      followUpMessage += 'You can:\n';
      followUpMessage += '🎤 Send a voice message (I\'ll transcribe it)\n';
      followUpMessage += '💬 Type your response\n';
      followUpMessage += '⏭️ Type \'skip\' to continue\n\n';
      followUpMessage += 'I\'d love to hear your thoughts!';
      
      await message.reply(followUpMessage);
    } else if (response === '2' || response.toLowerCase() === 'no') {
      // Clear pending response and ask to try again
      await client.query(
        'UPDATE sessions SET stage = $1, session_data = session_data - $2 WHERE id = $3',
        ['survey', 'pendingVoiceResponse', session.id]
      );
      
      await message.reply('No problem! Please send your voice message again or type your answer.');
    } else {
      await message.reply('Please reply with:\n1. Yes\n2. No, let me try again');
    }
  } catch (error) {
    logger.error('Error in handleVoiceConfirmation', error);
    await message.reply('Sorry, something went wrong. Please try again.');
  }
}

// Handle follow-up responses
async function handleFollowupResponse(session, message, client) {
  try {
    if (message.body.toLowerCase() === 'skip') {
      // Acknowledge skip and move to next question
      await message.reply('No problem! Let\'s continue with the next question.');
      await client.query('UPDATE sessions SET stage = $1 WHERE id = $2', ['survey', session.id]);
      await sendQuestion(session, message);
      return;
    }
    
    let followUpComment = message.body;
    let voiceMetadata = null;
    
    // Handle voice follow-up
    if (message.hasMedia && message.type === 'ptt') {
      const media = await message.downloadMedia();
      if (isOpenAIConfigured) {
        const transcription = await transcribeVoice(media);
        followUpComment = transcription || 'Voice follow-up (transcription failed)';
        voiceMetadata = { 
          duration: message.duration || 0,
          transcribed: !!transcription 
        };
        
        if (transcription) {
          await message.reply(`I heard: "${transcription}"\n\nThank you for sharing your thoughts! 🙏`);
        }
      }
    } else {
      await message.reply('Thank you for sharing your thoughts! 🙏');
    }
    
    // Update the last response with follow-up
    const lastQuestionId = session.session_data?.lastQuestionId;
    if (lastQuestionId) {
      await client.query(
        'UPDATE responses SET follow_up_comment = $1 WHERE survey_id = $2 AND participant_id = $3 AND question_id = $4',
        [followUpComment, session.survey_id, session.participant_id, lastQuestionId]
      );
    }
    
    // Small delay for better conversation flow
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Move to next question
    await client.query('UPDATE sessions SET stage = $1 WHERE id = $2', ['survey', session.id]);
    await sendQuestion(session, message);
    
  } catch (error) {
    logger.error('Error in handleFollowupResponse', error);
    await message.reply('Sorry, something went wrong. Please try again.');
  }
}

// Complete survey
async function completeSurvey(session, message) {
  const client = await pool.connect();
  try {
    // Calculate duration
    const startTime = await client.query(
      'SELECT started_at FROM survey_participants WHERE survey_id = $1 AND participant_id = $2',
      [session.survey_id, session.participant_id]
    );
    
    const duration = startTime.rows[0] ? 
      Math.floor((new Date() - new Date(startTime.rows[0].started_at)) / 1000) : 0;
    
    // Update session
    await client.query(
      'UPDATE sessions SET stage = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['completed', session.id]
    );
    
    // Update survey_participants
    await client.query(
      'UPDATE survey_participants SET completed_at = CURRENT_TIMESTAMP, is_completed = true, completion_duration_seconds = $1 WHERE survey_id = $2 AND participant_id = $3',
      [duration, session.survey_id, session.participant_id]
    );
    
    // Send completion message
    await message.reply('🎉 Thank you for completing the survey! Your responses have been recorded.\n\nHave a great day! 😊');
    
    // Broadcast completion
    io.emit('survey-completed', {
      participant: session.phone_number,
      surveyId: session.survey_id,
      duration: duration,
      timestamp: new Date().toISOString()
    });
    
  } finally {
    client.release();
  }
}

// Load active surveys
async function loadActiveSurveys() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM surveys WHERE is_active = true'
    );
    
    activeSurveys.clear();
    result.rows.forEach(survey => {
      activeSurveys.set(survey.id, survey);
    });
    
    logger.info(`Loaded ${result.rows.length} active surveys`);
  } catch (error) {
    if (error.code === '42P01') {
      logger.warn('Database tables not found. Please run: node database-setup.js');
    } else {
      logger.error('Error loading active surveys', error);
    }
  } finally {
    client.release();
  }
}

// API Routes

// Get all surveys
app.get('/api/surveys', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT s.*, 
             COUNT(DISTINCT q.id) as question_count,
             COUNT(DISTINCT sp.participant_id) as participant_count,
             COUNT(DISTINCT CASE WHEN sp.is_completed THEN sp.participant_id END) as completed_count
      FROM surveys s
      LEFT JOIN questions q ON s.id = q.survey_id
      LEFT JOIN survey_participants sp ON s.id = sp.survey_id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    logger.error('Error fetching surveys', error);
    res.status(500).json({ error: 'Failed to fetch surveys' });
  } finally {
    client.release();
  }
});

// Create new survey
app.post('/api/surveys', async (req, res) => {
  const client = await pool.connect();
  try {
    const { title, description, estimatedTime, questions } = req.body;
    
    if (!title || !questions || questions.length === 0) {
      return res.status(400).json({ error: 'Title and questions are required' });
    }
    
    await client.query('BEGIN');
    
    const surveyId = Date.now().toString();
    const participantPrefix = title.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 10) || 'SURVEY';
    
    // Insert survey
    await client.query(
      'INSERT INTO surveys (id, title, description, estimated_time, participant_prefix) VALUES ($1, $2, $3, $4, $5)',
      [surveyId, title, description || '', estimatedTime || '3-5 minutes', participantPrefix]
    );
    
    // Insert questions
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      await client.query(
        'INSERT INTO questions (survey_id, question_number, question_type, question_text, options, scale) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          surveyId,
          i + 1,
          question.type,
          question.question,
          question.options ? JSON.stringify(question.options) : null,
          question.scale ? JSON.stringify(question.scale) : null
        ]
      );
    }
    
    await client.query('COMMIT');
    
    res.json({ success: true, surveyId });
    
    io.emit('survey-created', { surveyId, title });
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error creating survey', error);
    res.status(500).json({ error: 'Failed to create survey' });
  } finally {
    client.release();
  }
});

// Activate/deactivate survey
app.post('/api/surveys/:id/activate', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    
    // Deactivate all other surveys
    await client.query('UPDATE surveys SET is_active = false');
    
    // Activate this survey
    await client.query('UPDATE surveys SET is_active = true WHERE id = $1', [id]);
    
    await loadActiveSurveys();
    
    res.json({ success: true });
    
    io.emit('survey-activated', { surveyId: id });
    
  } catch (error) {
    logger.error('Error activating survey', error);
    res.status(500).json({ error: 'Failed to activate survey' });
  } finally {
    client.release();
  }
});

app.post('/api/surveys/:id/deactivate', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    
    await client.query('UPDATE surveys SET is_active = false WHERE id = $1', [id]);
    
    await loadActiveSurveys();
    
    res.json({ success: true });
    
    io.emit('survey-deactivated', { surveyId: id });
    
  } catch (error) {
    logger.error('Error deactivating survey', error);
    res.status(500).json({ error: 'Failed to deactivate survey' });
  } finally {
    client.release();
  }
});

// Get survey responses for analytics
app.get('/api/surveys/:id/responses', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    
    const result = await client.query(`
      SELECT 
        q.question_text,
        q.question_type,
        q.question_number,
        r.answer,
        r.follow_up_comment,
        r.created_at,
        p.participant_code
      FROM responses r
      JOIN questions q ON r.question_id = q.id
      JOIN participants p ON r.participant_id = p.id
      WHERE r.survey_id = $1
      ORDER BY q.question_number, r.created_at
    `, [id]);
    
    res.json(result.rows);
  } catch (error) {
    logger.error('Error fetching survey responses', error);
    res.status(500).json({ error: 'Failed to fetch responses' });
  } finally {
    client.release();
  }
});

// Export survey data as CSV - FIXED VERSION
app.get('/api/surveys/:id/export', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    
    // First get survey details
    const surveyResult = await client.query(
      'SELECT title FROM surveys WHERE id = $1',
      [id]
    );
    
    if (surveyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    const surveyTitle = surveyResult.rows[0].title;
    
    // Get all responses with full details
    const result = await client.query(`
      SELECT 
        p.participant_code,
        p.phone_number,
        q.question_number,
        q.question_type,
        q.question_text,
        r.answer,
        r.follow_up_comment,
        r.voice_metadata,
        r.created_at as response_time,
        sp.started_at,
        sp.completed_at,
        sp.is_completed,
        sp.completion_duration_seconds
      FROM responses r
      JOIN participants p ON r.participant_id = p.id
      JOIN questions q ON r.question_id = q.id
      JOIN survey_participants sp ON r.survey_id = sp.survey_id AND r.participant_id = sp.participant_id
      WHERE r.survey_id = $1
      ORDER BY p.participant_code, q.question_number
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No responses found for this survey' });
    }
    
    // Create CSV content
    const csvRows = [];
    
    // Headers
    const headers = [
      'Participant Code',
      'Phone Number',
      'Question Number',
      'Question Type',
      'Question',
      'Answer',
      'Follow-up Comment',
      'Was Voice Response',
      'Response Time',
      'Survey Started',
      'Survey Completed',
      'Completion Status',
      'Duration (seconds)'
    ];
    
    csvRows.push(headers.join(','));
    
    // Data rows
    result.rows.forEach(row => {
      const voiceMetadata = row.voice_metadata ? 
        (typeof row.voice_metadata === 'string' ? JSON.parse(row.voice_metadata) : row.voice_metadata) : null;
      const isVoiceResponse = voiceMetadata && voiceMetadata.transcribed ? 'Yes' : 'No';
      
      const csvRow = [
        row.participant_code,
        row.phone_number,
        row.question_number,
        row.question_type,
        `"${(row.question_text || '').replace(/"/g, '""')}"`, // Escape quotes in question text
        `"${(row.answer || '').replace(/"/g, '""')}"`, // Escape quotes in answer
        `"${(row.follow_up_comment || '').replace(/"/g, '""')}"`, // Escape quotes in follow-up
        isVoiceResponse,
        new Date(row.response_time).toISOString(),
        row.started_at ? new Date(row.started_at).toISOString() : '',
        row.completed_at ? new Date(row.completed_at).toISOString() : '',
        row.is_completed ? 'Completed' : 'In Progress',
        row.completion_duration_seconds || ''
      ];
      
      csvRows.push(csvRow.join(','));
    });
    
    // Create CSV content
    const csvContent = csvRows.join('\n');
    
    // Set headers for file download
    const filename = `survey_${surveyTitle.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // Send CSV file
    res.send(csvContent);
    
    logger.info(`Exported ${result.rows.length} responses for survey ${id}`);
    
  } catch (error) {
    logger.error('Error exporting survey data', error);
    res.status(500).json({ error: 'Failed to export survey data' });
  } finally {
    client.release();
  }
});

// Get survey statistics
app.get('/api/stats', async (req, res) => {
  const client = await pool.connect();
  try {
    const stats = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM surveys) as total_surveys,
        (SELECT COUNT(*) FROM participants) as total_participants,
        (SELECT COUNT(*) FROM responses) as total_responses,
        (SELECT title FROM surveys WHERE is_active = true LIMIT 1) as active_survey
    `);
    
    res.json(stats.rows[0]);
  } catch (error) {
    logger.error('Error fetching stats', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  } finally {
    client.release();
  }
});

// OpenAI status
app.get('/api/openai/status', (req, res) => {
  res.json({ 
    configured: !!process.env.OPENAI_API_KEY,
    features: {
      voiceTranscription: !!process.env.OPENAI_API_KEY,
      followUpQuestions: !!process.env.OPENAI_API_KEY
    }
  });
});

// Enhanced OpenAI test endpoint
app.post('/api/openai/test', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    return res.json({ 
      success: false, 
      error: 'OPENAI_API_KEY not found in environment variables',
      configured: false 
    });
  }
  
  try {
    // Test the API key format
    if (!apiKey.startsWith('sk-')) {
      return res.json({ 
        success: false, 
        error: 'Invalid API key format (should start with sk-)',
        configured: true 
      });
    }
    
    // Test API connection
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    if (response.ok) {
      const models = await response.json();
      const hasWhisper = models.data.some(m => m.id.includes('whisper'));
      
      res.json({ 
        success: true,
        configured: true,
        hasWhisper,
        message: 'OpenAI API connection successful'
      });
    } else {
      const errorData = await response.text();
      res.json({ 
        success: false, 
        error: `OpenAI API error: ${response.status} - ${errorData}`,
        configured: true
      });
    }
  } catch (error) {
    res.json({ 
      success: false, 
      error: `Connection error: ${error.message}`,
      configured: true
    });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info('Admin client connected via ' + socket.conn.transport.name);
  connectedClients.add(socket);
  
  // Send current status
  socket.emit('whatsapp-ready', isClientReady);
  socket.emit('openai-status', { 
    configured: !!process.env.OPENAI_API_KEY 
  });
  
  if (qrCodeData) {
    socket.emit('qr-code', { qrCode: qrCodeData });
  }
  
  // Send current stats
  broadcastStats();
  
  socket.on('disconnect', () => {
    logger.info('Admin client disconnected');
    connectedClients.delete(socket);
  });
  
  socket.on('error', (error) => {
    logger.error('Socket error', error);
  });
});

// Broadcast statistics
async function broadcastStats() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM surveys) as total_surveys,
        (SELECT COUNT(*) FROM participants) as total_participants,
        (SELECT COUNT(*) FROM responses) as total_responses,
        (SELECT title FROM surveys WHERE is_active = true LIMIT 1) as active_survey
    `);
    
    io.emit('survey-stats', result.rows[0]);
  } catch (error) {
    if (error.code === '42P01') {
      logger.debug('Database tables not found for stats broadcast');
      io.emit('survey-stats', {
        total_surveys: 0,
        total_participants: 0,
        total_responses: 0,
        active_survey: null
      });
    } else {
      logger.error('Error broadcasting stats', error);
    }
  } finally {
    client.release();
  }
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT 1');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      whatsapp: isClientReady,
      openai: !!process.env.OPENAI_API_KEY,
      database: dbResult.rows.length > 0,
      transport: io.engine ? io.engine.transport.name : 'unknown'
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

// Serve admin dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled API error', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Database connection test
async function testDatabaseConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    logger.info('Database connection successful');
  } catch (error) {
    logger.error('Database connection failed', error);
    throw error;
  }
}

// Initialize application
async function initialize() {
  try {
    logger.info('🚀 Starting WhatsApp Survey Platform...');
    
    // Test database connection
    await testDatabaseConnection();
    
    // Check OpenAI configuration
    if (process.env.OPENAI_API_KEY) {
      isOpenAIConfigured = true;
      logger.info('OpenAI integration enabled');
    } else {
      logger.warn('OpenAI API key not configured - voice transcription disabled');
    }
    
    // Initialize WhatsApp client
    initializeWhatsApp();
    
    // Try to load active surveys (graceful if tables don't exist)
    await loadActiveSurveys();
    
    // Start server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🎉 Server running on port ${PORT}`);
      logger.info(`📱 Admin dashboard: http://localhost:${PORT}`);
      logger.info(`🔧 Transport support: polling, websocket`);
      if (process.env.NODE_ENV === 'production') {
        logger.info(`🌐 Production mode enabled`);
      }
    });
    
    // Broadcast stats every 30 seconds
    setInterval(() => {
      broadcastStats().catch(error => {
        logger.debug('Error broadcasting stats (tables may not exist yet)', error);
      });
    }, 30000);
    
  } catch (error) {
    logger.error('Failed to initialize application', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  
  if (client) {
    await client.destroy();
  }
  
  await pool.end();
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  
  if (client) {
    await client.destroy();
  }
  
  await pool.end();
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Initialize the application
initialize();

module.exports = app;
