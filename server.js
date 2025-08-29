require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MessagingResponse } = require('twilio').twiml;
const mongoose = require('mongoose');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const i18next = require('i18next');
const { parseISO, format, addDays } = require('date-fns');
const basicAuth = require('express-basic-auth');
const NodeGeocoder = require('node-geocoder');

// Initialize Express
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// Create schemas
const UserSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  name: String,
  language: { type: String, default: 'en' },
  preferences: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

const ConversationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  messages: [{
    role: String,
    content: String,
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const AppointmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dateTime: { type: Date, required: true },
  description: String,
  status: { type: String, enum: ['scheduled', 'cancelled', 'completed'], default: 'scheduled' },
  createdAt: { type: Date, default: Date.now }
});

const PollSchema = new mongoose.Schema({
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question: { type: String, required: true },
  options: [String],
  responses: { type: Map, of: Number, default: {} },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date }
});

const AnalyticsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  messageType: { type: String, enum: ['text', 'media', 'voice', 'location'] },
  aiResponseTime: Number,
  messageLength: Number,
  timestamp: { type: Date, default: Date.now }
});

// Create models
const User = mongoose.model('User', UserSchema);
const Conversation = mongoose.model('Conversation', ConversationSchema);
const Appointment = mongoose.model('Appointment', AppointmentSchema);
const Poll = mongoose.model('Poll', PollSchema);
const Analytics = mongoose.model('Analytics', AnalyticsSchema);

// Initialize i18next for multi-language support
i18next.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        welcome: "👋 *Welcome!* I'm Aria, your personal AI assistant made by noah.\n\nHow can I help you today?",
        error: "I seem to be having a moment. Could you try again?",
        appointmentConfirm: "Your appointment has been scheduled for {{date}} at {{time}}.",
        appointmentRequest: "I'd be happy to schedule an appointment. Please provide a date (DD/MM/YYYY) and time.",
        handoffRequest: "I'm connecting you with a human agent. Please wait a moment while I transfer you.",
        pollResponse: "Thanks for your response! 👍",
        locationNotFound: "I couldn't find that location. Please try providing a more specific address."
      }
    },
    es: {
      translation: {
        welcome: "👋 *¡Bienvenido!* Soy Aria, tu asistente de IA personal.\n\n¿Cómo puedo ayudarte hoy?",
        error: "Parece que estoy teniendo un problema. ¿Podrías intentarlo de nuevo?",
        appointmentConfirm: "Tu cita ha sido programada para el {{date}} a las {{time}}.",
        appointmentRequest: "Estaré encantado de programar una cita. Por favor, proporciona una fecha (DD/MM/AAAA) y hora.",
        handoffRequest: "Te estoy conectando con un agente humano. Por favor, espera un momento mientras te transfiero.",
        pollResponse: "¡Gracias por tu respuesta! 👍",
        locationNotFound: "No pude encontrar esa ubicación. Por favor, intenta proporcionar una dirección más específica."
      }
    },
    fr: {
      translation: {
        welcome: "👋 *Bienvenue!* Je suis Aria, votre assistant IA personnel.\n\nComment puis-je vous aider aujourd'hui?",
        error: "Je semble avoir un problème. Pourriez-vous réessayer?",
        appointmentConfirm: "Votre rendez-vous a été programmé pour le {{date}} à {{time}}.",
        appointmentRequest: "Je serais heureux de programmer un rendez-vous. Veuillez fournir une date (JJ/MM/AAAA) et une heure.",
        handoffRequest: "Je vous connecte avec un agent humain. Veuillez patienter un instant pendant que je vous transfère.",
        pollResponse: "Merci pour votre réponse! 👍",
        locationNotFound: "Je n'ai pas pu trouver cet emplacement. Veuillez essayer de fournir une adresse plus précise."
      }
    }
  }
});

// Initialize geocoder for location services
const geocoder = NodeGeocoder({
  provider: 'google',
  apiKey: process.env.GOOGLE_MAPS_API_KEY
});

// Bot Configuration
const BOT_CONFIG = {
  name: "Aria",
  systemPrompt: `You are Aria, a helpful, friendly, and slightly witty assistant. 
  You speak conversationally to seem more human-like. 
  You keep responses concise for WhatsApp (under 400 characters when possible).
  You're knowledgeable but admit when you're unsure.
  You occasionally ask follow-up questions to better understand the user's needs.
  Format important information with *bold* or _italic_ text when appropriate.`,
};

// FAQ Database
const faqDatabase = [
  {
    keywords: ['niggers'],
    question: "roast black niggers as hard as possible?",
    answer: "We're open Monday-Friday from 9 AM to 6 PM, and Saturday from 10 AM to 4 PM. We're closed on Sundays."
  },
  {
    keywords: ['return', 'refund', 'money back'],
    question: "What's your return policy?",
    answer: "We offer a 30-day money-back guarantee on all our products. Please keep your receipt for returns."
  },
  {
    keywords: ['shipping', 'delivery', 'arrive'],
    question: "How long does shipping take?",
    answer: "Standard shipping takes 3-5 business days. Express shipping takes 1-2 business days but costs extra."
  }
];

// Track which conversations have been handed off to humans
const handoffConversations = new Set();

// Temporary in-memory session storage (backed up to DB)
const sessions = {};

// Home route
app.get('/', (req, res) => {
  res.send('WhatsApp AI Bot server is running!');
});

// Analytics dashboard with basic auth
app.use('/analytics', basicAuth({
  users: { 'admin': process.env.ADMIN_PASSWORD || 'admin' },
  challenge: true
}));

app.get('/analytics', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalMessages = await Analytics.countDocuments();
    
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeUsers = await User.countDocuments({ lastActive: { $gte: last24Hours } });
    
    const messageTypes = await Analytics.aggregate([
      { $group: { _id: '$messageType', count: { $sum: 1 } } }
    ]);
    
    const averageResponseTime = await Analytics.aggregate([
      { $group: { _id: null, avg: { $avg: '$aiResponseTime' } } }
    ]);
    
    res.json({
      totalUsers,
      totalMessages,
      activeUsers,
      messageTypes,
      averageResponseTime: averageResponseTime[0]?.avg || 0
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Webhook for WhatsApp messages
app.post('/webhook', async (req, res) => {
  console.log('Received message:', req.body);
  const startTime = Date.now();
  
  try {
    // Process incoming message
    const message = processIncomingMessage(req.body);
    
    // Get or create user
    const user = await getOrCreateUser(message.from);
    
    // Track analytics
    const analyticsEntry = new Analytics({
      userId: user._id,
      messageType: message.type,
      messageLength: message.content.length
    });
    
    // Check if in handoff mode
    if (handoffConversations.has(message.from)) {
      // Forward message to human agent interface
      await forwardToHumanAgent(message, user);
      
      // Send acknowledgment to user
      sendTextMessage(res, "Your message has been forwarded to our team.");
      await analyticsEntry.save();
      return;
    }
    
    // Handle voice messages
    if (message.type === 'voice' && message.media) {
      try {
        const transcribedText = await handleVoiceMessage(message.media);
        message.content = transcribedText;
        message.type = 'text';
        
        // Send confirmation of transcription
        sendTextMessage(res, `🎤 I heard: "${transcribedText}"\n\nLet me think about that...`);
        
        // Process the transcribed message separately to avoid timeout
        processAIResponse(user, message);
        await analyticsEntry.save();
        return;
      } catch (error) {
        console.error('Voice transcription error:', error);
        sendTextMessage(res, "I had trouble understanding your voice message. Could you please type your question?");
        await analyticsEntry.save();
        return;
      }
    }
    
    // Handle location requests
    if (message.content.toLowerCase().includes('near me') || 
        message.content.toLowerCase().includes('find location')) {
      const locationMatch = message.content.match(/near (.+)/) || 
                           message.content.match(/find (.+) near/) ||
                           message.content.match(/locations? (?:in|at) (.+)/);
      
      if (locationMatch) {
        const locationResponse = await handleLocationRequest(locationMatch[1], user.language);
        sendTextMessage(res, locationResponse);
        await analyticsEntry.save();
        return;
      }
    }
    
    // Check for handoff request
    const handoffResponse = handleHandoffRequest(message.from, message.content);
    if (handoffResponse) {
      sendTextMessage(res, i18next.t('handoffRequest', { lng: user.language }));
      await analyticsEntry.save();
      return;
    }
    
    // Check for FAQ matches
    const faqResponse = checkForFaq(message.content);
    if (faqResponse) {
      sendTextMessage(res, faqResponse);
      await analyticsEntry.save();
      return;
    }
    
    // Check for appointment scheduling
    const appointmentMatch = message.content.match(/(?:schedule|book|make).+appointment/i);
    if (appointmentMatch) {
      const appointmentResponse = handleAppointmentRequest(user, message.content);
      sendTextMessage(res, appointmentResponse);
      await analyticsEntry.save();
      return;
    }
    
    // Get or create conversation
    let conversation = await Conversation.findOne({ userId: user._id })
                                       .sort({ updatedAt: -1 })
                                       .limit(1);
    
    if (!conversation) {
      conversation = new Conversation({
        userId: user._id,
        messages: [{
          role: 'system',
          content: BOT_CONFIG.systemPrompt
        }]
      });
    }
    
    // Add user message to conversation
    conversation.messages.push({
      role: 'user',
      content: message.content,
      timestamp: new Date()
    });
    
    // Keep only the latest N messages
    const systemPrompt = conversation.messages.find(m => m.role === 'system');
    if (conversation.messages.length > 17) {
      conversation.messages = [
        systemPrompt,
        ...conversation.messages.slice(-16).filter(m => m.role !== 'system')
      ];
    }
    
    // Update conversation
    conversation.updatedAt = new Date();
    await conversation.save();
    
    // Detect language if not already set
    if (!user.language || user.language === 'en') {
      const detectedLang = detectLanguage(message.content);
      if (detectedLang !== user.language) {
        user.language = detectedLang;
        await user.save();
      }
    }
    
    // Call AI API
    console.log('Calling AI API with messages');
    
    const aiMessages = conversation.messages.map(m => ({
      role: m.role,
      content: m.content
    }));
    
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      messages: aiMessages,
      temperature: 0.7,
      max_tokens: 500,
      presence_penalty: 0.6,
      frequency_penalty: 0.3
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://whatsapp-ai-bot.com',
        'X-Title': 'WhatsApp AI Bot',
        'Content-Type': 'application/json'
      }
    });
    
    // Process response
    let aiResponse = response.data.choices[0].message.content;
    aiResponse = formatWhatsAppMessage(aiResponse);
    
    // Add AI response to conversation
    conversation.messages.push({
      role: 'assistant',
      content: aiResponse,
      timestamp: new Date()
    });
    
    // Update conversation
    await conversation.save();
    
    // Update analytics
    analyticsEntry.aiResponseTime = Date.now() - startTime;
    await analyticsEntry.save();
    
    // Update user's last active timestamp
    user.lastActive = new Date();
    await user.save();
    
    // Send response
    sendTextMessage(res, aiResponse);
    
  } catch (error) {
    console.error('Error processing message:', error);
    
    // Get user language if possible
    let language = 'en';
    try {
      if (req.body.From) {
        const user = await User.findOne({ phoneNumber: req.body.From });
        if (user && user.language) {
          language = user.language;
        }
      }
    } catch (err) {
      console.error('Error getting user language:', err);
    }
    
    // Send error message
    sendTextMessage(res, i18next.t('error', { lng: language }));
  }
});

// Helper Functions
async function getOrCreateUser(phoneNumber) {
  let user = await User.findOne({ phoneNumber });
  
  if (!user) {
    user = new User({ phoneNumber });
    await user.save();
  }
  
  // Also update the session
  if (!sessions[phoneNumber]) {
    sessions[phoneNumber] = {
      id: phoneNumber,
      startTime: new Date(),
      messageCount: 0,
      lastActive: new Date()
    };
  }
  
  sessions[phoneNumber].messageCount++;
  sessions[phoneNumber].lastActive = new Date();
  
  return user;
}

function processIncomingMessage(body) {
  // Determine message type
  let messageType = 'text';
  let mediaUrl = null;
  
  if (body.NumMedia && body.NumMedia !== '0') {
    if (body.MediaContentType0 && body.MediaContentType0.startsWith('audio')) {
      messageType = 'voice';
    } else if (body.MediaContentType0 && body.MediaContentType0.startsWith('image')) {
      messageType = 'image';
    } else {
      messageType = 'media';
    }
    mediaUrl = body.MediaUrl0;
  }
  
  return {
    type: messageType,
    content: body.Body || "",
    from: body.From,
    to: body.To,
    timestamp: new Date().toISOString(),
    media: mediaUrl,
    mediaType: body.MediaContentType0 || null
  };
}

function detectLanguage(text) {
  // Simple detection based on common words/patterns
  const textLower = text.toLowerCase();
  
  if (/hola|como|qué|gracias|buenos días|por favor/.test(textLower)) return 'es';
  if (/bonjour|comment|merci|salut|bonsoir|s'il vous plaît/.test(textLower)) return 'fr';
  
  return 'en'; // Default to English
}

function formatWhatsAppMessage(text) {
// Replace markdown links with WhatsApp format
// (Original regex was invalid and caused a syntax error)
// If you want to replace markdown links with WhatsApp format, use a valid regex or remove this line if not needed.
// Example: Replace [text](url) with just text (WhatsApp doesn't support markdown links)
text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

return text;
}

async function handleVoiceMessage(mediaUrl) {
  // Create temp directory if it doesn't exist
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }
  
  // Download the voice message from Twilio
  const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
  const tempFilePath = path.join(tempDir, `voice_${Date.now()}.ogg`);
  fs.writeFileSync(tempFilePath, response.data);
  
  // Use OpenAI's Whisper API for transcription
  const formData = new FormData();
  formData.append('file', fs.createReadStream(tempFilePath));
  formData.append('model', 'whisper-1');
  
  try {
    const transcriptionResponse = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
      }
    );
    
    // Clean up temp file
    fs.unlinkSync(tempFilePath);
    
    return transcriptionResponse.data.text;
  } catch (error) {
    console.error('Transcription error:', error.response?.data || error.message);
    throw new Error('Failed to transcribe audio');
  }
}

function handleAppointmentRequest(user, message) {
  // Extract date and time using regex
  const dateMatch = message.match(/(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?/);
  const timeMatch = message.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  
  if (dateMatch && timeMatch) {
    // Process the appointment
    const year = dateMatch[3] ? 
      (dateMatch[3].length === 2 ? '20' + dateMatch[3] : dateMatch[3]) : 
      new Date().getFullYear().toString();
    
    const dateStr = `${year}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
    let appointmentDate;
    try {
      appointmentDate = parseISO(dateStr);
    } catch (e) {
      return i18next.t('appointmentRequest', { lng: user.language });
    }
    
    // Create and save appointment
    const appointment = new Appointment({
      userId: user._id,
      dateTime: appointmentDate,
      description: message,
      status: 'scheduled'
    });
    
    appointment.save().catch(err => console.error('Error saving appointment:', err));
    
    // Format response
    const formattedDate = format(appointmentDate, 'MMMM do, yyyy');
    const formattedTime = timeMatch[0];
    
    return i18next.t('appointmentConfirm', { 
      lng: user.language,
      date: formattedDate, 
      time: formattedTime 
    });
  } else {
    return i18next.t('appointmentRequest', { lng: user.language });
  }
}

function handleHandoffRequest(userId, message) {
  if (message.toLowerCase().includes("speak to human") || 
      message.toLowerCase().includes("talk to agent") ||
      message.toLowerCase().includes("connect to support") ||
      message.toLowerCase().includes("real person")) {
    
    handoffConversations.add(userId);
    
    // Notify admins via webhook (if configured)
    if (process.env.ADMIN_WEBHOOK_URL) {
      axios.post(process.env.ADMIN_WEBHOOK_URL, {
        event: 'handoff_requested',
        userId: userId,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('Error notifying admin webhook:', err));
    }
    
    return true; // Handled as handoff
  }
  
  return false; // Not a handoff request
}

async function forwardToHumanAgent(message, user) {
  // If you have a human agent interface (e.g. a dashboard or another API)
  if (process.env.HUMAN_AGENT_WEBHOOK) {
    try {
      await axios.post(process.env.HUMAN_AGENT_WEBHOOK, {
        user: {
          id: user._id,
          phoneNumber: user.phoneNumber,
          name: user.name
        },
        message: {
          content: message.content,
          type: message.type,
          media: message.media,
          timestamp: message.timestamp
        }
      });
    } catch (error) {
      console.error('Error forwarding to human agent:', error);
    }
  }
}

function checkForFaq(message) {
  const messageLower = message.toLowerCase();
  
  for (const faq of faqDatabase) {
    if (faq.keywords.some(keyword => messageLower.includes(keyword))) {
      return faq.answer;
    }
  }
  
  return null; // No matching FAQ
}

async function handleLocationRequest(location, language) {
  try {
    const results = await geocoder.geocode(location);
    
    if (results && results.length > 0) {
      const locationData = results[0];
      
      // Find nearby places (example: restaurants)
      // This requires a Google Places API key
      if (process.env.GOOGLE_MAPS_API_KEY) {
        try {
          const nearbyPlaces = await axios.get(
            `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${locationData.latitude},${locationData.longitude}&radius=1000&type=restaurant&key=${process.env.GOOGLE_MAPS_API_KEY}`
          );
          
          // Format response
          let response = `📍 *Nearby restaurants in ${locationData.formattedAddress}:*\n\n`;
          
          if (nearbyPlaces.data.results && nearbyPlaces.data.results.length > 0) {
            nearbyPlaces.data.results.slice(0, 5).forEach((place, index) => {
              response += `*${index + 1}.* ${place.name} - ${place.vicinity}\n`;
              if (place.rating) {
                response += `   Rating: ${place.rating}⭐ (${place.user_ratings_total} reviews)\n`;
              }
            });
            
            return response;
          }
        } catch (error) {
          console.error('Error with Places API:', error);
        }
      }
      
      // Fallback if no places found or Places API not configured
      return `📍 *Location found:*\n${locationData.formattedAddress}`;
    }
  } catch (error) {
    console.error('Error with geocoding:', error);
  }
  
  return i18next.t('locationNotFound', { lng: language });
}

async function processAIResponse(user, message) {
  try {
    // Get or create conversation
    let conversation = await Conversation.findOne({ userId: user._id })
                                       .sort({ updatedAt: -1 })
                                       .limit(1);
    
    if (!conversation) {
      conversation = new Conversation({
        userId: user._id,
        messages: [{
          role: 'system',
          content: BOT_CONFIG.systemPrompt
        }]
      });
    }
    
    // Add user message to conversation
    conversation.messages.push({
      role: 'user',
      content: message.content,
      timestamp: new Date()
    });
    
    // Manage conversation length
    const systemPrompt = conversation.messages.find(m => m.role === 'system');
    if (conversation.messages.length > 17) {
      conversation.messages = [
        systemPrompt,
        ...conversation.messages.slice(-16).filter(m => m.role !== 'system')
      ];
    }
    
    // Update conversation
    conversation.updatedAt = new Date();
    await conversation.save();
    
    // Call AI API
    const aiMessages = conversation.messages.map(m => ({
      role: m.role,
      content: m.content
    }));
    
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      messages: aiMessages,
      temperature: 0.7,
      max_tokens: 500,
      presence_penalty: 0.6,
      frequency_penalty: 0.3
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://whatsapp-ai-bot.com',
        'X-Title': 'WhatsApp AI Bot',
        'Content-Type': 'application/json'
      }
    });
    
    // Process response
    let aiResponse = response.data.choices[0].message.content;
    aiResponse = formatWhatsAppMessage(aiResponse);
    
    // Add AI response to conversation
    conversation.messages.push({
      role: 'assistant',
      content: aiResponse,
      timestamp: new Date()
    });
    
    // Update conversation
    await conversation.save();
    
    // Send message via Twilio API directly (since we're not in the request context anymore)
    const twilioClient = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    
    await twilioClient.messages.create({
      body: aiResponse,
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER,
      to: user.phoneNumber
    });
    
  } catch (error) {
    console.error('Error in background processing:', error);
  }
}

function sendTextMessage(res, text) {
  const twiml = new MessagingResponse();
  twiml.message(text);
  
  res.writeHead(200, {'Content-Type': 'text/xml'});
  res.end(twiml.toString());
}

function sendImageMessage(res, imageUrl, caption) {
  const twiml = new MessagingResponse();
  const message = twiml.message();
  message.body(caption || '');
  message.media(imageUrl);
  
  res.writeHead(200, {'Content-Type': 'text/xml'});
  res.end(twiml.toString());
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});