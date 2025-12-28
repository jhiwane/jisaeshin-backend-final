const axios = require('axios');

// Fungsi Helper Kirim Telegram
const sendTelegramMessage = async (message) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) return console.error("TELEGRAM CONFIG MISSING");

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log("Telegram Sent!");
    } catch (error) {
        console.error("Telegram Fail:", error.message);
    }
};

// Handler Utama
module.exports = async (req, res) => {
    try {
        // Kita terima data 'items' yang sudah berisi array 'data' (konten) dari Frontend
        const { orderId, total, items, buyerContact, type } = req.body;
        
        console.log(`[NOTIFY] Report Masuk: ${orderId} (${type})`);

        // --- FORMAT PESAN TELEGRAM ---
        let message = "";
        const date = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const fmtTotal = parseInt(total).toLocaleString('id-ID');

        // KASUS 1: SUKSES (AUTO / SALDO)
        if (type === 'auto' || type === 'saldo') {
            message = `✅ *ORDER SELESAI (${type.toUpperCase()})*\n`;
            message += `--------------------------------\n`;
            message += `🆔 *ID:* \`${orderId}\`\n`;
            message += `📅 *Waktu:* ${date}\n`;
            message += `💰 *Total:* Rp ${fmtTotal}\n`;
            message += `👤 *Pembeli:* ${buyerContact}\n`;
            message += `--------------------------------\n`;
            message += `📦 *DETAIL KONTEN TERKIRIM:*\n`;

            if (items && Array.isArray(items)) {
                items.forEach((item, index) => {
                    message += `\n${index + 1}. *${item.name}* (x${item.qty})\n`;
                    
                    // Frontend sudah mengirim 'data' di sini, kita tinggal tampilkan
                    if (item.data && Array.isArray(item.data) && item.data.length > 0) {
                        message += `   ✨ *KONTEN:* \n`;
                        item.data.forEach(d => message += `   ▫️ \`${d}\`\n`);
                    } else if (item.isManual) {
                        message += `   ⚠️ *PROSES MANUAL (Joki/Topup)*\n`;
                    } else {
                        message += `   ℹ️ _Stok Terpotong (Tanpa data teks)_\n`;
                    }
                });
            }
        } 
        
        // KASUS 2: MANUAL TRANSFER
        else if (type === 'manual') {
            message = `⚠️ *KONFIRMASI MANUAL BARU*\n`;
            message += `🆔 *ID:* \`${orderId}\`\n`;
            message += `💰 *Total:* Rp ${fmtTotal}\n`;
            message += `👤 *Pembeli:* ${buyerContact}\n\n`;
            message += `User mengaku sudah transfer. Cek mutasi dan ACC di Admin Panel!`;
        }
        
        // KASUS 3: KOMPLAIN
        else if (type === 'complaint') {
             message = `🆘 *KOMPLAIN USER*\n🆔 ${orderId}\n💬 "${req.body.message}"\n👤 ${buyerContact}`;
        }

        if (message) await sendTelegramMessage(message);

        res.status(200).json({ status: 'OK' });

    } catch (error) {
        console.error("Notify Error:", error.message);
        res.status(200).json({ status: 'Error handled' });
    }
};
