// server.js - WhatsApp Survey Platform Backend
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

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage (replace with PostgreSQL in production)
let surveys = [];
let responses = [];
let activeSurveys = new Map();
let userSessions = new Map();
let connectedClients = new Set();

// Security and Environment Configuration
const requiredEnvVars = ['OPENAI_API_KEY'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.warn('⚠️  WARNING: Missing required environment variables:', missingEnvVars.join(', '));
  console.warn('⚠️  Voice transcription features will be disabled without OPENAI_API_KEY');
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
  console.warn('🔒 OpenAI API key not configured or invalid. Voice transcription disabled.');
  console.warn('💡 Set OPENAI_API_KEY environment variable to enable voice features.');
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
      return text; // Return original text if translation fails
    }

    const result = await response.json();
    return result.choices[0].message.content.trim();
  } catch (error) {
    console.error('Translation error:', error);
    return text; // Return original text if translation fails
  }
}

async function validateResponse(transcribedText, questionText, questionType) {
  if (!isOpenAIConfigured) {
    return { isValid: true, confidence: 0.8, reason: 'Validation disabled - API key not configured' };
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
            content: `You are an AI assistant that validates survey responses. Your task is to determine if a transcribed voice response is a meaningful answer to a survey question.

Rules:
1. Return "VALID" if the response is a clear, meaningful answer to the question
2. Return "INVALID" if the response is gibberish, unrelated, or doesn't make sense
3. Return "UNCLEAR" if the response is ambiguous but might be valid
4. Consider the question type: ${questionType}
5. Be lenient with casual language, slang, or informal responses
6. Focus on whether there's genuine intent to answer the question

Format your response as JSON:
{
  "status": "VALID|INVALID|UNCLEAR",
  "confidence": 0.0-1.0,
  "reason": "Brief explanation"
}`
          },
          {
            role: 'user',
            content: `Question: "${questionText}"
Question Type: ${questionType}
Response: "${transcribedText}"

Please validate this response.`
          }
        ],
        temperature: 0.1,
        max_tokens: 200
      }),
      timeout: VOICE_PROCESSING_TIMEOUT
    });

    if (!response.ok) {
      console.error('Validation API error:', response.status);
      return { isValid: true, confidence: 0.5, reason: 'Validation service unavailable' };
    }

    const result = await response.json();
    const validationResult = JSON.parse(result.choices[0].message.content);
    
    return {
      isValid: validationResult.status === 'VALID',
      confidence: validationResult.confidence,
      reason: validationResult.reason,
      status: validationResult.status
    };
  } catch (error) {
    console.error('Response validation error:', error);
    return { isValid: true, confidence: 0.5, reason: 'Validation error occurred' };
  }
}

async function generateResponseSummary(transcribedText, originalText, language) {
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
            content: `You are an AI assistant that creates clear, concise summaries of survey responses. Your task is to summarize the user's voice response while preserving their original meaning and sentiment.

Rules:
1. Keep the summary brief but complete
2. Preserve the user's opinion and sentiment
3. Use clear, professional language
4. If the original was in another language, mention the language detected
5. Focus on the key points the user wanted to express`
          },
          {
            role: 'user',
            content: `Original text: "${originalText}"
${language !== 'en' ? `Translated text: "${transcribedText}"` : ''}
Language detected: ${language}

Please provide a clear summary of this response.`
          }
        ],
        temperature: 0.3,
        max_tokens: 150
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
    // Broadcast QR code to all connected admin clients
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
  if (message.from.endsWith('@c.us')) { // Only handle direct messages
    await handleWhatsAppMessage(message);
  }
});

// Start WhatsApp client
client.initialize();

// Survey management functions
function createSurvey(surveyData) {
  const survey = {
    id: Date.now().toString(),
    ...surveyData,
    createdAt: new Date(),
    isActive: false,
    participants: 0,
    responses: 0
  };
  surveys.push(survey);
  return survey;
}

function activateSurvey(surveyId) {
  const survey = surveys.find(s => s.id === surveyId);
  if (survey) {
    // Deactivate all other surveys
    surveys.forEach(s => s.isActive = false);
    survey.isActive = true;
    activeSurveys.set(surveyId, survey);
    return survey;
  }
  return null;
}

function getActiveSurvey() {
  return surveys.find(s => s.isActive);
}

// WhatsApp message handling
async function handleWhatsAppMessage(message) {
  const phoneNumber = message.from;
  const messageText = message.body.toLowerCase().trim();
  
  // Get or create user session
  let session = userSessions.get(phoneNumber);
  if (!session) {
    session = {
      phoneNumber,
      currentQuestion: 0,
      responses: [],
      surveyId: null,
      stage: 'initial'
    };
    userSessions.set(phoneNumber, session);
  }

  const activeSurvey = getActiveSurvey();
  
  if (!activeSurvey) {
    await client.sendMessage(phoneNumber, 
      "Hello! 👋 There's no active survey at the moment. Please check back later!"
    );
    return;
  }

  // Handle different conversation stages
  switch (session.stage) {
    case 'initial':
      await handleInitialMessage(phoneNumber, session, activeSurvey);
      break;
    case 'survey':
      await handleSurveyResponse(phoneNumber, session, activeSurvey, messageText);
      break;
    case 'followup':
      await handleFollowUpResponse(phoneNumber, session, activeSurvey, messageText);
      break;
  }
}

async function handleInitialMessage(phoneNumber, session, survey) {
  session.surveyId = survey.id;
  session.stage = 'survey';
  
  // Send welcome message and first question
  const welcomeMessage = `Welcome to our survey! 📊\n\n*${survey.title}*\n\nThis will take about ${survey.estimatedTime || '3-5'} minutes. Let's get started!\n\n`;
  
  await client.sendMessage(phoneNumber, welcomeMessage);
  await sendCurrentQuestion(phoneNumber, session, survey);
  
  // Update survey stats
  survey.participants++;
  broadcastSurveyStats();
}

async function sendCurrentQuestion(phoneNumber, session, survey) {
  const question = survey.questions[session.currentQuestion];
  if (!question) return;

  let questionText = `*Question ${session.currentQuestion + 1}/${survey.questions.length}*\n\n${question.question}\n\n`;
  
  // Add options based on question type
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
      questionText += `Rate from ${question.scale.min} to ${question.scale.max}\n`;
      questionText += `${question.scale.min} = ${question.scale.labels[0]}\n`;
      questionText += `${question.scale.max} = ${question.scale.labels[1]}\n\n`;
      questionText += `Reply with a number from ${question.scale.min} to ${question.scale.max}`;
      break;
    
    case 'text':
      questionText += 'Please type your answer:';
      break;
  }
  
  await client.sendMessage(phoneNumber, questionText);
}

async function handleSurveyResponse(phoneNumber, session, survey, messageText, isVoiceMessage, message) {
  const question = survey.questions[session.currentQuestion];
  let selectedAnswer = null;
  let isValidAnswer = false;

  // Handle voice messages for survey responses (usually not needed for multiple choice)
  if (isVoiceMessage) {
    await client.sendMessage(phoneNumber, 
      "I received your voice message! 🎵 For survey questions, please respond with the number of your choice or type your answer. You can use voice messages for follow-up explanations! 😊"
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
      if (rating >= question.scale.min && rating <= question.scale.max) {
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
      "Sorry, I didn't understand that. Please try again with a valid option. 🤔"
    );
    return;
  }

  // Store response
  const response = {
    phoneNumber,
    surveyId: survey.id,
    questionId: question.id,
    questionText: question.question,
    answer: selectedAnswer,
    timestamp: new Date()
  };
  
  session.responses.push(response);
  responses.push(response);

  // Ask for follow-up
  session.stage = 'followup';
  await client.sendMessage(phoneNumber, 
    `Great! 👍 Could you tell me why you chose that answer? 

You can:
🎤 Send a voice message (I'll transcribe it)
💬 Type your response
⏭️ Type 'skip' to continue

I'd love to hear your thoughts!`
  );
}

async function handleFollowUpResponse(phoneNumber, session, survey, messageText, isVoiceMessage, message) {
  let followUpText = '';
  let processingVoice = false;

  if (isVoiceMessage) {
    // Check if voice transcription is available
    if (!isOpenAIConfigured) {
      await client.sendMessage(phoneNumber, 
        "🎤 I received your voice message, but voice transcription is not available right now. 😔\n\nCould you please type your response instead? Or type 'skip' to continue."
      );
      return;
    }

    try {
      // Show processing message
      await client.sendMessage(phoneNumber, 
        "🎵 Processing your voice message... This may take a moment!"
      );
      processingVoice = true;

      // Download and process voice message
      const media = await message.downloadMedia();
      const audioBuffer = Buffer.from(media.data, 'base64');
      
      // Check voice duration (basic validation)
      if (audioBuffer.length > MAX_VOICE_DURATION * 1024 * 1024) { // Rough size check
        await client.sendMessage(phoneNumber, 
          `🎤 Voice message is too long. Please keep it under ${MAX_VOICE_DURATION} seconds and try again.`
        );
        return;
      }
      
      // Transcribe with OpenAI Whisper
      const transcription = await transcribeVoiceMessage(audioBuffer, 'voice_message.ogg');
      
      // Translate to English if needed
      const translatedText = await translateToEnglish(transcription.text, transcription.language);
      
      // Validate the response
      const question = survey.questions[session.currentQuestion];
      const validation = await validateResponse(translatedText, question.question, question.type);
      
      if (!validation.isValid) {
        await client.sendMessage(phoneNumber, 
          `🤔 I'm having trouble understanding your voice message. ${validation.reason}

Could you please:
🎤 Try recording again more clearly
💬 Type your response instead
⏭️ Type 'skip' to continue

I want to make sure I capture your thoughts accurately!`
        );
        return;
      }

      // Generate summary
      const summary = await generateResponseSummary(translatedText, transcription.text, transcription.language);
      
      // Store pending validation
      session.pendingVoiceValidation = {
        originalText: transcription.text,
        translatedText: translatedText,
        summary: summary,
        language: transcription.language,
        duration: transcription.duration
      };
      
      // Ask for confirmation
      session.stage = 'voice_confirmation';
      
      let confirmationMessage = `🎤 Voice message received! Here's what I understood:

"${summary}"`;
      
      if (transcription.language !== 'en') {
        confirmationMessage += `\n\n🌍 Detected language: ${transcription.language}`;
      }
      
      confirmationMessage += `\n\nIs this correct?
✅ Type 'yes' to confirm
❌ Type 'no' to try again
⏭️ Type 'skip' to continue without this response`;
      
      await client.sendMessage(phoneNumber, confirmationMessage);
      return;
      
    } catch (error) {
      console.error('Voice processing error:', error);
      
      // Specific error messages based on error type
      let errorMessage = "Sorry, I couldn't process your voice message. 😔";
      
      if (error.message.includes('API key')) {
        errorMessage = "Voice transcription service is temporarily unavailable. 🔧";
      } else if (error.message.includes('timeout')) {
        errorMessage = "Voice processing timed out. Please try a shorter message. ⏱️";
      } else if (error.message.includes('rate limit')) {
        errorMessage = "Too many requests. Please wait a moment and try again. 🚦";
      }
      
      errorMessage += "\n\nPlease try again or type your response instead.";
      
      await client.sendMessage(phoneNumber, errorMessage);
      return;
    }
  } else {
    // Handle text response
    followUpText = messageText;
  }

  // Process the follow-up (for text responses or confirmed voice responses)
  await processFollowUpResponse(phoneNumber, session, survey, followUpText);
}

async function handleVoiceConfirmation(phoneNumber, session, survey, messageText) {
  const response = messageText.toLowerCase().trim();
  
  if (response === 'yes' || response === 'y' || response === 'correct' || response === '✅') {
    // User confirmed the transcription
    const voiceData = session.pendingVoiceValidation;
    await processFollowUpResponse(phoneNumber, session, survey, voiceData.summary, voiceData);
  } else if (response === 'no' || response === 'n' || response === 'incorrect' || response === '❌') {
    // User rejected the transcription
    session.stage = 'followup';
    session.pendingVoiceValidation = null;
    await client.sendMessage(phoneNumber, 
      "No problem! Let's try again. 🔄

You can:
🎤 Send another voice message
💬 Type your response
⏭️ Type 'skip' to continue"
    );
  } else if (response === 'skip') {
    // User wants to skip
    session.pendingVoiceValidation = null;
    await processFollowUpResponse(phoneNumber, session, survey, '');
  } else {
    // Invalid response
    await client.sendMessage(phoneNumber, 
      "Please respond with:
✅ 'yes' to confirm
❌ 'no' to try again  
⏭️ 'skip' to continue"
    );
  }
}

async function processFollowUpResponse(phoneNumber, session, survey, followUpText, voiceData = null) {
  // Store follow-up if provided
  if (followUpText && followUpText !== 'skip' && followUpText.length > 0) {
    const lastResponse = session.responses[session.responses.length - 1];
    lastResponse.followUp = followUpText;
    
    // Add voice metadata if available
    if (voiceData) {
      lastResponse.voiceMetadata = {
        originalLanguage: voiceData.language,
        originalText: voiceData.originalText,
        translatedText: voiceData.translatedText,
        duration: voiceData.duration,
        wasTranscribed: true
      };
    }
    
    // Update the response in the main responses array
    const mainResponse = responses.find(r => 
      r.phoneNumber === phoneNumber && 
      r.questionId === lastResponse.questionId &&
      r.timestamp.getTime() === lastResponse.timestamp.getTime()
    );
    if (mainResponse) {
      mainResponse.followUp = followUpText;
      if (voiceData) {
        mainResponse.voiceMetadata = lastResponse.voiceMetadata;
      }
    }
  }

  // Move to next question or finish survey
  session.currentQuestion++;
  session.stage = 'survey';
  session.pendingVoiceValidation = null;
  
  if (session.currentQuestion >= survey.questions.length) {
    // Survey complete
    await client.sendMessage(phoneNumber, 
      `🎉 Thank you for completing the survey! 

Your responses have been recorded, including your voice messages. Your feedback is valuable to us! 💙

Have a great day! 😊`
    );
    
    // Update survey stats
    survey.responses++;
    userSessions.delete(phoneNumber);
    
    broadcastSurveyStats();
    broadcastNewResponse();
  } else {
    // Next question
    const progress = Math.round((session.currentQuestion / survey.questions.length) * 100);
    await client.sendMessage(phoneNumber, 
      `✨ Thank you for sharing! 

Progress: ${progress}% complete 📈

---

Let's continue...`
    );
    
    await sendCurrentQuestion(phoneNumber, session, survey);
  }
}

// Real-time broadcasting functions
function broadcastSurveyStats() {
  const stats = surveys.map(survey => ({
    ...survey,
    responses: responses.filter(r => r.surveyId === survey.id).length
  }));
  
  io.emit('survey-stats', stats);
}

function broadcastNewResponse() {
  const recentResponses = responses.slice(-10); // Last 10 responses
  io.emit('new-responses', recentResponses);
}

// API Routes

// Get all surveys
app.get('/api/surveys', (req, res) => {
  const surveysWithStats = surveys.map(survey => ({
    ...survey,
    responses: responses.filter(r => r.surveyId === survey.id).length
  }));
  res.json(surveysWithStats);
});

// Create new survey
app.post('/api/surveys', (req, res) => {
  const survey = createSurvey(req.body);
  res.json(survey);
  broadcastSurveyStats();
});

// Activate survey
app.post('/api/surveys/:id/activate', (req, res) => {
  const survey = activateSurvey(req.params.id);
  if (survey) {
    res.json(survey);
    broadcastSurveyStats();
  } else {
    res.status(404).json({ error: 'Survey not found' });
  }
});

// Get survey responses
app.get('/api/surveys/:id/responses', (req, res) => {
  const surveyResponses = responses.filter(r => r.surveyId === req.params.id);
  res.json(surveyResponses);
});

// Get survey analytics
app.get('/api/surveys/:id/analytics', (req, res) => {
  const surveyResponses = responses.filter(r => r.surveyId === req.params.id);
  const survey = surveys.find(s => s.id === req.params.id);
  
  if (!survey) {
    return res.status(404).json({ error: 'Survey not found' });
  }

  const analytics = {
    totalResponses: surveyResponses.length,
    uniqueParticipants: new Set(surveyResponses.map(r => r.phoneNumber)).size,
    responsesByQuestion: {}
  };

  // Analyze responses by question
  survey.questions.forEach(question => {
    const questionResponses = surveyResponses.filter(r => r.questionId === question.id);
    
    if (question.type === 'curated' || question.type === 'multiple') {
      analytics.responsesByQuestion[question.id] = {
        question: question.question,
        type: question.type,
        responses: questionResponses.reduce((acc, r) => {
          acc[r.answer] = (acc[r.answer] || 0) + 1;
          return acc;
        }, {}),
        followUps: questionResponses.filter(r => r.followUp).map(r => r.followUp)
      };
    } else if (question.type === 'likert') {
      const ratings = questionResponses.map(r => r.answer);
      analytics.responsesByQuestion[question.id] = {
        question: question.question,
        type: question.type,
        average: ratings.reduce((a, b) => a + b, 0) / ratings.length || 0,
        distribution: ratings.reduce((acc, r) => {
          acc[r] = (acc[r] || 0) + 1;
          return acc;
        }, {}),
        followUps: questionResponses.filter(r => r.followUp).map(r => r.followUp)
      };
    }
  });

  res.json(analytics);
});

// WhatsApp status
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    isReady: isClientReady,
    qrCode: qrCodeData
  });
});

// OpenAI configuration status (for admin dashboard)
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

// Test OpenAI connection (for admin dashboard setup)
app.post('/api/openai/test', async (req, res) => {
  if (!isOpenAIConfigured) {
    return res.status(400).json({ 
      success: false, 
      error: 'OpenAI API key not configured',
      message: 'Please set the OPENAI_API_KEY environment variable'
    });
  }

  try {
    // Simple test request to verify API key works
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

// Export survey data
app.get('/api/surveys/:id/export', (req, res) => {
  const surveyResponses = responses.filter(r => r.surveyId === req.params.id);
  const survey = surveys.find(s => s.id === req.params.id);
  
  if (!survey) {
    return res.status(404).json({ error: 'Survey not found' });
  }

  // Convert to CSV format
  const csvData = surveyResponses.map(r => ({
    Survey: survey.title,
    Question: r.questionText,
    Answer: r.answer,
    FollowUp: r.followUp || '',
    PhoneNumber: r.phoneNumber.replace('@c.us', ''),
    Timestamp: r.timestamp.toISOString()
  }));

  res.json(csvData);
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Admin client connected');
  connectedClients.add(socket);
  
  // Send current state to new client
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
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

module.exports = app;
