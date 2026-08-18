/**
 * ARYA - COMPLETE GMAIL + SLACK INTEGRATION
 * 
 * Full automation:
 * 1. Fetch unread Gmail emails
 * 2. Draft responses in Valeria's voice using Claude
 * 3. Post drafts to Slack for approval
 * 4. Wait for reactions (✅ approve, ✏️ edit, ❌ skip)
 * 5. Send approved emails via Gmail
 * 6. Repeat
 * 
 * Deploy on: Vercel, Railway, or any Node.js server
 */

const https = require('https');
const { google } = require('googleapis');
const fs = require('fs');

// Configuration
const CONFIG = {
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID,
  GMAIL_CREDENTIALS: process.env.GMAIL_CREDENTIALS || '{}', // JSON string of Google credentials
  GMAIL_REDIRECT_URI: 'http://localhost:3000/oauth2callback',
  CHECK_INTERVAL: 60000, // Check every 60 seconds
  VALERIA_SIGNATURE: 'Valeria',
};

let gmail;
let oAuth2Client;
let processedEmails = new Set();
let pendingApprovals = {}; // Track emails waiting for approval

/**
 * INITIALIZE GMAIL API
 */
async function initializeGmail() {
  try {
    const credentials = JSON.parse(CONFIG.GMAIL_CREDENTIALS);
    
    oAuth2Client = new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      CONFIG.GMAIL_REDIRECT_URI
    );

    oAuth2Client.setCredentials({
      refresh_token: credentials.refresh_token,
    });

    gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    console.log('✓ Gmail API initialized');
  } catch (error) {
    console.error('✗ Gmail initialization failed:', error.message);
    console.error('Make sure GMAIL_CREDENTIALS env var is set with Google OAuth credentials');
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
 * FETCH UNREAD EMAILS FROM GMAIL
 */
async function fetchUnreadEmails() {
  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 5, // Process up to 5 at a time
    });

    if (!response.data.messages) {
      return [];
    }

    const emails = [];
    for (const message of response.data.messages) {
      if (processedEmails.has(message.id)) continue;

      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full',
      });

      const headers = msg.data.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      
      let snippet = '';
      if (msg.data.payload.parts) {
        const textPart = msg.data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart && textPart.body.data) {
          snippet = Buffer.from(textPart.body.data, 'base64').toString();
        }
      } else if (msg.data.payload.body?.data) {
        snippet = Buffer.from(msg.data.payload.body.data, 'base64').toString();
      }

      snippet = snippet.substring(0, 500); // First 500 chars

      emails.push({
        messageId: message.id,
        threadId: msg.data.threadId,
        from: from.replace(/.*<(.+)>/, '$1').trim(), // Extract email
        fromName: from.replace(/<.*/, '').trim(),
        subject: subject,
        snippet: snippet,
      });

      processedEmails.add(message.id);
    }

    return emails;
  } catch (error) {
    console.error('Error fetching emails:', error.message);
    return [];
  }
}

/**
 * GENERATE DRAFT IN VALERIA'S VOICE
 */
async function generateDraft(email) {
  const systemPrompt = `You are Arya, Valeria Lasak's email assistant. You draft professional responses in Valeria's exact voice.

Valeria's style:
- Professional and warm
- Proper grammar and capitalization (not lowercase)
- Never uses em dashes
- Conversational but authentic
- Gets straight to the point
- No corporate jargon, no AI-speak
- No fake-profound framing
- Signs off simply: "Valeria" or "Vale"

Keep responses concise (2-3 sentences for casual, longer if needed). Be genuine.`;

  const messages = [
    {
      role: 'user',
      content: `Draft a reply to this email in Valeria's voice:

From: ${email.fromName || email.from}
Subject: ${email.subject}

Message:
${email.snippet}

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

*From:* ${email.fromName || email.from}
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

      // Check for specific reactions
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
 * SEND EMAIL VIA GMAIL
 */
async function sendEmailReply(email, body) {
  try {
    const raw = Buffer.from(
      `To: ${email.from}\r\nSubject: Re: ${email.subject}\r\n\r\n${body}`
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: raw,
      },
    });

    console.log(`✓ Email sent to ${email.from}`);
    return true;
  } catch (error) {
    console.error(`✗ Error sending email: ${error.message}`);
    return false;
  }
}

/**
 * MAIN LOOP - ORCHESTRATE EVERYTHING
 */
async function aryaLoop() {
  console.log('\n--- Arya checking inbox ---');

  try {
    // STEP 1: Fetch unread emails
    const emails = await fetchUnreadEmails();

    if (emails.length === 0) {
      console.log('No new unread emails');
    } else {
      console.log(`Found ${emails.length} unread email(s)`);
    }

    // STEP 2: Process each email
    for (const email of emails) {
      console.log(`\nProcessing: ${email.from} - "${email.subject}"`);

      // Generate draft
      console.log('  → Generating draft...');
      const draft = await generateDraft(email);

      // Send to Slack
      console.log('  → Sending to Slack...');
      const slackMsg = await sendToSlack(email, draft);
      
      if (!slackMsg) {
        console.log('  ✗ Failed to send to Slack');
        continue;
      }

      console.log('  ✓ Posted to Slack, waiting for reaction...');

      // Store pending approval
      pendingApprovals[slackMsg.message_ts] = {
        email,
        draft,
        channelId: slackMsg.channel_id,
        sentAt: Date.now(),
      };
    }

    // STEP 3: Check for reactions on pending approvals
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
      } else if (reaction === 'edit') {
        console.log(`\n✏️ Edit requested: ${pending.email.subject}`);
        // TODO: Read edited version from Slack thread and send
      }

      // Timeout after 30 minutes (remove from pending)
      if (Date.now() - pending.sentAt > 30 * 60 * 1000) {
        console.log(`⏱️ Timeout: ${pending.email.subject}`);
        delete pendingApprovals[messageTs];
      }
    }

  } catch (error) {
    console.error('Error in Arya loop:', error);
  }

  // Loop again after interval
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
    
    aryaLoop();
  } catch (error) {
    console.error('✗ Failed to start Arya:', error.message);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Arya shutting down...');
  process.exit(0);
});

// Start
start();
