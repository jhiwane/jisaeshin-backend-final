const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; 

// --- HELPER: FORMAT NOMOR WA ---
function getWaLink(contactString) {
    if (!contactString) return null;
    // Ambil hanya angka
    let num = contactString.replace(/\D/g, ''); 
    // Ubah 08xx jadi 628xx
    if (num.startsWith('0')) {
        num = '62' + num.substring(1);
    } else if (num.startsWith('8')) {
        num = '62' + num;
    }
    // Validasi panjang nomor (minimal 10 digit)
    if (num.length > 9) return `https://wa.me/${num}`;
    return null;
}

// --- HELPER: HITUNG JUMLAH PENDING ---
async function getPendingStats() {
    try {
        const snap = await db.collection('orders')
            .where('status', 'in', ['pending', 'manual_verification', 'process', 'manual_pending'])
            .get();
        return snap.size;
    } catch (e) { return 0; }
}

function buildItemsListSafe(items) {
    let itemsDetail = "";
    const MAX_DISPLAY = 20; 
    if (items && Array.isArray(items)) {
        const displayItems = items.slice(0, MAX_DISPLAY);
        displayItems.forEach((i, index) => {
            const safeName = (i.name || 'Item').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeNote = i.note ? ` <i>(${i.note})</i>` : '';
            itemsDetail += `${index+1}. <b>${safeName}</b> (x${i.qty})${safeNote}\n`;
        });
        if (items.length > MAX_DISPLAY) {
            itemsDetail += `\n📦 <i>...dan ${items.length - MAX_DISPLAY} item lainnya</i>\n`;
        }
    }
    return itemsDetail;
}

module.exports = async function(req, res) {
    const payload = req.body;
    const orderId = payload.order_id || payload.orderId;
    const type = payload.type; 
    const statusMidtrans = payload.transaction_status; 
    const statusPayload = payload.status; 

    try {
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        if (!orderSnap.exists) return res.status(200).send('Order not found yet');

        const orderFromDb = orderSnap.data();
        const finalItems = orderFromDb.items || payload.items || [];
        const itemsDetail = buildItemsListSafe(finalItems);
        const totalHarga = parseInt(payload.total || orderFromDb.total || 0).toLocaleString();

        // --- AMBIL KONTAK & BUAT LINK WA ---
        const displayContact = orderFromDb.buyerContact || payload.buyerContact || "Guest";
        const waLink = getWaLink(displayContact); // Cek apakah ini nomor HP

        // --- HITUNG PENDING UNTUK FOOTER ---
        const pendingCount = await getPendingStats();
        const pendingIcon = pendingCount > 0 ? `⭕ ${pendingCount} Pending` : `✅ 0 Pending`;
        
        // --- BUAT KEYBOARD DINAMIS ---
        const keyboard = [];

        // Jika ada link WA, tambahkan tombol Chat
        if (waLink) {
            keyboard.push([{ text: "📲 CHAT BUYER (WA)", url: waLink }]);
        }

        // Tombol Cek Pending selalu ada
        keyboard.push([{ text: `📂 Cek Antrian (${pendingIcon})`, callback_data: 'CHECK_PENDING' }]);

        // 1. PEMBAYARAN MANUAL
        if (type === 'manual') {
            const text = `💸 <b>PEMBAYARAN MANUAL</b>\n` +
                         `🆔 <code>${orderId}</code>\n` +
                         `👤 ${displayContact}\n` +
                         `💰 Rp ${totalHarga}\n\n` +
                         `🛒 <b>Items:</b>\n${itemsDetail}\n` +
                         `👇 <i>Cek mutasi, lalu klik ACC:</i>`;

            // Tambahkan tombol ACC/Reject di atas tombol common
            const manualKeyboard = [
                [{ text: "✅ ACC TERIMA", callback_data: `ACC_${orderId}` }],
                [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }],
                ...keyboard // Gabungkan dengan tombol WA & Pending
            ];

            await sendMessage(ADMIN_CHAT_ID, text, { reply_markup: { inline_keyboard: manualKeyboard } });
        } 
        
        // 2. SUKSES (OTOMATIS / SALDO / MIDTRANS)
        else if (statusMidtrans === 'settlement' || statusMidtrans === 'capture' || type === 'otomatis' || type === 'saldo' || statusPayload === 'success') {
            const result = await processOrderStock(orderId);
            
            if (result.success) {
                const text = `✅ <b>ORDER SUKSES (${type === 'saldo' ? 'SALDO' : 'MIDTRANS'})</b>\n` +
                             `🆔 <code>${orderId}</code>\n` +
                             `👤 ${displayContact}\n` +
                             `💰 Rp ${totalHarga}\n\n` +
                             `<i>Stok otomatis terkirim ke web user.</i>\n` +
                             `----------------\nSTATUS TOKO: ${pendingIcon}`;
                
                // Tetap kirim tombol WA jika perlu kontak buyer
                await sendMessage(ADMIN_CHAT_ID, text, { reply_markup: { inline_keyboard: keyboard } }); 
            } 
            else {
                const alertMsg = `⚠️ <b>STOK KOSONG (BUTUH MANUAL)</b>\n` +
                                 `🆔 <code>${orderId}</code>\n` +
                                 `👤 ${displayContact}\n` +
                                 `<i>Status Paid, tapi stok habis. Input manual sekarang.</i>`;
                
                const stockKeyboard = [
                    [{ text: "🛠 Isi Data Manual", callback_data: `RESOLVE_${orderId}` }],
                    ...keyboard
                ];
                await sendMessage(ADMIN_CHAT_ID, alertMsg, { reply_markup: { inline_keyboard: stockKeyboard } });
            }
        }

        // 3. KOMPLAIN (TAMBAHAN PENTING)
        else if (type === 'complaint') {
             const complaintMsg = (payload.message || "-").replace(/&/g, '&amp;');
             const text = `⚠️ <b>KOMPLAIN BARU</b>\n🆔 <code>${orderId}</code>\n👤 ${displayContact}\n💬 <pre>${complaintMsg}</pre>`;
             
             const complaintKeyboard = [
                 [{ text: "📩 BALAS PESAN", callback_data: `REPLY_CS_${orderId}` }],
                 ...keyboard
             ];
             await sendMessage(ADMIN_CHAT_ID, text, { reply_markup: { inline_keyboard: complaintKeyboard } });
        }

        // 4. MANUAL VERIFICATION (ERROR/MACET)
        else if (type === 'manual_verification' || orderFromDb.status === 'manual_verification') {
             const alertMsg = `🔴 <b>BUTUH VERIFIKASI MANUAL!</b>\nOrder ID: <code>${orderId}</code>\nAda masalah sistem/stok. Cek segera.`;
             await sendMessage(ADMIN_CHAT_ID, alertMsg, { reply_markup: { inline_keyboard: keyboard } });
        }

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("NOTIFY ERROR:", e.message); 
        res.status(200).send('Error handled');
    }
};
