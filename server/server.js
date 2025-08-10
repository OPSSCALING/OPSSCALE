// server/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

// load env from server/.env
const envPath = path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });
console.log(`[env] loaded ${envPath}`);

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Mail (optional) ----------
let transporter = null;
if (process.env.SENDGRID_SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SENDGRID_SMTP_HOST || 'smtp.sendgrid.net',
    port: Number(process.env.SENDGRID_SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SENDGRID_SMTP_USER || 'apikey',
      pass: process.env.SENDGRID_SMTP_PASS
    }
  });
} else {
  console.warn('[mail] SENDGRID_SMTP_PASS not set — email notifications disabled');
}

// ---------- Routes (optional upload) ----------
let uploadRoute;
try {
  uploadRoute = require('./routes/upload');
} catch (e) {
  console.warn('[upload] route not found, skipping');
}
if (uploadRoute) app.use('/api/upload', uploadRoute);

// ---------- Env validation ----------
function checkEnv({ hasUploadRoute }) {
  const notes = [];
  const missing = [];

  // Mail: treat SENDGRID_SMTP_PASS as required to enable mail
  if (!process.env.SENDGRID_SMTP_PASS) {
    notes.push('SENDGRID_SMTP_PASS not set; email will be disabled.');
  }

  // If upload route exists, Cloudinary creds are required
  if (hasUploadRoute) {
    ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].forEach(k => {
      if (!process.env[k]) missing.push(k);
    });
  }

  // Optional but recommended
  if (!process.env.MAIL_FROM) notes.push('MAIL_FROM not set; using default.');
  if (!process.env.MAIL_TO) notes.push('MAIL_TO not set; using default.');
  if (!process.env.MONGO_URI) notes.push('MONGO_URI not set; DB features disabled.');

  if (missing.length) {
    console.warn('[env] missing required vars:', missing.join(', '));
  } else {
    console.log('[env] required vars present');
  }
  notes.forEach(n => console.warn('[env]', n));
}

checkEnv({ hasUploadRoute: Boolean(uploadRoute) });

// Serve static assets from the server folder (adjust if you move files)
app.use(express.static(path.join(__dirname)));

const PORT = Number(process.env.PORT || 3000);

// ---------- DB (optional) ----------
let dbReady = false;
let Contact = null;

const contactSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  ip: { type: String },
  createdAt: { type: Date, default: Date.now }
});

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.warn('[db] MONGO_URI not set — DB disabled');
    return;
  }
  await mongoose.connect(uri);
  dbReady = true;
  Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);
  console.log('[db] MongoDB connected');
}

// ---------- API ----------
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message, company } = req.body || {};
    if (company) return res.status(200).json({ success: true }); // honeypot

    const cleaned = {
      name: String(name || '').trim(),
      email: String(email || '').trim(),
      message: String(message || '').trim(),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
    };

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned.email);
    if (!cleaned.name || !emailOk || !cleaned.message) {
      return res.status(400).json({ success: false, error: 'Invalid input.' });
    }

    // Save if DB is available
    let saved = false;
    let id = null;
    if (dbReady && Contact) {
      const doc = await Contact.create(cleaned);
      saved = true;
      id = doc._id;
    }

    // Email if mail is available
    if (transporter) {
      const mailFrom = process.env.MAIL_FROM || 'Ops Scale <noreply@opsscale.tech>';
      const mailTo = process.env.MAIL_TO || 'you@example.com';
      const html = `
        <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#0f172a">
          <h2 style="margin:0 0 8px">New Ops Scale inquiry</h2>
          <p style="margin:0 0 6px"><strong>Name:</strong> ${cleaned.name}</p>
          <p style="margin:0 0 6px"><strong>Email:</strong> ${cleaned.email}</p>
          <p style="margin:12px 0 6px"><strong>Message:</strong></p>
          <div style="white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px">${cleaned.message}</div>
          ${id ? `<p style="margin:12px 0 0;color:#475569">Saved as #${id}</p>` : ''}
        </div>`;
      await transporter.sendMail({
        from: mailFrom,
        to: mailTo,
        subject: `Ops Scale — New Inquiry from ${cleaned.name}`,
        replyTo: cleaned.email,
        html
      });
    }

    return res.json({ success: true, saved, id, mailed: Boolean(transporter) });
  } catch (err) {
    console.error('[api/contact] error:', err);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
});

app.get('/', (_req, res) => res.send('Ops Scale API running'));
app.get('/health', (_req, res) =>
  res.json({ ok: true, db: dbReady, mail: Boolean(transporter) })
);

// ---------- Start ----------
(async () => {
  try {
    await connectDB(); // won’t throw if MONGO_URI missing
  } catch (e) {
    console.error('[db] connection failed:', e.message);
  } finally {
    app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
  }
})();