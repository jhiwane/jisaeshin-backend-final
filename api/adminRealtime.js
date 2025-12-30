const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

/**
 * Fungsi ini mengirim notifikasi ke Admin DENGAN Menu Dashboard Realtime.
 * Dipanggil setiap kali ada order baru, perubahan status, atau chat masuk.
 * * @param {string|number} chatId - ID Telegram Admin
 * @param {string} customMessage - Pesan spesifik (misal: "🔔 Order Baru Masuk!")
 */
async function sendRealtimeDashboard(chatId, customMessage) {
    try {
        // 1. HITUNG ORDER GANTUNG (Manual Verification)
        // Ini prioritas utama admin
        const manualSnap = await db.collection('orders')
            .where('status', '==', 'manual_verification')
            .get();
        const manualCount = manualSnap.size;

        // 2. HITUNG KOMPLAIN / CHAT BELUM DIBACA (Opsional)
        // Jika kamu punya flag 'isRead: false' atau status 'open'
        const complaintSnap = await db.collection('orders') // Atau collection 'complaints'
            .where('complaintStatus', '==', 'open') 
            .get();
        const complaintCount = complaintSnap.size;

        // 3. TENTUKAN IKON STATUS
        // Jika ada pending, pakai tanda seru merah. Jika aman, pakai centang hijau.
        const manualIcon = manualCount > 0 ? `🔴 ${manualCount}` : `✅ 0`;
        const complaintIcon = complaintCount > 0 ? `📩 ${complaintCount}` : `✅ 0`;

        // 4. SUSUN TOMBOL MENU (DYNAMIC KEYBOARD)
        const keyboard = [
            [
                // Tombol ini akan menampilkan jumlah real-time
                { text: `🛠 Butuh Manual (${manualIcon})`, callback_data: 'CHECK_PENDING' }
            ],
            [
                { text: `💬 Komplain (${complaintIcon})`, callback_data: 'ADMIN_REPORT' }, // Arahkan ke menu report atau list chat
                { text: "📊 Laporan", callback_data: 'ADMIN_REPORT' }
            ],
            [
                { text: "🔄 Refresh Dashboard", callback_data: 'ADMIN_MENU' }
            ]
        ];

        // 5. SUSUN PESAN FINAL
        // Gabungkan pesan notifikasi dengan ringkasan status
        const finalMessage = `${customMessage}\n\n` +
                             `----------------------------\n` +
                             `📊 <b>STATUS SAAT INI:</b>\n` +
                             `⚠️ Pending Manual: <b>${manualCount}</b> Order\n` +
                             `💬 Komplain Open: <b>${complaintCount}</b> Chat\n` +
                             `----------------------------\n` +
                             `👇 <i>Klik tombol di bawah untuk eksekusi:</i>`;

        // 6. KIRIM PESAN
        await sendMessage(chatId, finalMessage, {
            reply_markup: { inline_keyboard: keyboard }
        });

    } catch (error) {
        console.error("Error sending realtime dashboard:", error);
    }
}

module.exports = { sendRealtimeDashboard };
