// server/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

// Load env only in development (Render/production uses dashboard env vars)
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.join(__dirname, '.env');
  require('dotenv').config({ path: envPath });
  console.log(`[env] loaded ${envPath}`);
} else {
  console.log('[env] Production mode — using environment variables from host (Render, etc.)');
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Mail (optional) ----------
let transporter = null;
if (process.env.SENDGRID_SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SENDGRID_SMTP_HOST || 'smtp.sendgrid.net',
    port: Number(process.env.SENDGRID_SMTP_PORT || 587),
    secure: false, // STARTTLS on 587
    auth: {
      user: process.env.SENDGRID_SMTP_USER || 'apikey',
      pass: process.env.SENDGRID_SMTP_PASS,
    },
    logger: true,
    debug: true,
  });
  transporter.verify((err, success) => {
    if (err) {
      console.error('[mail] transporter.verify failed:', err.message);
    } else {
      console.log('[mail] transporter ready');
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

// Serve static assets from /public (HTML/CSS/JS live here)
app.use(express.static(path.join(__dirname, 'public')));
// Explicit mounts for common subfolders (helps if absolute paths are used in HTML)
app.use('/cases', express.static(path.join(__dirname, 'public', 'cases')));
app.use('/logos', express.static(path.join(__dirname, 'public', 'logos')));
app.use('/videos', express.static(path.join(__dirname, 'public', 'videos')));

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
async function sendContactEmail(doc) {
  const from = process.env.MAIL_FROM || 'Ops Scale <noreply@opsscale.tech>';
  const to = process.env.MAIL_TO || 'opsscaletech@gmail.com';
  const subject = `New inquiry from ${doc.name}`;

  const html = `
    <h2>New Contact Submission</h2>
    <p><strong>Name:</strong> ${doc.name}</p>
    <p><strong>Email:</strong> ${doc.email}</p>
    <p><strong>Message:</strong><br/>${doc.message || ''}</p>
    <p><small>IP: ${doc.ip || ''}</small></p>
  `;

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html,
  });
  console.log('[mail] sendMail accepted, id:', info.messageId);
  return info;
}

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const doc = new Contact({
      name,
      email,
      message,
      ip: req.ip,
      createdAt: new Date(),
    });

    await doc.save();

    let mailed = false;
    try {
      const info = await sendContactEmail(doc);
      mailed = Boolean(info && info.accepted && info.accepted.length);
    } catch (e) {
      console.error('[mail] sendContactEmail error:', e.message);
    }

    return res.json({ success: true, saved: true, id: String(doc._id), mailed });
  } catch (err) {
    console.error('[api] /api/contact error:', err);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/mail/test', async (_req, res) => {
  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || 'Ops Scale <noreply@opsscale.tech>',
      to: process.env.MAIL_TO || 'opsscaletech@gmail.com',
      subject: 'Ops Scale SMTP test',
      text: 'This is a test email from Render via SendGrid SMTP.',
    });
    res.json({ ok: true, messageId: info.messageId, accepted: info.accepted });
  } catch (e) {
    console.error('[mail] /api/mail/test failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve your landing page at the root
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);
app.get('/health', (_req, res) => {
  const dbReadyNow = mongoose && mongoose.connection && mongoose.connection.readyState === 1;
  const mailReady = Boolean(process.env.SENDGRID_SMTP_PASS);
  res.json({ ok: true, db: dbReadyNow, mail: mailReady });
});

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