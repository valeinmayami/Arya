/**
 * ARYA - GMAIL (IMAP) + SLACK INTEGRATION
 * 
 * Simpler version using IMAP instead of OAuth
 * Works with Gmail app passwords, Outlook, most workplace emails
 */

const https = require('https');
const Imap = require('imap');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

// Configuration
const CONFIG = {
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID,
  GMAIL_EMAIL: process.env.GMAIL_EMAIL, // your email
  GMAIL_PASSWORD: process.env.GMAIL_PASSWORD, // app password
  CHECK_INTERVAL: 60000,
  VALERIA_SIGNATURE: 'Valeria',
};

let imap;
let transporter;
let processedEmails = new Set();
let pendingApprovals = {};

/**
 * INITIALIZE GMAIL IMAP
 */
async function initializeGmail() {
  try {
    if (!CONFIG.GMAIL_EMAIL || !CONFIG.GMAIL_PASSWORD) {
      throw new Error('GMAIL_EMAIL and GMAIL_PASSWORD env vars required');
    }

    imap = new Imap({
      user: CONFIG.GMAIL_EMAIL,
      password: CONFIG.GMAIL_PASSWORD,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
    });

    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: CONFIG.GMAIL_EMAIL,
        pass: CONFIG.GMAIL_PASSWORD,
      },
    });

    console.log('✓ Gmail API initialized (IMAP)');
  } catch (error) {
    console.error('✗ Gmail initialization failed:', error.message);
    throw error;
  }
}

/**
 * CALL CLAUDE API
 */
async function callClaude(messages, systemPrompt = '') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: messages,
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * CALL SLACK API
 */
async function callSlack(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'slack.com',
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
    };

    if (data) {
      const jsonData = JSON.stringify(data);
      options.headers['Content-Length'] = Buffer.byteLength(jsonData);
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          resolve(response);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

/**
 * FETCH UNREAD EMAILS VIA IMAP
 */
async function fetchUnreadEmails() {
  return new Promise((resolve, reject) => {
    const emails = [];

    imap.openBox('INBOX', false, (err, box) => {
      if (err) {
        reject(err);
        return;
      }

      imap.search(['UNSEEN'], (err, results) => {
        if (err) {
          reject(err);
          return;
        }

        if (results.length === 0) {
          resolve([]);
          return;
        }

        const f = imap.fetch(results, { bodies: '' });

        f.on('message', (msg, seqno) => {
          const msgId = `${seqno}-${Date.now()}`;

          if (processedEmails.has(msgId)) return;

          simpleParser(msg, async (err, parsed) => {
            if (err) return;

            const from = parsed.from.text;
            const subject = parsed.subject || '(no subject)';
            const snippet = (parsed.text || '').substring(0, 500);

            emails.push({
              messageId: msgId,
              from: from,
              subject: subject,
              snippet: snippet,
            });

            processedEmails.add(msgId);
          });
        });

        f.on('error', reject);
        f.on('end', () => {
          setTimeout(() => resolve(emails), 1000);
        });
      });
    });
  });
}

/**
 * GENERATE DRAFT IN VALERIA'S VOICE
 */
async function generateDraft(email) {
  const systemPrompt = `You are Arya, Valeria Lasak's email assistant. Draft a professional response in Valeria's voice.

Valeria's style:
- Professional and warm
- Proper grammar and capitalization
- Never uses em dashes
- Conversational but authentic
- Gets straight to the point
- No corporate jargon
- Signs off simply: "Valeria" or "Vale"`;

  const messages = [
    {
      role: 'user',
      content: `Draft a reply to this email:

From: ${email.from}
Subject: ${email.subject}
Message: ${email.snippet}

Write only the response body. Sign off with "Valeria".`,
    },
  ];

  try {
    const response = await callClaude(messages, systemPrompt);
    return response.content[0].text;
  } catch (error) {
    console.error('Error generating draft:', error.message);
    return `Thanks for reaching out. I'll get back to you soon.\n\nValeria`;
  }
}

/**
 * SEND DRAFT TO SLACK FOR APPROVAL
 */
async function sendToSlack(email, draft) {
  const message = `*✉️ New Email - Needs Approval*

*From:* ${email.from}
*Subject:* ${email.subject}

*Original Message:*
\`\`\`${email.snippet}\`\`\`

*Arya's Draft Response:*
\`\`\`${draft}\`\`\`

React to approve: ✅ Send | ✏️ Edit | ❌ Skip`;

  try {
    const response = await callSlack('POST', '/api/chat.postMessage', {
      channel: CONFIG.SLACK_CHANNEL_ID,
      text: message,
    });

    if (response.ok) {
      return {
        message_ts: response.ts,
        channel_id: response.channel,
      };
    } else {
      console.error('Slack error:', response.error);
      return null;
    }
  } catch (error) {
    console.error('Error sending to Slack:', error.message);
    return null;
  }
}

/**
 * CHECK FOR REACTIONS ON SLACK MESSAGE
 */
async function checkReactions(channelId, messageTs) {
  try {
    const response = await callSlack('GET', `/api/reactions.get?channel=${channelId}&timestamp=${messageTs}`);

    if (response.ok && response.message.reactions) {
      const reactions = response.message.reactions;

      if (reactions.some(r => r.name === 'white_check_mark' || r.name === 'heavy_check_mark' || r.name === 'yes')) {
        return 'approved';
      }
      if (reactions.some(r => r.name === 'pencil2' || r.name === 'memo' || r.name === 'edit')) {
        return 'edit';
      }
      if (reactions.some(r => r.name === 'x' || r.name === 'no_entry' || r.name === 'stop')) {
        return 'skip';
      }
    }
    return null;
  } catch (error) {
    console.error('Error checking reactions:', error.message);
    return null;
  }
}

/**
 * SEND EMAIL VIA NODEMAILER
 */
async function sendEmailReply(email, body) {
  try {
    await transporter.sendMail({
      from: CONFIG.GMAIL_EMAIL,
      to: email.from,
      subject: `Re: ${email.subject}`,
      text: body,
    });

    console.log(`✓ Email sent to ${email.from}`);
    return true;
  } catch (error) {
    console.error(`✗ Error sending email: ${error.message}`);
    return false;
  }
}

/**
 * MAIN LOOP
 */
async function aryaLoop() {
  console.log('\n--- Arya checking inbox ---');

  try {
    const emails = await fetchUnreadEmails();

    if (emails.length === 0) {
      console.log('No new unread emails');
    } else {
      console.log(`Found ${emails.length} unread email(s)`);
    }

    for (const email of emails) {
      console.log(`\nProcessing: ${email.from} - "${email.subject}"`);

      console.log('  → Generating draft...');
      const draft = await generateDraft(email);

      console.log('  → Sending to Slack...');
      const slackMsg = await sendToSlack(email, draft);

      if (!slackMsg) {
        console.log('  ✗ Failed to send to Slack');
        continue;
      }

      console.log('  ✓ Posted to Slack, waiting for reaction...');

      pendingApprovals[slackMsg.message_ts] = {
        email,
        draft,
        channelId: slackMsg.channel_id,
        sentAt: Date.now(),
      };
    }

    const messageIds = Object.keys(pendingApprovals);
    for (const messageTs of messageIds) {
      const pending = pendingApprovals[messageTs];
      const reaction = await checkReactions(pending.channelId, messageTs);

      if (reaction === 'approved') {
        console.log(`\n✓ Approved: ${pending.email.subject}`);
        console.log('  → Sending email...');
        await sendEmailReply(pending.email, pending.draft);
        delete pendingApprovals[messageTs];
      } else if (reaction === 'skip') {
        console.log(`\n❌ Skipped: ${pending.email.subject}`);
        delete pendingApprovals[messageTs];
      }

      if (Date.now() - pending.sentAt > 30 * 60 * 1000) {
        console.log(`⏱️ Timeout: ${pending.email.subject}`);
        delete pendingApprovals[messageTs];
      }
    }

  } catch (error) {
    console.error('Error in Arya loop:', error);
  }

  setTimeout(aryaLoop, CONFIG.CHECK_INTERVAL);
}

/**
 * STARTUP
 */
async function start() {
  console.log('🤖 Starting Arya...');

  if (!CONFIG.CLAUDE_API_KEY) {
    console.error('✗ CLAUDE_API_KEY not set');
    process.exit(1);
  }

  if (!CONFIG.SLACK_BOT_TOKEN) {
    console.error('✗ SLACK_BOT_TOKEN not set');
    process.exit(1);
  }

  if (!CONFIG.SLACK_CHANNEL_ID) {
    console.error('✗ SLACK_CHANNEL_ID not set');
    process.exit(1);
  }

  try {
    await initializeGmail();
    console.log('✓ All systems initialized');
    console.log(`✓ Monitoring Slack channel: ${CONFIG.SLACK_CHANNEL_ID}`);
    console.log(`✓ Check interval: ${CONFIG.CHECK_INTERVAL / 1000}s`);
    console.log('\nArya is now running 24/7...\n');

    imap.openBox('INBOX', false, () => {
      aryaLoop();
    });

    imap.on('error', (err) => {
      console.error('IMAP error:', err);
    });

    imap.on('end', () => {
      console.log('IMAP connection ended');
      setTimeout(start, 5000);
    });

    imap.openBox('INBOX', false, () => {
      console.log('Connected to IMAP');
    });

  } catch (error) {
    console.error('✗ Failed to start Arya:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Arya shutting down...');
  imap.closeBox(() => {
    imap.openBox('INBOX', false, () => {
      imap.end();
    });
  });
  process.exit(0);
});

start();
