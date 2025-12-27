const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

// IMPORT HANDLER BARU KITA
const { handleSaldoPayment } = require('./saldoHandler');

const ADMIN_CHAT_ID = '1383656187'; 

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        // ==========================================
        // KASUS 1: PEMBAYARAN SALDO (VIA HANDLER KHUSUS)
        // ==========================================
        if (type === 'saldo') {
            // Lempar tugas ke file sebelah (saldoHandler.js)
            // Kita tidak pakai 'await' agar frontend React tidak loading lama (Async process)
            handleSaldoPayment(orderId, total, buyerContact, items);
            return res.status(200).json({ status: 'processing_saldo' });
        }

        // ==========================================
        // KASUS 2: AUTO ORDER (MIDTRANS)
        // ==========================================
        else if (type === 'auto') {
            // Logic Midtrans biarkan disini atau mau dipisah juga boleh, 
            // tapi sementara biarkan sesuai yang lama agar aman.
            
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => {
                    const note = i.note ? `\n   📝 <i>Input: ${i.note}</i>` : '';
                    itemsDetail += `📦 <b>${i.name}</b>\n   Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}\n`;
                });
            }

            const msg = `⚡️ <b>PESANAN OTOMATIS (MIDTRANS)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                        `👤 User: ${buyerContact || 'Guest'}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Sistem sedang memproses stok...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);
            
            const result = await processOrderStock(orderId);
            
            if (result.success) {
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");
            } else {
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK GAGAL/KOSONG (MIDTRANS)</b>\n${result.logs.join('\n')}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        } 
        
        // ==========================================
        // KASUS 3: KOMPLAIN
        // ==========================================
        else if (type === 'complaint') {
            const text = `⚠️ <b>LAPORAN MASALAH (KOMPLAIN)</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `👤 User: ${buyerContact || 'Guest'}\n` +
                         `💬 Pesan: "${message}"\n\n` +
                         `👇 <i>Klik tombol di bawah untuk membalas:</i>`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: { inline_keyboard: [[{ text: "🗣 BALAS KE USER", callback_data: `REPLY_COMPLAINT_${orderId}` }]] }
            });
        }
        
        // ==========================================
        // KASUS 4: MANUAL TRANSFER
        // ==========================================
        else if (type === 'manual') {
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => { itemsDetail += `- ${i.name} x${i.qty} ${(i.note ? `(${i.note})` : '')}\n`; });
            }
            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                         `👤 User: ${buyerContact}\n\n` +
                         `🛒 <b>Items:</b>\n${itemsDetail}\n` +
                         `👇 <b>TINDAKAN:</b>\nCek mutasi. Klik ACC jika dana masuk.`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ TERIMA (ACC)", callback_data: `ACC_${orderId}` }],
                        [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }]
                    ]
                }
            });
        }

        return res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: e.message });
    }
};
