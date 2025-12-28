# Gunakan versi Node.js yang ringan (Alpine Linux) agar hemat RAM
FROM node:18-alpine

# Buat folder kerja di dalam server
WORKDIR /app

# Salin file package.json (Tanpa package-lock.json dulu biar aman)
COPY package.json ./

# Install library dengan mode --production (Lebih hemat memori)
# Kita tambahkan --no-cache agar tidak menumpuk sampah memori
RUN npm install --omit=dev

# Salin semua kode kamu ke dalam server
COPY . .

# Beritahu server untuk membuka port 8000
EXPOSE 8000

# Perintah untuk menyalakan server
CMD ["node", "index.js"]
