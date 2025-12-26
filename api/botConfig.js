const fetch = require('node-fetch');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

const sendMessage = async (chatId, text, options = {}) => {
    try {
        await fetch(`${BASE_URL}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...options })
        });
    } catch (e) {
        console.error("Telegram Send Error:", e);
    }
};

module.exports = { sendMessage, BOT_TOKEN };
