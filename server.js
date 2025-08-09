const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Mail transporter (SendGrid SMTP via Nodemailer)
const transporter = nodemailer.createTransport({
  host: process.env.SENDGRID_SMTP_HOST || 'smtp.sendgrid.net',
  port: Number(process.env.SENDGRID_SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SENDGRID_SMTP_USER || 'apikey',
    pass: process.env.SENDGRID_SMTP_PASS
  }
});

// Routes
let uploadRoute;
try {
  uploadRoute = require('./routes/upload');
} catch (e1) {
  try {
    uploadRoute = require('./server/routes/upload');
  } catch (e2) {
    console.warn('[upload] route not found, skipping');
  }
}
if (uploadRoute) app.use('/api/upload', uploadRoute);

// Serve static site from project root so /index.html and assets load
app.use(express.static(path.join(__dirname)));

// DB + start server (modern Mongoose, no deprecated options)
const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await mongoose.connect(process.env.MONGO_URI); // no extra options needed
    console.log('MongoDB Connected');
    app.listen(PORT, () => console.log(`Server running on ${PORT}`));
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

start();

// Contact schema & model
const contactSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  ip: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const Contact = mongoose.model('Contact', contactSchema);

// Contact endpoint: save to MongoDB and email notification
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message, company } = req.body || {};

    // Honeypot: if 'company' is filled, likely a bot
    if (company) return res.status(200).json({ success: true });

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

    const doc = await Contact.create(cleaned);

    // Email notification
    const mailFrom = process.env.MAIL_FROM || 'Ops Scale <noreply@opsscale.tech>';
    const mailTo = process.env.MAIL_TO || 'brandontstephens25@gmail.com';
    const html = `
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#0f172a">
        <h2 style="margin:0 0 8px">New Ops Scale inquiry</h2>
        <p style="margin:0 0 6px"><strong>Name:</strong> ${cleaned.name}</p>
        <p style="margin:0 0 6px"><strong>Email:</strong> ${cleaned.email}</p>
        <p style="margin:12px 0 6px"><strong>Message:</strong></p>
        <div style="white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px">${cleaned.message}</div>
        <p style="margin:12px 0 0;color:#475569">Saved as #${doc._id}</p>
      </div>`;

    await transporter.sendMail({
      from: mailFrom,
      to: mailTo,
      subject: `Ops Scale — New Inquiry from ${cleaned.name}`,
      replyTo: cleaned.email,
      html
    });

    res.json({ success: true, id: doc._id });
  } catch (err) {
    console.error('[api/contact] error:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// Test route
app.get('/', (req, res) => res.send('Ops Scale API running'));

// Health route
app.get('/health', (_req, res) => res.json({ ok: true }));
