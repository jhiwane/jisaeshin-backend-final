const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // Pastikan ID Admin Benar

async function handleSaldoPayment(orderId, total, buyerContact, items) {
    try {
        // 1. Susun Pesan Awal ke Telegram (Memberitahu Admin ada order masuk)
        let itemsDetail = "";
        if (items && Array.isArray(items)) {
            items.forEach(i => {
                const note = i.note ? `\n   📝 <i>Input: ${i.note}</i>` : '';
                itemsDetail += `📦 <b>${i.name}</b>\n   Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}\n`;
            });
        }

        const msg = `💎 <b>PEMBAYARAN SALDO (MEMBER)</b>\n` +
                    `🆔 ID: <code>${orderId}</code>\n` +
                    `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                    `👤 User: ${buyerContact || 'Member'}\n\n` +
                    `${itemsDetail}\n` +
                    `⚙️ <i>Memverifikasi stok...</i>`;

        await sendMessage(ADMIN_CHAT_ID, msg);

        // 2. Panggil Logic Stok Otomatis (Menggunakan script orderHelper yg sudah ada)
        // Fungsi ini pintar: dia akan cek apakah Frontend sudah potong stok? 
        // Jika sudah, dia skip. Jika belum (misal manual), dia akan set flag manual.
        const result = await processOrderStock(orderId);

        // 3. Cek Hasil Proses
        if (result.success) {
            // A. Jika Stok Ada & Terkirim Otomatis
            await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "SALDO OTOMATIS");
            console.log(`[SALDO] Order ${orderId} Sukses Otomatis.`);
        } else {
            // B. Jika Stok Habis atau Produk Manual (Joki/Topup Admin)
            // Kirim Laporan Error ke Admin
            const errorMsg = `⚠️ <b>BUTUH PROSES MANUAL (SALDO)</b>\n` +
                             `ID: <code>${orderId}</code>\n` +
                             `Status: <i>Menunggu Proses Admin</i>\n\n` +
                             `<b>Log Sistem:</b>\n${result.logs.join('\n')}`;
            
            await sendMessage(ADMIN_CHAT_ID, errorMsg);
            
            // Munculkan Tombol Input Data Manual untuk Admin
            await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            console.log(`[SALDO] Order ${orderId} Butuh Manual.`);
        }

    } catch (e) {
        console.error("[Saldo Handler Error]:", e);
        await sendMessage(ADMIN_CHAT_ID, `❌ <b>SYSTEM ERROR (SALDO)</b>\n${e.message}`);
    }
}

module.exports = { handleSaldoPayment };
