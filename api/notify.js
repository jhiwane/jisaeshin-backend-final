// Ganti path require sesuai lokasi file botConfig.js kamu
// Jika notify.js dan botConfig.js ada di folder yang sama (folder 'api'), gunakan './botConfig'
// Jika botConfig.js ada di folder luar, gunakan '../botConfig'
const { sendMessage } = require('./botConfig'); 

module.exports = async (req, res) => {
    try {
        const { orderId, total, items, buyerContact, type } = req.body;
        
        // Ambil Chat ID dari Environment Variable (Sama seperti file lain)
        const chatId = process.env.TELEGRAM_CHAT_ID;

        console.log(`[NOTIFY] Laporan Masuk: ${orderId} (${type})`);

        let message = "";
        let keyboard = []; // Penampung Tombol
        const fmtTotal = parseInt(total).toLocaleString('id-ID');

        // --- DETEKSI APAKAH PERLU INPUT MANUAL? ---
        // (Jika beli otomatis tapi stok habis, item.data akan kosong)
        let needsManualInput = false;
        if (items && Array.isArray(items)) {
            needsManualInput = items.some(i => !i.data || i.data.length === 0);
        }

        // ====================================================
        // KASUS 1: PEMBAYARAN SUKSES (AUTO / SALDO)
        // ====================================================
        if (type === 'auto' || type === 'saldo') {
            const statusIcon = needsManualInput ? "⚠️" : "✅";
            const typeLabel = type.toUpperCase();

            // FORMAT HTML (PENTING! JANGAN PAKAI BINTANG *)
            message = `<b>${statusIcon} PEMBAYARAN LUNAS (${typeLabel})</b>\n`;
            message += `🆔 ID: <code>${orderId}</code>\n`;
            message += `💰 Omzet: Rp ${fmtTotal}\n`;
            message += `👤 Pembeli: ${buyerContact}\n`;
            message += `--------------------------------\n`;

            if (items && Array.isArray(items)) {
                items.forEach((item, index) => {
                    message += `📦 <b>${item.name}</b> (x${item.qty})\n`;
                    
                    // JIKA ADA DATA (STOK TERKIRIM OTOMATIS)
                    if (item.data && Array.isArray(item.data) && item.data.length > 0) {
                        message += `   ✨ <i>Terkirim Otomatis:</i>\n`;
                        item.data.forEach(d => message += `   <code>${d}</code>\n`);
                    } 
                    // JIKA DATA KOSONG (STOK HABIS/MANUAL)
                    else {
                        message += `   ❌ <b>DATA KOSONG (Wajib Input)</b>\n`;
                    }
                });
            }

            // --- LOGIKA SETAN: JIKA KOSONG, KASIH TOMBOL INPUT ---
            if (needsManualInput) {
                message += `\n👇 <b>SILAKAN INPUT DATA DI BAWAH:</b>`;
                
                // Loop untuk bikin tombol per item yang kosong
                items.forEach((item, i) => {
                    const isFilled = (item.data && item.data.length > 0);
                    if (!isFilled) {
                        keyboard.push([{ 
                            text: `✏️ ISI: ${item.name.substring(0, 15)}...`, 
                            callback_data: `FILL_${orderId}_${i}` // Trigger logic di telegram-webhook.js
                        }]);
                    }
                });
                
                // Tombol Selesai
                keyboard.push([{ text: "🚀 SELESAI & UPDATE WEB", callback_data: `DONE_${orderId}` }]);
            }
        } 
        
        // ====================================================
        // KASUS 2: MANUAL TRANSFER (BUTUH ACC)
        // ====================================================
        else if (type === 'manual') {
            message = `⚠️ <b>KONFIRMASI MANUAL BARU</b>\n`;
            message += `🆔 ID: <code>${orderId}</code>\n`;
            message += `💰 Total: Rp ${fmtTotal}\n`;
            message += `👤 Pembeli: ${buyerContact}\n\n`;
            message += `User mengaku sudah transfer. Cek mutasi!`;

            keyboard = [
                [{ text: "✅ ACC PESANAN", callback_data: `ACC_${orderId}` }],
                [{ text: "⛔ TOLAK", callback_data: `REJECT_${orderId}` }]
            ];
        }
        
        // ====================================================
        // KASUS 3: KOMPLAIN
        // ====================================================
        else if (type === 'complaint') {
             message = `🆘 <b>KOMPLAIN USER</b>\n`;
             message += `🆔 <code>${orderId}</code>\n`;
             message += `💬 "${req.body.message}"\n`;
             message += `👤 ${buyerContact}`;
             
             keyboard = [[{ text: "💬 BALAS PESAN", callback_data: `REPLY_COMPLAINT_${orderId}` }]];
        }

        // KIRIM KE BOT (PASTI JALAN KARENA PAKAI botConfig)
        if (message) {
            const options = keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {};
            await sendMessage(chatId, message, options);
            console.log("Notif Telegram Terkirim via botConfig!");
        }

        res.status(200).json({ status: 'OK' });

    } catch (error) {
        console.error("Notify Error:", error);
        res.status(200).json({ status: 'Error handled' });
    }
};
