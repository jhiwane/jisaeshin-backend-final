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
        const { orderId, total, items, buyerContact, type } = req.body;
        
        console.log(`[NOTIFY] New Report: ${orderId} (${type})`);

        // --- SUSUN PESAN TELEGRAM ---
        let message = "";
        const date = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const fmtTotal = parseInt(total).toLocaleString('id-ID');

        // KASUS 1: AUTO / SALDO (LUNAS & DIKIRIM)
        if (type === 'auto' || type === 'saldo') {
            message = `✅ *PEMBAYARAN LUNAS (${type.toUpperCase()})*\n`;
            message += `--------------------------------\n`;
            message += `🆔 *ID:* \`${orderId}\`\n`;
            message += `📅 *Waktu:* ${date}\n`;
            message += `💰 *Omzet:* Rp ${fmtTotal}\n`;
            message += `📞 *Pembeli:* ${buyerContact}\n`;
            message += `--------------------------------\n`;
            message += `📦 *DETAIL ITEM & KONTEN:*\n`;

            // Loop semua item untuk menampilkan KONTEN/AKUN
            if (items && Array.isArray(items)) {
                items.forEach((item, index) => {
                    message += `\n${index + 1}. *${item.name}* (x${item.qty})\n`;
                    
                    // Cek apakah Frontend mengirim data akun (dari stok otomatis)
                    if (item.data && item.data.length > 0) {
                        message += `   ✨ *DATA TERKIRIM:* \n`;
                        item.data.forEach(d => message += `   ▫️ \`${d}\`\n`);
                    } else if (item.isManual) {
                        message += `   ⚠️ *BUTUH PROSES MANUAL* (Cek DB)\n`;
                    } else {
                        message += `   ℹ️ _Stok terpotong otomatis_\n`;
                    }
                });
            }
        } 
        
        // KASUS 2: MANUAL TRANSFER (BUTUH CEK)
        else if (type === 'manual') {
            message = `⚠️ *KONFIRMASI MANUAL BARU*\n`;
            message += `--------------------------------\n`;
            message += `🆔 *ID:* \`${orderId}\`\n`;
            message += `💰 *Total:* Rp ${fmtTotal}\n`;
            message += `📞 *Pembeli:* ${buyerContact}\n`;
            message += `--------------------------------\n`;
            message += `User mengaku sudah transfer. Segera cek mutasi bank!`;
        }
        
        // KASUS 3: KOMPLAIN
        else if (type === 'complaint') {
             message = `🆘 *USER KOMPLAIN*\n🆔 ${orderId}\n💬 "${req.body.message}"\n📞 ${buyerContact}`;
        }

        // Kirim Pesan
        if (message) await sendTelegramMessage(message);

        // Respon ke Frontend (Biar gak timeout)
        res.status(200).json({ status: 'OK', target: 'Telegram' });

    } catch (error) {
        console.error("Notify Handler Error:", error);
        res.status(200).json({ status: 'Error handled' });
    }
};
