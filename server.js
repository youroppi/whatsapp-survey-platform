// server.js - Complete WhatsApp Survey Platform Server
// Production-ready server with all functionality

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
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

// Rate limiting with rate-limiter-flexible
const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.ip,
  points: 100, // Number of requests
  duration: 900, // Per 15 minutes (900 seconds)
});

const rateLimitMiddleware = async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch (rejRes) {
    res.status(429).json({ error: 'Too many requests from this IP, please try again later.' });
  }
};

app.use('/api/', rateLimitMiddleware);
app.use(cors());
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

// Initialize WhatsApp client
function initializeWhatsApp() {
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
        '--disable-gpu'
      ]
    }
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
      await handleWhatsAppMessage(message);
    }
  });

  client.initialize();
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
    await client.query(
      'INSERT INTO survey_participants (survey_id, participant_id, participant_survey_code) VALUES ($1, $2, $3)',
      [surveyId, participantId, generateParticipantCode()]
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
    let questionText = `Question ${question.question_number}: ${question.question_text}`;
    
    if (question.question_type === 'multiple') {
      const options = JSON.parse(question.options);
      questionText += '\n\n' + options.map((opt, idx) => `${idx + 1}. ${opt}`).join('\n');
      questionText += '\n\nPlease reply with the number of your choice.';
    } else if (question.question_type === 'curated') {
      const options = JSON.parse(question.options);
      questionText += '\n\n' + options.map((opt, idx) => `${idx + 1}. ${opt}`).join('\n');
      questionText += '\n\nPlease reply with the number of your choice.';
    } else if (question.question_type === 'likert') {
      const scale = JSON.parse(question.scale);
      questionText += `\n\nRate from ${scale.min} to ${scale.max}`;
      questionText += `\n(${scale.min} = ${scale.labels[0]}, ${scale.max} = ${scale.labels[1]})`;
    } else if (question.question_type === 'text') {
      questionText += '\n\nPlease provide your answer in text or voice message.';
    }
    
    await message.reply(questionText);
    
    // Update session
    await client.query(
      'UPDATE sessions SET current_question = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [question.question_number, session.id]
    );
    
  } finally {
    client.release();
  }
}

// Process response
async function processResponse(session, message) {
  const client = await pool.connect();
  try {
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
    
    // Handle voice messages
    if (message.hasMedia && message.type === 'ptt') {
      const media = await message.downloadMedia();
      if (isOpenAIConfigured) {
        const transcription = await transcribeVoice(media);
        answer = transcription || 'Voice message (transcription failed)';
        voiceMetadata = { 
          duration: message.duration || 0,
          transcribed: !!transcription 
        };
      } else {
        answer = 'Voice message (transcription not available)';
      }
    }
    
    // Validate answer based on question type
    if (question.question_type === 'multiple' || question.question_type === 'curated') {
      const options = JSON.parse(question.options);
      const choice = parseInt(answer);
      if (choice >= 1 && choice <= options.length) {
        answer = options[choice - 1];
      } else {
        await message.reply(`Please reply with a number between 1 and ${options.length}.`);
        return;
      }
    } else if (question.question_type === 'likert') {
      const scale = JSON.parse(question.scale);
      const rating = parseInt(answer);
      if (rating >= scale.min && rating <= scale.max) {
        answer = rating.toString();
      } else {
        await message.reply(`Please reply with a number between ${scale.min} and ${scale.max}.`);
        return;
      }
    }
    
    // Save response
    await client.query(
      'INSERT INTO responses (survey_id, participant_id, question_id, answer, follow_up_comment, voice_metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [session.survey_id, session.participant_id, question.id, answer, followUpComment, voiceMetadata ? JSON.stringify(voiceMetadata) : null]
    );
    
    // Send confirmation and next question
    await message.reply(`Thank you! Your answer: "${answer}"`);
    
    // Move to next question
    await sendQuestion(session, message);
    
    // Broadcast new response
    io.emit('new-response', {
      participant: session.phone_number,
      survey: session.survey_id,
      question: question.question_text,
      answer: answer
    });
    
  } finally {
    client.release();
  }
}

// Complete survey
async function completeSurvey(session, message) {
  const client = await pool.connect();
  try {
    // Update session
    await client.query(
      'UPDATE sessions SET stage = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['completed', session.id]
    );
    
    // Update survey_participants
    await client.query(
      'UPDATE survey_participants SET completed_at = CURRENT_TIMESTAMP, is_completed = true WHERE survey_id = $1 AND participant_id = $2',
      [session.survey_id, session.participant_id]
    );
    
    // Send completion message
    await message.reply('🎉 Thank you for completing the survey! Your responses have been recorded.');
    
    // Broadcast completion
    io.emit('survey-completed', {
      participant: session.phone_number,
      survey: session.survey_id
    });
    
  } finally {
    client.release();
  }
}

// Voice transcription with OpenAI
async function transcribeVoice(media) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }
  
  try {
    const formData = new FormData();
    formData.append('file', Buffer.from(media.data, 'base64'), {
      filename: 'audio.ogg',
      contentType: 'audio/ogg'
    });
    formData.append('model', 'whisper-1');
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const result = await response.json();
    return result.text;
  } catch (error) {
    logger.error('Voice transcription failed', error);
    return null;
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
             COUNT(q.id) as question_count,
             COUNT(DISTINCT sp.participant_id) as participant_count
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

// Export survey data
app.get('/api/surveys/:id/export', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    
    const result = await client.query(`
      SELECT 
        p.participant_code,
        p.phone_number,
        q.question_text,
        r.answer,
        r.follow_up_comment,
        r.created_at,
        sp.started_at,
        sp.completed_at,
        sp.is_completed
      FROM responses r
      JOIN participants p ON r.participant_id = p.id
      JOIN questions q ON r.question_id = q.id
      JOIN survey_participants sp ON r.survey_id = sp.survey_id AND r.participant_id = sp.participant_id
      WHERE r.survey_id = $1
      ORDER BY p.participant_code, q.question_number
    `, [id]);
    
    res.json(result.rows.map(row => ({
      participant_code: row.participant_code,
      phone_number: row.phone_number,
      question: row.question_text,
      answer: row.answer,
      follow_up_comment: row.follow_up_comment,
      response_time: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      is_completed: row.is_completed
    })));
    
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
      voiceTranscription: !!process.env.OPENAI_API_KEY
    }
  });
});

// Test OpenAI connection
app.post('/api/openai/test', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.json({ success: false, error: 'OpenAI API key not configured' });
  }
  
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });
    
    if (response.ok) {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: 'OpenAI API key is invalid' });
    }
  } catch (error) {
    res.json({ success: false, error: 'Failed to connect to OpenAI' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info('Admin client connected');
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
    server.listen(PORT, () => {
      logger.info(`🎉 Server running on port ${PORT}`);
      logger.info(`📱 Admin dashboard: http://localhost:${PORT}`);
      logger.info(`🔧 If you see database errors, run: node database-setup.js`);
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
