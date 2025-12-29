const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama (Pastikan orderHelper juga mendukung return value yang sesuai)
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda

module.exports = async function(req, res) {
    // Kita ambil data dari body request
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        // Helper kecil untuk format list item agar rapi
        const formatItemsList = (itemsArr) => {
            if (!itemsArr || !Array.isArray(itemsArr)) return "";
            return itemsArr.map((i, idx) => {
                const note = i.note ? `\n    📝 <i>Note: ${i.note}</i>` : '';
                // Menambahkan Index (1., 2.) agar mudah dicocokkan saat manual input
                return `<b>${idx + 1}. ${i.name}</b>\n    Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}`;
            }).join('\n');
        };

        // ==========================================
        // 1. AUTO ORDER (MIDTRANS / WEB) & SALDO
        //    (Logika digabung agar lebih efisien karena mirip)
        // ==========================================
        if (type === 'auto' || type === 'saldo') {
            const sourceLabel = type === 'saldo' ? "SALDO/MEMBER" : "OTOMATIS (WEB)";
            const userLabel = type === 'saldo' ? (buyerContact || 'Member') : 'Guest/Web';
            
            // 1. Kirim Info Awal ke Admin
            const itemsDetail = formatItemsList(items);
            const msgStart = `⚡️ <b>PESANAN ${sourceLabel} MASUK</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `👤 User: ${userLabel}\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `📦 <b>Daftar Item:</b>\n${itemsDetail}\n\n` +
                        `⚙️ <i>Sistem sedang memproses stok...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msgStart);
            
            // 2. Eksekusi Proses Stok Otomatis
            // processOrderStock diharapkan mengembalikan { success: bool, logs: [], items: [] }
            const result = await processOrderStock(orderId);
            
            if (result.success) {
                // KASUS A: SEMUA STOK ADA
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, sourceLabel);
            } else {
                // KASUS B: ADA ITEM KOSONG / GAGAL / PARTIAL
                // Kita tampilkan log apa yang berhasil dan apa yang gagal
                let logMessage = result.logs && result.logs.length > 0 
                    ? result.logs.join('\n') 
                    : "Beberapa stok tidak tersedia.";

                const msgFail = `⚠️ <b>BUTUH TINDAKAN MANUAL</b>\n` +
                                `RefID: <code>${orderId}</code>\n\n` +
                                `<b>Laporan Sistem:</b>\n${logMessage}\n\n` +
                                `👇 <i>Silakan input manual data yang kurang di bawah ini:</i>`;
                
                await sendMessage(ADMIN_CHAT_ID, msgFail);

                // 3. Tampilkan Menu Manual Input (Untuk Item yang kosong saja atau Revisi)
                // Ini akan memicu tombol "Isi Data" atau "Revisi" yang ditangani telegram-webhook
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        } 
        
        // ==========================================
        // 2. KOMPLAIN DARI USER
        // ==========================================
        else if (type === 'complaint') {
            const text = `⚠️ <b>LAPORAN MASALAH (KOMPLAIN)</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `👤 User: ${buyerContact || 'Guest'}\n` +
                         `💬 Pesan: "${message}"\n\n` +
                         `👇 <i>Klik tombol di bawah untuk membalas:</i>`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [[{ text: "🗣 BALAS KE USER", callback_data: `REPLY_COMPLAINT_${orderId}` }]]
                }
            });
        }
        
        // ==========================================
        // 3. KONFIRMASI PEMBAYARAN MANUAL (TRANSFER)
        // ==========================================
        else if (type === 'manual') {
            const itemsDetail = formatItemsList(items);

            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                         `👤 User: ${buyerContact}\n\n` +
                         `🛒 <b>Items:</b>\n${itemsDetail}\n\n` +
                         `👇 <b>TINDAKAN:</b>\nCek mutasi bank/e-wallet. Jika dana masuk, klik ACC.`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [
                        // Tombol ACC akan memicu processOrderStock di webhook
                        // Jika stok kosong, webhook akan otomatis memanggil showManualInputMenu
                        [{ text: "✅ TERIMA (ACC)", callback_data: `ACC_${orderId}` }],
                        [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }]
                    ]
                }
            });
        }

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("Notify Error:", e);
        // Tetap return 200 agar pengirim (web/midtrans) tidak mengulang request terus menerus
        // Tapi kita kirim notif error ke admin
        await sendMessage(ADMIN_CHAT_ID, `🔥 <b>SYSTEM ERROR (NOTIFY)</b>\n${e.message}`);
        return res.status(200).json({ error: e.message });
    }
};
