const express = require('express');
const http = require('http');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const stockURL = 'https://api.joshlei.com/v2/growagarden/stock';
const weatherURL = 'https://api.joshlei.com/v2/growagarden/weather';
const itemInfoURL = 'https://api.joshlei.com/v2/growagarden/info/';

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

if (!EMAIL_USER || !EMAIL_PASS) {
  console.error('ERROR: Set EMAIL_USER and EMAIL_PASS env vars.');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

let latestStockDataJSON = null;
let latestStockDataObj = null;
let latestWeatherDataJSON = null;
let latestWeatherDataObj = null;
let itemInfo = [];

const pendingVerifications = new Map();
const verifiedEmails = new Map();
const subscriptions = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function fetchItemInfo() {
  try {
    const response = await fetch(itemInfoURL);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    const data = await response.json();
    itemInfo = Object.values(data).filter(item => item && item.item_id && typeof item.item_id === 'string');
    console.log('Item info loaded:', itemInfo.length, 'items');
    broadcastLog('Fetched item info from API.');
  } catch (err) {
    broadcastLog(`Error fetching item info: ${err.toString()}`);
    itemInfo = [];
  }
}

function broadcastLog(msg) {
  const timestamp = new Date().toISOString();
  const fullMsg = `[${timestamp}] ${msg}`;
  console.log(fullMsg);
  io.emit('log', fullMsg);
}

function hasDataChanged(oldJSON, newJSON) {
  return oldJSON !== newJSON;
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildVerificationEmail(email, token) {
  const verificationUrl = `https://botemail-8wvg.onrender.com/verify?email=${encodeURIComponent(email)}&token=${token}`;
  return `
    <div style="max-width: 600px; margin: 0 auto; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
      <div style="background: linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%); 
                  backdrop-filter: blur(10px); 
                  border-radius: 20px; 
                  border: 1px solid rgba(255,255,255,0.2);
                  padding: 30px;
                  box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);">
        <div style="text-align: center; margin-bottom: 25px;">
          <h1 style="color: #6a9955; font-size: 28px; margin-bottom: 10px;">🌱 Grow A Garden</h1>
          <p style="color: #d4d4d4; font-size: 16px; margin-bottom: 25px;">Please verify your email address to subscribe to updates</p>
        </div>
        
        <div style="text-align: center; margin-bottom: 30px;">
          <a href="${verificationUrl}" 
             style="display: inline-block; 
                    padding: 12px 30px; 
                    background: linear-gradient(135deg, #6a9955 0%, #4a7a3a 100%); 
                    color: white; 
                    text-decoration: none; 
                    border-radius: 30px; 
                    font-weight: 500;
                    box-shadow: 0 4px 15px rgba(106, 153, 85, 0.3);
                    transition: all 0.3s ease;">
            Verify Email Address
          </a>
        </div>
        
        <p style="color: #a0a0a0; font-size: 14px; text-align: center; margin-bottom: 5px;">
          This link will expire in 24 hours.
        </p>
        <p style="color: #a0a0a0; font-size: 14px; text-align: center;">
          If you didn't request this, please ignore this email.
        </p>
      </div>
    </div>
  `;
}

function sendVerificationEmail(email) {
  const token = generateVerificationToken();
  const timestamp = Date.now();
  pendingVerifications.set(email, { token, timestamp });

  const mailOptions = {
    from: `"Grow A Garden Bot" <${EMAIL_USER}>`,
    to: email,
    subject: '🌱 Verify Your Grow A Garden Subscription',
    html: buildVerificationEmail(email, token),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) broadcastLog(`Error sending verification email to ${email}: ${error.toString()}`);
    else broadcastLog(`Verification email sent to ${email}: ${info.response}`);
  });
}

function buildStockHtmlEmail(data, recipientEmail) {
  const userSelections = subscriptions.get(recipientEmail);
  if (!userSelections) return null;

  let html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
      <div style="background: linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%); 
                  backdrop-filter: blur(10px); 
                  border-radius: 20px; 
                  border: 1px solid rgba(255,255,255,0.2);
                  padding: 30px;
                  box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #6a9955; font-size: 24px; margin-bottom: 5px;">🌱 Stock Update</h1>
          <p style="color: #d4d4d4; font-size: 14px;">Your subscribed items are now available!</p>
        </div>
  `;

  const allStockItems = [];
  ['seed_stock', 'gear_stock', 'egg_stock', 'cosmetic_stock', 'event_stock'].forEach(category => {
    if (Array.isArray(data[category])) allStockItems.push(...data[category]);
  });

  const inStockItems = allStockItems.filter(item => userSelections.has(item.item_id) && item.quantity > 0);

  if (inStockItems.length > 0) {
    html += `
      <table style="width: 100%; border-collapse: separate; border-spacing: 0 10px; margin-bottom: 25px;">
        <thead>
          <tr>
            <th style="text-align: left; padding: 8px 12px; color: #a0a0a0; font-weight: normal; border-bottom: 1px solid rgba(255,255,255,0.1);">Item</th>
            <th style="text-align: right; padding: 8px 12px; color: #a0a0a0; font-weight: normal; border-bottom: 1px solid rgba(255,255,255,0.1);">Quantity</th>
          </tr>
        </thead>
        <tbody>
    `;

    inStockItems.forEach(item => {
      const name = item.display_name || item.item_id || 'Unknown';
      const qty = item.quantity || 0;
      const itemData = Array.isArray(itemInfo) ? itemInfo.find(info => info.item_id === item.item_id) : null;
      const iconUrl = itemData?.icon || `https://api.joshlei.com/v2/growagarden/image/${item.item_id}`;
      
      html += `
        <tr style="background: rgba(255,255,255,0.03); border-radius: 8px;">
          <td style="padding: 12px; border-radius: 8px 0 0 8px;">
            <div style="display: flex; align-items: center;">
              <img src="${iconUrl}" alt="${name}" style="width: 32px; height: 32px; object-fit: contain; margin-right: 12px; border-radius: 4px;">
              <span style="color: #d4d4d4;">${name}</span>
            </div>
          </td>
          <td style="padding: 12px; text-align: right; border-radius: 0 8px 8px 0; color: #6a9955; font-weight: 500;">${qty}</td>
        </tr>
      `;
    });

    html += `</tbody></table>`;
  } else {
    return null;
  }

  html += `
        <div style="text-align: center; margin-top: 30px;">
          <a href="https://botemail-8wvg.onrender.com/unsub?email=${encodeURIComponent(recipientEmail)}" 
             style="color: #a0a0a0; font-size: 12px; text-decoration: none;">
            Unsubscribe from these notifications
          </a>
        </div>
      </div>
    </div>
  `;

  return html;
}

function buildWeatherHtmlEmail(weatherEvent, discordInvite, recipientEmail) {
  const duration = weatherEvent.duration ? `${Math.floor(weatherEvent.duration / 60)} minutes` : 'Unknown';
  
  return `
    <div style="max-width: 600px; margin: 0 auto; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
      <div style="background: linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%); 
                  backdrop-filter: blur(10px); 
                  border-radius: 20px; 
                  border: 1px solid rgba(255,255,255,0.2);
                  padding: 30px;
                  box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #6a9955; font-size: 24px; margin-bottom: 5px;">🌦️ Weather Event</h1>
          <p style="color: #d4d4d4; font-size: 14px;">New weather detected in Grow A Garden!</p>
        </div>
        
        <div style="background: rgba(255,255,255,0.03); border-radius: 8px; padding: 20px; margin-bottom: 25px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
            <span style="color: #a0a0a0;">Event:</span>
            <span style="color: #d4d4d4; font-weight: 500;">${weatherEvent.weather_name || weatherEvent.weather_id || 'Unknown'}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #a0a0a0;">Duration:</span>
            <span style="color: #d4d4d4; font-weight: 500;">${duration}</span>
          </div>
        </div>
        
        ${discordInvite ? `
        <div style="text-align: center; margin-bottom: 25px;">
          <a href="${discordInvite}" 
             style="display: inline-block; 
                    padding: 10px 20px; 
                    background: linear-gradient(135deg, #5865F2 0%, #3B45B5 100%); 
                    color: white; 
                    text-decoration: none; 
                    border-radius: 30px; 
                    font-weight: 500;
                    box-shadow: 0 4px 15px rgba(88, 101, 242, 0.3);">
            Join Discord Community
          </a>
        </div>
        ` : ''}
        
        <div style="text-align: center; margin-top: 30px;">
          <a href="https://botemail-8wvg.onrender.com/unsub?email=${encodeURIComponent(recipientEmail)}" 
             style="color: #a0a0a0; font-size: 12px; text-decoration: none;">
            Unsubscribe from these notifications
          </a>
        </div>
      </div>
    </div>
  `;
}

function sendEmail(subject, htmlBody, recipientEmail) {
  const mailOptions = {
    from: `"Grow A Garden Bot" <${EMAIL_USER}>`,
    to: recipientEmail,
    subject: subject,
    html: htmlBody,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) broadcastLog(`Error sending email to ${recipientEmail}: ${error.toString()}`);
    else broadcastLog(`Email sent to ${recipientEmail}: ${info.response}`);
  });
}

async function pollStockAPI() {
  try {
    const response = await fetch(stockURL);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    const data = await response.json();
    const newDataJSON = JSON.stringify(data);

    if (hasDataChanged(latestStockDataJSON, newDataJSON)) {
      broadcastLog('Stock data changed — checking subscriber selections...');
      latestStockDataJSON = newDataJSON;
      latestStockDataObj = data;
      if (!itemInfo.length) await fetchItemInfo();
      
      subscriptions.forEach((selections, email) => {
        const html = buildStockHtmlEmail(data, email);
        if (html) sendEmail('🌱 Grow A Garden Stock Updated!', html, email);
      });
    } else {
      broadcastLog('Polled Stock API — no changes detected.');
    }
  } catch (err) {
    broadcastLog(`Error polling Stock API: ${err.toString()}`);
  }
}

async function pollWeatherAPI() {
  try {
    const response = await fetch(weatherURL);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    const data = await response.json();
    const newDataJSON = JSON.stringify(data);

    if (hasDataChanged(latestWeatherDataJSON, newDataJSON)) {
      broadcastLog('Weather data changed — checking for active events...');
      const activeEvent = data.weather.find(w => w.active);
      const prevActiveEvent = latestWeatherDataObj ? latestWeatherDataObj.weather.find(w => w.active) : null;

      if (activeEvent && (!prevActiveEvent || activeEvent.weather_id !== prevActiveEvent.weather_id)) {
        broadcastLog(`New active weather event: ${activeEvent.weather_name}`);
        subscriptions.forEach((_, email) => {
          sendEmail(
            `🌦️ Grow A Garden Weather Event: ${activeEvent.weather_name}`, 
            buildWeatherHtmlEmail(activeEvent, data.discord_invite, email), 
            email
          );
        });
      } else if (!activeEvent && prevActiveEvent) {
        broadcastLog(`Weather event ended: ${prevActiveEvent.weather_name}`);
      } else {
        broadcastLog('No new active weather event detected.');
      }

      latestWeatherDataJSON = newDataJSON;
      latestWeatherDataObj = data;
    } else {
      broadcastLog('Polled Weather API — no changes detected.');
    }
  } catch (err) {
    broadcastLog(`Error polling Weather API: ${err.toString()}`);
  }
}

setInterval(pollStockAPI, 15000);
setInterval(pollWeatherAPI, 15000);
pollStockAPI();
pollWeatherAPI();

setInterval(() => {
  const now = Date.now();
  const expirationTime = 24 * 60 * 60 * 1000;
  for (const [email, { timestamp }] of pendingVerifications) {
    if (now - timestamp > expirationTime) {
      pendingVerifications.delete(email);
      broadcastLog(`Removed expired verification token for ${email}`);
    }
  }
}, 60 * 60 * 1000);

app.get('/', (req, res) => {
  let html = `<!DOCTYPE html>
<html>
<head>
  <title>Grow A Garden - Live Logs</title>
  <style>
    body { background: #1e1e1e; color: #d4d4d4; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; }
    #terminal {
      padding: 1rem;
      height: 70vh;
      overflow-y: auto;
      white-space: pre-wrap;
      background: #121212;
      border: 1px solid #333;
      box-sizing: border-box;
      font-family: monospace;
      border-radius: 8px;
      margin: 20px auto;
      max-width: 1000px;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 20px;
    }
    .subscribe-form {
      text-align: center;
      padding: 2rem;
      background: rgba(30, 30, 30, 0.8);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      margin: 20px auto;
      max-width: 600px;
      box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.1);
    }
    .subscribe-form input[type="email"] {
      padding: 12px 15px;
      font-size: 1rem;
      background: rgba(40, 40, 40, 0.8);
      color: #d4d4d4;
      border: 1px solid rgba(106, 153, 85, 0.5);
      border-radius: 8px;
      margin-right: 0.5rem;
      width: 300px;
      outline: none;
      transition: all 0.3s ease;
    }
    .subscribe-form input[type="email"]:focus {
      border-color: #6a9955;
      box-shadow: 0 0 0 2px rgba(106, 153, 85, 0.3);
    }
    .subscribe-form button {
      padding: 12px 25px;
      font-size: 1rem;
      background: linear-gradient(135deg, #6a9955 0%, #4a7a3a 100%);
      color: #fff;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(106, 153, 85, 0.3);
    }
    .subscribe-form button:hover {
      background: linear-gradient(135deg, #5a8a45 0%, #3a6a2a 100%);
      transform: translateY(-2px);
    }
    .subscribe-form button:disabled {
      background: #444;
      cursor: not-allowed;
      transform: none;
    }
    .message {
      margin: 1rem 0;
      padding: 10px 15px;
      border-radius: 8px;
      text-align: center;
    }
    .success {
      background: rgba(106, 153, 85, 0.2);
      color: #6a9955;
      border: 1px solid rgba(106, 153, 85, 0.5);
    }
    .error {
      background: rgba(255, 85, 85, 0.2);
      color: #ff5555;
      border: 1px solid rgba(255, 85, 85, 0.5);
    }
    .popup {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      backdrop-filter: blur(5px);
    }
    .popup-content {
      background: rgba(30, 30, 30, 0.95);
      border: 1px solid rgba(106, 153, 85, 0.5);
      border-radius: 16px;
      padding: 30px;
      width: 90%;
      max-width: 700px;
      max-height: 80vh;
      overflow-y: auto;
      margin: 10vh auto;
      position: relative;
      box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);
      backdrop-filter: blur(10px);
    }
    .popup-content h2 {
      color: #6a9955;
      margin-top: 0;
      text-align: center;
    }
    .popup-content button {
      background: linear-gradient(135deg, #6a9955 0%, #4a7a3a 100%);
      color: #fff;
      border: none;
      padding: 12px 25px;
      border-radius: 8px;
      cursor: pointer;
      margin: 1rem 0.5rem 0 0;
      transition: all 0.3s ease;
    }
    .popup-content button:hover {
      background: linear-gradient(135deg, #5a8a45 0%, #3a6a2a 100%);
      transform: translateY(-2px);
    }
    .item-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
      margin: 20px 0;
    }
    .item-list label {
      display: flex;
      align-items: center;
      padding: 12px;
      background: rgba(40, 40, 40, 0.8);
      border: 1px solid rgba(106, 153, 85, 0.3);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .item-list label:hover {
      background: rgba(60, 60, 60, 0.8);
      border-color: #6a9955;
    }
    .item-list input[type="checkbox"] {
      margin-right: 10px;
      accent-color: #6a9955;
    }
    .header {
      text-align: center;
      margin: 30px 0;
    }
    .header h1 {
      color: #6a9955;
      font-size: 2.5rem;
      margin-bottom: 10px;
    }
    .header p {
      color: #a0a0a0;
      font-size: 1.1rem;
    }
    .loading {
      text-align: center;
      padding: 20px;
      color: #a0a0a0;
    }
    .loading:after {
      content: '...';
      animation: dots 1.5s steps(5, end) infinite;
    }
    @keyframes dots {
      0%, 20% { content: '.'; }
      40% { content: '..'; }
      60%, 100% { content: '...'; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Grow A Garden Notifications</h1>
      <p>Get notified when your favorite items are back in stock or when special weather events occur</p>
    </div>

    <div class="subscribe-form">
      <form id="subscribe-form">
        <input type="email" name="email" placeholder="Enter your email" required>
        <button type="submit" id="subscribe-button">Subscribe</button>
        <div id="subscribe-message" class="message"></div>
      </form>
    </div>

    <div id="terminal"></div>
  </div>

  <div id="verification-popup" class="popup">
    <div class="popup-content">
      <h2>Verify Your Email</h2>
      <p style="text-align: center;">We've sent a verification link to <span id="verification-email" style="font-weight: bold; color: #6a9955;"></span></p>
      <p style="text-align: center; color: #a0a0a0;">Please check your inbox and click the verification link to continue.</p>
      <div style="text-align: center; margin-top: 30px;">
        <button id="resend-button" style="background: transparent; border: 1px solid #6a9955; color: #6a9955;">Resend Verification</button>
      </div>
    </div>
  </div>

  <div id="subscribe-popup" class="popup">
    <div class="popup-content">
      <h2>Select Items for Stock Alerts</h2>
      <form id="item-selection-form" action="/subscribe" method="POST">
        <input type="hidden" name="email" id="popup-email">
        <div id="items-section">
          <div class="item-list" id="item-list-container">
            ${Array.isArray(itemInfo) && itemInfo.length > 0 ? 
              itemInfo.map(item => 
                `<label><input type="checkbox" name="items" value="${item.item_id}"> ${item.display_name || item.item_id}</label>`
              ).join('') : 
              '<div class="loading">Loading available items</div>'}
          </div>
        </div>
        <div style="text-align: center;">
          <button type="submit">Complete Subscription</button>
          <div id="error-message" class="message error" style="display: none;"></div>
        </div>
      </form>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const terminal = document.getElementById('terminal');
    const socket = io();
    const subscribeForm = document.getElementById('subscribe-form');
    const subscribeButton = document.getElementById('subscribe-button');
    const subscribeMessage = document.getElementById('subscribe-message');
    const verificationPopup = document.getElementById('verification-popup');
    const verificationEmail = document.getElementById('verification-email');
    const resendButton = document.getElementById('resend-button');
    const subscribePopup = document.getElementById('subscribe-popup');
    const itemForm = document.getElementById('item-selection-form');
    const popupEmail = document.getElementById('popup-email');
    const errorMessage = document.getElementById('error-message');
    const itemListContainer = document.getElementById('item-list-container');

    let currentEmail = '';
    let verificationTimer = null;

    socket.on('log', msg => {
      terminal.textContent += msg + '\\n';
      terminal.scrollTop = terminal.scrollHeight;
    });

    subscribeForm.onsubmit = async function(e) {
      e.preventDefault();
      const email = subscribeForm.querySelector('input[name="email"]').value.trim();
      if (!email) {
        showMessage('Email cannot be empty.', 'error');
        return;
      }

      currentEmail = email;
      subscribeButton.disabled = true;
      subscribeButton.textContent = 'Sending...';

      try {
        const response = await fetch('/request-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        
        const result = await response.json();
        showMessage(result.message, result.success ? 'success' : 'error');
        
        if (result.success) {
          verificationEmail.textContent = email;
          verificationPopup.style.display = 'block';
          startVerificationTimer();
        }
      } catch (err) {
        showMessage('Error sending verification request.', 'error');
        console.error('Error:', err);
      } finally {
        subscribeButton.disabled = false;
        subscribeButton.textContent = 'Subscribe';
      }
    };

    resendButton.onclick = async function() {
      resendButton.disabled = true;
      resendButton.textContent = 'Sending...';
      
      try {
        const response = await fetch('/request-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: currentEmail })
        });
        
        const result = await response.json();
        if (result.success) {
          showMessage('New verification email sent!', 'success', verificationPopup);
          startVerificationTimer();
        } else {
          showMessage(result.message || 'Failed to resend.', 'error', verificationPopup);
        }
      } catch (err) {
        showMessage('Error resending verification.', 'error', verificationPopup);
        console.error('Error:', err);
      } finally {
        resendButton.disabled = false;
        resendButton.textContent = 'Resend Verification';
      }
    };

    itemForm.onsubmit = async function(e) {
      e.preventDefault();
      const email = popupEmail.value;
      const itemCheckboxes = document.querySelectorAll('input[name="items"]:checked');
      
      if (itemCheckboxes.length === 0) {
        showError('Please select at least one item.');
        return;
      }

      const items = Array.from(itemCheckboxes).map(cb => cb.value);
      
      try {
        const response = await fetch('/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, items })
        });
        
        const result = await response.json();
        if (result.success) {
          subscribePopup.style.display = 'none';
          verificationPopup.style.display = 'none';
          showMessage('Successfully subscribed! You will now receive notifications.', 'success');
        } else {
          showError(result.message || 'Subscription failed.');
        }
      } catch (err) {
        showError('Error completing subscription.');
        console.error('Error:', err);
      }
    };

    function showMessage(text, type, container = subscribeForm) {
      const msgElement = container.querySelector('.message') || subscribeMessage;
      msgElement.textContent = text;
      msgElement.className = 'message ' + type;
      msgElement.style.display = 'block';
    }

    function showError(text) {
      errorMessage.textContent = text;
      errorMessage.style.display = 'block';
      setTimeout(() => {
        errorMessage.style.display = 'none';
      }, 5000);
    }

    function startVerificationTimer() {
      if (verificationTimer) {
        clearInterval(verificationTimer);
      }
      
      verificationTimer = setInterval(async () => {
        try {
          const response = await fetch('/check-verification?email=' + encodeURIComponent(currentEmail));
          const result = await response.json();
          
          if (result.verified) {
            clearInterval(verificationTimer);
            verificationPopup.style.display = 'none';
            popupEmail.value = currentEmail;
            subscribePopup.style.display = 'block';
            
            if (itemListContainer.textContent.includes('Loading')) {
              const response = await fetch('/refresh-items');
              const data = await response.json();
              const items = Object.values(data).filter(item => item && item.item_id && typeof item.item_id === 'string');
              
              itemListContainer.innerHTML = items.map(item => 
                `<label><input type="checkbox" name="items" value="${item.item_id}"> ${item.display_name || item.item_id}</label>`
              ).join('');
            }
          }
        } catch (err) {
          console.error('Error checking verification:', err);
        }
      }, 5000);
    }

    [verificationPopup, subscribePopup].forEach(popup => {
      popup.addEventListener('click', function(e) {
        if (e.target === popup) {
          popup.style.display = 'none';
          if (verificationTimer) {
            clearInterval(verificationTimer);
          }
        }
      });
    });

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('verified') && urlParams.get('email')) {
      currentEmail = urlParams.get('email');
      popupEmail.value = currentEmail;
      subscribePopup.style.display = 'block';
    } else if (urlParams.get('subscribed')) {
      showMessage('Successfully subscribed!', 'success');
    } else if (urlParams.get('unsubscribed')) {
      showMessage('Successfully unsubscribed.', 'success');
    }

    if (itemListContainer.textContent.includes('Loading')) {
      setTimeout(() => {
        fetch('/refresh-items').then(() => window.location.reload());
      }, 3000);
    }
  </script>
</body>
</html>`;

  res.send(html);
});

app.get('/check-verification', (req, res) => {
  const email = req.query.email?.trim();
  res.json({ verified: verifiedEmails.has(email) });
});

app.post('/request-verification', express.json(), (req, res) => {
  const email = req.body.email?.trim();
  if (!email) return res.json({ success: false, message: 'Email is required.' });
  if (subscriptions.has(email)) return res.json({ success: false, message: 'Email is already subscribed.' });
  
  sendVerificationEmail(email);
  res.json({ 
    success: true, 
    message: 'Verification email sent. Please check your inbox.'
  });
});

app.get('/verify', (req, res) => {
  const { email, token } = req.query;
  if (!email || !token) return res.send('Invalid verification link.');

  const verification = pendingVerifications.get(email);
  if (!verification || verification.token !== token) return res.send('Invalid or expired verification link.');

  pendingVerifications.delete(email);
  verifiedEmails.set(email, { verified: true, timestamp: Date.now() });
  res.redirect(`/?verified=true&email=${encodeURIComponent(email)}`);
});

app.post('/subscribe', express.json(), (req, res) => {
  const email = req.body.email?.trim();
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body.items].filter(Boolean);

  if (!email || items.length === 0) return res.json({ success: false, message: 'Invalid input' });
  if (!verifiedEmails.has(email)) return res.json({ success: false, message: 'Email not verified' });

  subscriptions.set(email, new Set(items));
  broadcastLog(`New subscription: ${email} for ${items.length} items`);
  res.json({ success: true, message: 'Subscription successful!' });
});

app.get('/unsub', (req, res) => {
  const email = req.query.email?.trim();
  if (subscriptions.delete(email)) {
    verifiedEmails.delete(email);
    broadcastLog(`Unsubscribed: ${email}`);
    res.redirect('/?unsubscribed=true');
  } else {
    res.send('Email not found in subscriptions.');
  }
});

app.get('/refresh-items', async (req, res) => {
  await fetchItemInfo();
  res.json(itemInfo);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  fetchItemInfo();
});
