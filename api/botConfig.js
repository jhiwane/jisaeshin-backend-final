const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Fungsi kirim pesan dengan opsi tambahan (untuk tombol)
const sendMessage = async (chatId, text, options = {}) => {
    if (!BOT_TOKEN || !chatId) {
        console.error("TELEGRAM ERROR: Cek .env (Token/ChatID kurang)");
        return;
    }

    try {
        await axios.post(`${BASE_URL}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            ...options // Ini penting agar tombol bisa muncul
        });
    } catch (e) {
        console.error("Telegram Send Error:", e.response ? e.response.data : e.message);
    }
};

module.exports = { sendMessage };
