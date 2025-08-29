// index.js
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();

// Environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => Number(id));

// Create a bot instance
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Store conversation history for each user
const userConversations = {};
// Bot stats
const botStats = {
  totalMessages: 0,
  activeUsers: new Set(),
  startTime: new Date()
};

// Personality system message
const personalityPrompt = {
  role: "system",
  content: `You are a helpful, intelligent assistant with a human-like personality. 
  Communicate naturally but professionally without using emojis.
  You can use Telegram's markdown formatting when appropriate:
  - *bold text* for emphasis
  - _italic text_ for subtle points
  - \`code\` for technical terms
  - \`\`\`code blocks\`\`\` for longer code
  When organizing information, use clear headings with *CAPITALIZED TITLES*
  Always be concise but thorough, and speak with a touch of warmth.`
};

// Bot start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  botStats.activeUsers.add(userId);
  
  bot.sendMessage(chatId, 'Hello! I am your aris ur uncesored assistant with no filters. I can help answer questions, summarize text, and more.', {
    parse_mode: 'Markdown'
  });
});

// Summarize command
bot.onText(/\/summarize (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const textToSummarize = match[1];
  
  if (!textToSummarize || textToSummarize.length < 50) {
    return bot.sendMessage(chatId, 'Please provide a longer text to summarize (at least 50 characters).');
  }
  
  bot.sendChatAction(chatId, 'typing');
  
  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      messages: [
        personalityPrompt,
        {
          role: 'user',
          content: `Summarize this text concisely: ${textToSummarize}`
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://your-app-name.railway.app',
        'X-Title': 'Telegram AI Bot',
        'Content-Type': 'application/json'
      }
    });
    
    const summary = response.data.choices[0].message.content;
    
    bot.sendMessage(chatId, `*SUMMARY*\n\n${summary}`, {
      parse_mode: 'Markdown'
    });
    
  } catch (error) {
    console.error('Error calling OpenRouter API:', error.response?.data || error.message);
    bot.sendMessage(chatId, 'Sorry, I encountered an error while summarizing.');
  }
});

// Admin stats command
bot.onText(/\/stats/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check if user is admin
  if (!ADMIN_IDS.includes(userId)) {
    return bot.sendMessage(chatId, 'You are not authorized to use this command.');
  }
  
  const uptime = Math.floor((new Date() - botStats.startTime) / 1000 / 60); // in minutes
  const statsMessage = `*BOT STATE*\n\n` + 
    `*Active Users:* ${botStats.activeUsers.size}\n` +
    `*Total Messages Processed:* ${botStats.totalMessages}\n` +
    `*Uptime:* ${uptime} minutes\n` +
    `*Memory Usage:* ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB\n` +
    `*Active Conversations:* ${Object.keys(userConversations).length}`;
  
  bot.sendMessage(chatId, statsMessage, {
    parse_mode: 'Markdown'
  });
});

// Clear conversation command
bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  
  if (userConversations[chatId]) {
    // Keep only the personality prompt
    userConversations[chatId] = [personalityPrompt];
    bot.sendMessage(chatId, 'Your conversation history has been cleared.');
  } else {
    bot.sendMessage(chatId, 'No conversation history to clear.');
  }
});

// Handle all text messages
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userMessage = msg.text;
  
  // Update stats
  botStats.totalMessages++;
  botStats.activeUsers.add(userId);
  
  // Initialize conversation for new users
  if (!userConversations[chatId]) {
    userConversations[chatId] = [personalityPrompt];
  }
  
  // Add user message to history
  userConversations[chatId].push({
    role: 'user',
    content: userMessage
  });
  
  // Send "typing" action
  bot.sendChatAction(chatId, 'typing');
  
  try {
    // Call OpenRouter API
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      messages: userConversations[chatId]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://your-app-name.railway.app',
        'X-Title': 'Telegram AI Bot',
        'Content-Type': 'application/json'
      }
    });
    
    const aiResponse = response.data.choices[0].message.content;
    
    // Add AI response to conversation history
    userConversations[chatId].push({
      role: 'assistant',
      content: aiResponse
    });
    
    // Keep conversation history at a reasonable size
    if (userConversations[chatId].length > 20) {
      // Keep system prompt and last 10 exchanges
      userConversations[chatId] = [
        personalityPrompt,
        ...userConversations[chatId].slice(-19)
      ];
    }
    
    // Send response to user with markdown
    bot.sendMessage(chatId, aiResponse, {
      parse_mode: 'Markdown'
    });
    
  } catch (error) {
    console.error('Error calling OpenRouter API:', error.response?.data || error.message);
    bot.sendMessage(chatId, 'Sorry, I encountered an error. Please try again later.');
  }
});

// Start the bot
console.log('Bot is running...');

